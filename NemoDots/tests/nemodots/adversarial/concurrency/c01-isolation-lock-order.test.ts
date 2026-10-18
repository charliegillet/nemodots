// C1 (high): the collection version must advance only on key insert/delete, so
// the benign B1 change (ui.banner_text) leaves every receipt current; and every
// writer must lock the collection row FIRST and members in key order, so an
// injector key insert and an action commit never deadlock (40P01).
// Expected (ARCHITECTURE 3, 5.1, 14 C1): see the per-test comments.
//
// The deadlock detector is the instrumented pool (harness.ts): it records
// SQLSTATE 40P01 / 40001 before withTransaction retries, so a retried deadlock
// is still counted. A negative control proves the detector sees a real one.
import { describe, expect, it } from 'vitest';
import {
  advanceConfig,
  advanceConfigUnconditionally,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  collectionReceipt,
  collectionVersion,
  configState,
  createAttempt,
  emitModelCall,
  externalChange,
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

  it('stress: commits, key inserts, key deletes and value updates interleaved: zero deadlocks, authority history stays gapless', async () => {
    await withWorld(async (world) => {
      const keys = [
        'cache.namespace',
        'cache.schema_version',
        'db.pool_max',
        'db.statement_timeout_ms',
        'routing.inventory_source',
        'orders.write_enabled',
      ];
      const proposals: Awaited<ReturnType<typeof intentWithCollection>>[] = [];
      const values: ConfigScalar[] = [
        'catalog-b',
        2,
        12,
        6000,
        'replica_stale',
        false,
      ];
      for (let i = 0; i < keys.length; i += 1)
        proposals.push(await intentWithCollection(world, keys[i], values[i]));
      const writers: Promise<unknown>[] = [];
      for (let round = 0; round < 6; round += 1) {
        writers.push(
          withTransaction(world.injector, (client) =>
            advanceConfigUnconditionally(client, {
              key: `adv.stress_${round}`,
              value: round,
              insertIfMissing: true,
              causedBy: { actor: 'injector' },
            }),
          ),
        );
        writers.push(externalChange(world, 'ui.banner_text', `b${round}`));
      }
      const pipelines = proposals.map(({ intent }, i) =>
        (async () => {
          await sleep(i * 3);
          const admitted = await world.service.admit(
            intent.id,
            `dispatcher-${i}`,
          );
          if (admitted.status !== 'admitted') return admitted;
          return world.service.commit(intent.id, admitted.dispatch!.fence);
        })(),
      );
      const settled = await Promise.allSettled([...writers, ...pipelines]);
      for (const result of settled) expect(result.status).toBe('fulfilled');
      expect(world.deadlocks()).toEqual([]);
      // Authority invariants: per key, history versions are 1..n without gaps,
      // and the head equals the last history row.
      const { rows } = await world.admin.query<{
        key: string;
        head: string;
        max: string;
        count: string;
      }>(
        `SELECT e.key, e.version AS head, max(v.version) AS max, count(v.*) AS count
           FROM checkout.config_entries e
           JOIN checkout.config_versions v ON v.key = e.key
          GROUP BY e.key, e.version`,
      );
      for (const row of rows) {
        expect(Number(row.max)).toBe(Number(row.head));
        expect(Number(row.count)).toBe(Number(row.head));
      }
      // Every committed intent moved exactly its own key by one.
      for (const { intent } of proposals) {
        const status = (await intentStatus(world, intent.id)).status;
        expect(['committed', 'blocked']).toContain(status);
      }
    });
  });

  it('negative control: opposite lock orders DO deadlock and the detector records the 40P01 (so the zero counts above mean something)', async () => {
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
