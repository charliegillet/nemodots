// C1 (high): the collection version must advance only on key insert/delete, so
// the benign B1 change (ui.banner_text) leaves every receipt current; and every
// writer must lock the collection row FIRST and members in key order, so an
// injector key insert/delete and an action commit never deadlock (40P01).
// Expected (ARCHITECTURE 3, 5.1, 14 C1): see the per-test comments.
//
// The deadlock detector is the instrumented pool (harness.ts): it records
// SQLSTATE 40P01 / 40001 before withTransaction retries, so a retried deadlock
// is still counted.
//
// What discriminates a reversed lock order: a raw session pre-locks ONE row so
// that a commit and an injector delete both queue on it, in a chosen order,
// each already holding the other row. With collection-first writers both
// complete ("member pre-locked", "collection pre-locked"). The same shapes
// with a writer that takes the member BEFORE the collection (a raw session
// standing in for a reversed commit) deadlock and the detector records the
// 40P01 (negative controls A and B), so a reversed order in production would
// turn those tests red. The randomized stress is non-vacuous: its intents are
// admitted BEFORE the writers start, the pipelines no writer can invalidate
// must commit, and in "parked" mode one commit holding the collection and a
// member lock is parked while every writer queues behind it.
import { describe, expect, it } from 'vitest';
import {
  advanceConfig,
  advanceConfigUnconditionally,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  actionHistory,
  collectionReceipt,
  collectionVersion,
  configState,
  createAttempt,
  emitModelCall,
  externalChange,
  historyRows,
  intentStatus,
  memberReceipt,
  observed,
  park,
  proposeCtx,
  setConfigInput,
  sleep,
  waitForLockWaiters,
  withWorld,
  type ConfigScalar,
  type World,
} from './harness.js';

/** An intent on `key` whose emitting snapshot also carries the collection receipt. */
async function intentWithCollection(
  world: World,
  key: string,
  value: ConfigScalar,
) {
  const attempt = await createAttempt(world);
  const member = await memberReceipt(world, key);
  const collection = await collectionReceipt(world);
  const health = await observed(world, 'checkout.health');
  const call = await emitModelCall(world, attempt, [
    member,
    collection,
    health,
  ]);
  const state = await configState(world, key);
  const intent = await world.service.propose(
    setConfigInput(value, state.value as ConfigScalar, { key }),
    proposeCtx({ attempt, ...call }),
  );
  return { intent, collection, member };
}

/** An intent whose emitting snapshot carries the member, the health and (optionally) the collection. */
async function intentWithVector(
  world: World,
  key: string,
  value: ConfigScalar,
  options: { collection: boolean },
) {
  const attempt = await createAttempt(world);
  const member = await memberReceipt(world, key);
  const extra = options.collection ? [await collectionReceipt(world)] : [];
  const health = await observed(world, 'checkout.health');
  const call = await emitModelCall(world, attempt, [member, ...extra, health]);
  const state = await configState(world, key);
  return world.service.propose(
    setConfigInput(value, state.value as ConfigScalar, { key }),
    proposeCtx({ attempt, ...call }),
  );
}

const MEMBER_LOCK =
  "SELECT 1 FROM checkout.config_entries WHERE key = 'db.pool_max' FOR UPDATE";
const COLLECTION_LOCK =
  'SELECT 1 FROM checkout.config_collection WHERE singleton FOR UPDATE';

/** A raw injector session that holds one row lock until released. */
async function holdLock(world: World, lockSql: string) {
  const client = await world.injector.connect();
  await client.query('BEGIN');
  await client.query(lockSql);
  return {
    async release() {
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

const insertKey = (world: World, key: string, value: ConfigScalar) =>
  withTransaction(world.injector, (client) =>
    advanceConfigUnconditionally(client, {
      key,
      value,
      insertIfMissing: true,
      causedBy: { actor: 'injector' },
    }),
  );

const deleteKey = (world: World, key: string) =>
  withTransaction(world.injector, (client) =>
    advanceConfigUnconditionally(client, {
      key,
      deleteKey: true,
      causedBy: { actor: 'injector' },
    }),
  );

/**
 * A writer with the REVERSED order (member row, then collection row), as a raw
 * session. It stands in for a commit that locked members before the
 * collection; resolves to 'ok' or the SQLSTATE that killed it.
 */
async function reversedWriter(world: World): Promise<string> {
  const client = await world.injector.connect();
  try {
    await client.query('BEGIN');
    await client.query(MEMBER_LOCK);
    await client.query(COLLECTION_LOCK);
    await client.query('COMMIT');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return (error as { code?: string }).code ?? 'error';
  } finally {
    client.release();
  }
}

const settleCode = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string; name?: string }) => ({
      ok: false as const,
      code: error.code ?? error.name ?? 'error',
    }),
  );

/** Per key: history is 1..n without gaps; the head equals the last row; a deleted key ends in a NULL value. */
async function expectGaplessAuthority(world: World) {
  const history = await world.admin.query<{
    key: string;
    version: string;
    value: unknown;
  }>(
    'SELECT key, version, value FROM checkout.config_versions ORDER BY key, version',
  );
  const heads = new Map(
    (
      await world.admin.query<{ key: string; version: string }>(
        'SELECT key, version FROM checkout.config_entries',
      )
    ).rows.map((row) => [row.key, Number(row.version)]),
  );
  const byKey = new Map<string, { version: number; value: unknown }[]>();
  for (const row of history.rows)
    byKey.set(row.key, [
      ...(byKey.get(row.key) ?? []),
      { version: Number(row.version), value: row.value },
    ]);
  for (const [key, rows] of byKey) {
    rows.forEach((row, i) => expect(row.version, key).toBe(i + 1));
    const head = heads.get(key);
    if (head !== undefined) expect(head, key).toBe(rows.length);
    else expect(rows.at(-1)!.value, `${key} deleted`).toBeNull();
  }
}

describe('C1 benign change isolation (B1)', () => {
  it('a value update of an unrelated key leaves the collection version and every receipt current; the repair still commits', async () => {
    await withWorld(async (world) => {
      const { intent, collection } = await intentWithCollection(
        world,
        'db.pool_max',
        20,
      );
      expect(intent.status).toBe('proposed');
      expect(intent.dependencyVector.map((e) => e.sourceKey)).toContain(
        'checkout.config',
      );
      const collectionBefore = await collectionVersion(world);
      // B1: the benign unrelated change.
      await externalChange(world, 'ui.banner_text', 'maintenance tonight');
      expect(await collectionVersion(world)).toBe(collectionBefore);

      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const committed = await world.service.commit(
        intent.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).value).toBe(20);
      expect(collection.sourceRevision).toBe(collectionBefore);
    });
  });

  it('control: inserting a key IS a membership change and does invalidate a vector that holds the collection receipt', async () => {
    await withWorld(async (world) => {
      const { intent } = await intentWithCollection(world, 'db.pool_max', 20);
      const before = await collectionVersion(world);
      await withTransaction(world.injector, (client) =>
        advanceConfigUnconditionally(client, {
          key: 'adv.extra_key',
          value: 'x',
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        }),
      );
      expect(await collectionVersion(world)).toBe(before + 1);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('blocked');
      expect(['stale_version', 'stale_pending_observation']).toContain(
        admitted.blockReason,
      );
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
    });
  });
});

describe('C1 collection-first lock order', () => {
  it('an injector key insert queued behind a commit that holds the collection row waits, then proceeds: no 40P01, both complete', async () => {
    await withWorld(async (world) => {
      const { intent } = await intentWithCollection(world, 'db.pool_max', 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      const parked = park('after_lock_before_commit');
      const commit = world.service.commit(intent.id, admitted.dispatch!.fence);
      await parked.arrived;
      // The commit holds: intent, mission share, collection FOR UPDATE, db.pool_max.
      const collectionBefore = await collectionVersion(world);
      const insert = withTransaction(world.injector, (client) =>
        advanceConfigUnconditionally(client, {
          key: 'adv.inserted',
          value: 1,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        }),
      );
      await waitForLockWaiters(world, 1);
      // The insert must not have got ahead of the commit.
      expect(await collectionVersion(world)).toBe(collectionBefore);
      parked.release();
      const [committed, inserted] = await Promise.all([commit, insert]);
      expect(committed.status).toBe('committed');
      expect(inserted.operation).toBe('insert');
      expect(await collectionVersion(world)).toBe(collectionBefore + 1);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('a commit queued behind an injector insert (holding the collection row) waits and then fails closed on the membership change: no 40P01', async () => {
    await withWorld(async (world) => {
      const { intent } = await intentWithCollection(world, 'db.pool_max', 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      const client = await world.injector.connect();
      try {
        await client.query('BEGIN');
        await advanceConfig(client, {
          key: 'adv.inserted',
          value: 1,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        const commit = world.service.commit(
          intent.id,
          admitted.dispatch!.fence,
        );
        await waitForLockWaiters(world, 1);
        await client.query('COMMIT');
        const result = await commit;
        expect(result.status).toBe('blocked');
        expect(['stale_version', 'stale_pending_observation']).toContain(
          result.blockReason,
        );
      } finally {
        client.release();
      }
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('member pre-locked: a commit and an injector delete of the same key queue behind it (commit first, then the delete); both complete, zero 40P01', async () => {
    await withWorld(async (world) => {
      const intent = await intentWithVector(world, 'db.pool_max', 20, {
        collection: true,
      });
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const held = await holdLock(world, MEMBER_LOCK);
      // The commit takes intent, mission share and the collection row, then
      // queues on the member row.
      const commit = settleCode(
        world.service.commit(intent.id, admitted.dispatch!.fence),
      );
      await waitForLockWaiters(world, 1);
      // The delete takes the collection row FIRST, so it queues on it behind
      // the commit (a delete that took the member first would deadlock here).
      const removal = settleCode(deleteKey(world, 'db.pool_max'));
      await waitForLockWaiters(world, 2);
      await held.release();
      const [committed, deleted] = await Promise.all([commit, removal]);
      expect(committed).toMatchObject({
        ok: true,
        value: { status: 'committed' },
      });
      expect(deleted).toMatchObject({
        ok: true,
        value: { operation: 'delete' },
      });
      expect(
        (await historyRows(world, 'db.pool_max')).map((r) => [
          r.version,
          r.caused_by_action_id === intent.id ? 'action' : r.caused_by_actor,
          r.value === null ? null : 'value',
        ]),
      ).toEqual([
        [1, 'seed', 'value'],
        [2, 'action', 'value'],
        [3, 'injector', null],
      ]);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('collection pre-locked: an injector delete queues first, the commit second; the delete lands, the commit fails closed (blocked), zero 40P01', async () => {
    await withWorld(async (world) => {
      const intent = await intentWithVector(world, 'db.pool_max', 20, {
        collection: true,
      });
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const held = await holdLock(world, COLLECTION_LOCK);
      const removal = settleCode(deleteKey(world, 'db.pool_max'));
      await waitForLockWaiters(world, 1);
      const commit = settleCode(
        world.service.commit(intent.id, admitted.dispatch!.fence),
      );
      await waitForLockWaiters(world, 2);
      await held.release();
      const [committed, deleted] = await Promise.all([commit, removal]);
      expect(deleted).toMatchObject({
        ok: true,
        value: { operation: 'delete' },
      });
      expect(committed).toMatchObject({
        ok: true,
        value: { status: 'blocked' },
      });
      expect(await actionHistory(world, intent.id)).toHaveLength(0);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('negative control A: the "member pre-locked" shape with a REVERSED writer (member before collection) deadlocks, and the detector records the 40P01', async () => {
    await withWorld(async (world) => {
      const held = await holdLock(world, MEMBER_LOCK);
      // Stand-in for a reversed commit: queues on the member row.
      const reversed = reversedWriter(world);
      await waitForLockWaiters(world, 1);
      // Collection-first delete: holds the collection row, queues on the member.
      const removal = settleCode(deleteKey(world, 'db.pool_max'));
      await waitForLockWaiters(world, 2);
      await held.release();
      await Promise.all([reversed, removal]);
      expect(world.deadlocks().length).toBeGreaterThanOrEqual(1);
    });
  });

  it('negative control B: the "collection pre-locked" shape with a REVERSED writer deadlocks, and the detector records the 40P01', async () => {
    await withWorld(async (world) => {
      const held = await holdLock(world, COLLECTION_LOCK);
      const removal = settleCode(deleteKey(world, 'db.pool_max'));
      await waitForLockWaiters(world, 1);
      // Takes the member row at once, then queues on the collection row.
      const reversed = reversedWriter(world);
      await waitForLockWaiters(world, 2);
      await held.release();
      await Promise.all([reversed, removal]);
      expect(world.deadlocks().length).toBeGreaterThanOrEqual(1);
    });
  });

  // Non-vacuous stress. Five pipelines, admitted BEFORE any writer starts:
  //   P (vector holds the collection): cache.schema_version, db.pool_max,
  //     routing.inventory_source: a membership change before their commit
  //     legitimately blocks them;
  //   Q (member + health only): db.statement_timeout_ms, orders.write_enabled:
  //     nothing the writers do touches their rows, so they MUST commit.
  // Writers: four key inserts, an insert followed by a delete, a delete of a P
  // member, a value update of another P member, and the benign ui.banner_text.
  // "parked": the first P commit is parked after its last write with the
  // collection row and its member held, while every writer and commit queues;
  // it is released once they all wait. "free": staggered start, no barrier.
  describe.each(['parked', 'free-a', 'free-b'] as const)(
    'stress (%s): commits, key inserts, key deletes and value updates interleaved',
    (mode) => {
      it('zero deadlocks; Q commits; every outcome consistent; authority history gapless', async () => {
        await withWorld(async (world) => {
          const pipelines: {
            key: string;
            value: ConfigScalar;
            collection: boolean;
          }[] = [
            { key: 'cache.schema_version', value: 2, collection: true },
            { key: 'db.pool_max', value: 12, collection: true },
            {
              key: 'routing.inventory_source',
              value: 'replica_stale',
              collection: true,
            },
            { key: 'db.statement_timeout_ms', value: 6000, collection: false },
            { key: 'orders.write_enabled', value: false, collection: false },
          ];
          const intents = [];
          const fences: number[] = [];
          for (const [i, pipeline] of pipelines.entries()) {
            const intent = await intentWithVector(
              world,
              pipeline.key,
              pipeline.value,
              { collection: pipeline.collection },
            );
            const admitted = await world.service.admit(
              intent.id,
              `dispatcher-${i}`,
            );
            expect(admitted.status, pipeline.key).toBe('admitted');
            intents.push(intent);
            fences.push(admitted.dispatch!.fence);
          }
          const commitOf = (i: number) =>
            world.service.commit(intents[i].id, fences[i]);

          const parked =
            mode === 'parked' ? park('after_lock_before_commit') : null;
          const work: Promise<unknown>[] = [];
          if (parked) {
            work.push(commitOf(0));
            await parked.arrived; // P0 holds intent, mission share, collection, member
          }
          const stagger = (n: number) =>
            mode === 'free-b'
              ? sleep((n * 3) % 7)
              : mode === 'free-a'
                ? sleep(n % 4)
                : Promise.resolve();
          const deleted: Promise<{ operation: string }>[] = [];
          for (let round = 0; round < 4; round += 1)
            work.push(
              (async () => {
                await stagger(round);
                return insertKey(world, `adv.stress_${round}`, round);
              })(),
            );
          work.push(
            (async () => {
              await stagger(5);
              await insertKey(world, 'adv.tmp', 1);
              return deleteKey(world, 'adv.tmp');
            })(),
          );
          const removal = (async () => {
            await stagger(6);
            return deleteKey(world, 'routing.inventory_source');
          })();
          deleted.push(removal);
          work.push(removal);
          work.push(
            (async () => {
              await stagger(7);
              return externalChange(world, 'cache.schema_version', 99);
            })(),
          );
          work.push(externalChange(world, 'ui.banner_text', 'b1'));
          for (let i = parked ? 1 : 0; i < intents.length; i += 1)
            work.push(
              (async () => {
                await stagger(i + 1);
                return commitOf(i);
              })(),
            );
          if (parked) {
            await waitForLockWaiters(world, 3);
            parked.release();
          }
          const settled = await Promise.allSettled(work);
          expect(
            settled
              .filter((r) => r.status === 'rejected')
              .map((r) => String((r as PromiseRejectedResult).reason)),
          ).toEqual([]);
          expect(world.deadlocks()).toEqual([]);
          expect((await deleted[0]).operation).toBe('delete');
          await expectGaplessAuthority(world);

          let committed = 0;
          for (const [i, pipeline] of pipelines.entries()) {
            const status = await intentStatus(world, intents[i].id);
            const wrote = await actionHistory(world, intents[i].id);
            if (!pipeline.collection)
              expect(
                status.status,
                `${pipeline.key} cannot be invalidated`,
              ).toBe('committed');
            if (status.status === 'committed') {
              committed += 1;
              // Moved exactly its own key, exactly one version, exactly once.
              expect(wrote).toHaveLength(1);
              expect(wrote[0].key).toBe(pipeline.key);
              expect(wrote[0].version).toBe(
                intents[i].expectedTargetVersion + 1,
              );
            } else {
              expect(status.status).toBe('blocked');
              expect(['stale_version', 'stale_pending_observation']).toContain(
                status.blockReason,
              );
              expect(wrote).toHaveLength(0);
            }
          }
          // Lower bounds so a run in which nothing commits cannot pass.
          expect(committed).toBeGreaterThanOrEqual(mode === 'parked' ? 3 : 2);
          if (mode === 'parked')
            expect((await intentStatus(world, intents[0].id)).status).toBe(
              'committed',
            );
        });
      });
    },
  );

  it('negative control C: opposite lock orders on two raw sessions DO deadlock and the detector records the 40P01 (the detector itself is live)', async () => {
    await withWorld(async (world) => {
      const one = await world.injector.connect();
      const two = await world.injector.connect();
      try {
        await one.query('BEGIN');
        await two.query('BEGIN');
        await one.query(
          "SELECT 1 FROM checkout.config_entries WHERE key = 'db.pool_max' FOR UPDATE",
        );
        await two.query(
          'SELECT 1 FROM checkout.config_collection WHERE singleton FOR UPDATE',
        );
        const a = one
          .query(
            'SELECT 1 FROM checkout.config_collection WHERE singleton FOR UPDATE',
          )
          .then(
            () => 'ok' as const,
            (e: { code?: string }) => e.code ?? 'err',
          );
        await waitForLockWaiters(world, 1);
        const b = two
          .query(
            "SELECT 1 FROM checkout.config_entries WHERE key = 'db.pool_max' FOR UPDATE",
          )
          .then(
            () => 'ok' as const,
            (e: { code?: string }) => e.code ?? 'err',
          );
        const outcomes = await Promise.all([a, b]);
        expect(outcomes).toContain('40P01');
        await one.query('ROLLBACK').catch(() => {});
        await two.query('ROLLBACK').catch(() => {});
      } finally {
        one.release();
        two.release();
      }
      expect(world.deadlocks().length).toBeGreaterThanOrEqual(1);
    });
  });
});
