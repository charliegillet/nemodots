// SupportValidator.assertCurrent against real PostgreSQL: receipt status,
// controlled-version currency (G3), freshness from confirmations (I2),
// membership-only collections (C1/D1), negative predicates, and the locks that
// serialize publications and commits against writers (C9).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReceiptId } from '../../../../src/server/nemodots/contracts/index.js';
import { CheckedVectorSchema } from '../../../../src/server/nemodots/contracts/index.js';
import {
  SupportError,
  assertCurrent,
  createSupportValidator,
  registerObservation,
  transitionReceipt,
  type RegisterObservationInput,
} from '../../../../src/server/nemodots/ledger/index.js';
import { barrier, withTimeout } from '../../helpers/barrier.js';
import {
  FX,
  backendPid,
  collectionState,
  deleteConfig,
  inTx,
  insertConfig,
  newScope,
  readMember,
  resetAuthority,
  seedConfig,
  sourceRef,
  updateConfig,
  useLedgerDb,
  waitsOnLock,
} from './fixtures.js';

const getDb = useLedgerDb();
const opts = { ledger: FX, marker: null } as const;
const HEALTH_OK = { status: 'ok' };
const HEALTH_BAD = { status: 'degraded' };

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

type Scope = ReturnType<typeof newScope>;

const observe = (
  scope: Scope,
  key: string,
  value: unknown,
  extra: Partial<RegisterObservationInput> = {},
) =>
  inTx(getDb().app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(scope, key),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
        ...extra,
      },
      opts,
    ),
  );

const observeMember = (scope: Scope, key: string) =>
  inTx(getDb().app, async (client) => {
    const read = await readMember(client, key);
    return registerObservation(
      client,
      {
        source: sourceRef(scope, `checkout.config/${key}`),
        normalizedValue: read.normalizedValue,
        provenance: { kind: 'watcher' },
        claimed: { sourceRevision: read.version },
      },
      opts,
    );
  });

const observeCollection = (scope: Scope, negative?: { predicate: string }) =>
  inTx(getDb().app, async (client) => {
    const state = await collectionState(client);
    return registerObservation(
      client,
      {
        source: sourceRef(scope, 'checkout.config'),
        normalizedValue: state,
        provenance: { kind: 'watcher' },
        ...(negative
          ? {
              negative: {
                predicate: negative.predicate,
                collectionRevision: state.collectionVersion,
              },
            }
          : {}),
      },
      opts,
    );
  });

const check = (
  ids: string[],
  lockMode: 'share' | 'update',
  freshness?: Record<string, number>,
) =>
  inTx(getDb().app, (client) =>
    assertCurrent(client, ids as ReceiptId[], { lockMode, freshness }, FX),
  );

async function rejection(promise: Promise<unknown>): Promise<SupportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupportError);
    return error as SupportError;
  }
  throw new Error('expected assertCurrent to reject');
}

describe('receipt status', () => {
  it('current receipts pass and return the checked vector', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const member = await observeMember(scope, 'db.pool_max');
    const health = await observe(scope, 'checkout.health', HEALTH_OK);
    for (const lockMode of ['share', 'update'] as const) {
      const vector = await check(
        [member.receipt.id, health.receipt.id],
        lockMode,
      );
      expect(CheckedVectorSchema.safeParse(vector).success).toBe(true);
      expect(vector).toEqual([
        expect.objectContaining({
          sourceKey: 'checkout.config/db.pool_max',
          recordedRevision: 1,
          liveRevision: 1,
          receiptStatus: 'supported',
          freshnessOk: true,
        }),
        expect.objectContaining({
          sourceKey: 'checkout.health',
          recordedRevision: 1,
          liveRevision: 1,
          receiptStatus: 'supported',
          freshnessOk: true,
        }),
      ]);
    }
    expect(await check([], 'share')).toEqual([]);
  });

  it('contested, retracted and expired receipts do not support; resolving a contest restores support', async () => {
    const scope = newScope();
    const health = await observe(scope, 'checkout.health', HEALTH_OK);
    const metrics = await observe(scope, 'checkout.metrics', HEALTH_OK);
    const redis = await observe(scope, 'redis.stats', HEALTH_OK);
    const transition = (
      id: string,
      to: 'contested' | 'retracted' | 'expired',
      reason: 'conflicting_observation' | 'owner_retraction' | 'ttl_elapsed',
    ) =>
      inTx(getDb().app, (client) =>
        transitionReceipt(client, { receiptId: id, to, reason }, opts),
      );
    await transition(health.receipt.id, 'contested', 'conflicting_observation');
    await transition(metrics.receipt.id, 'retracted', 'owner_retraction');
    await transition(redis.receipt.id, 'expired', 'ttl_elapsed');
    for (const [receipt, status] of [
      [health, 'contested'],
      [metrics, 'retracted'],
      [redis, 'expired'],
    ] as const) {
      for (const lockMode of ['share', 'update'] as const) {
        const error = await rejection(check([receipt.receipt.id], lockMode));
        expect(error.reason).toBe('receipt_not_supported');
        expect(error.checkedVector[0].receiptStatus).toBe(status);
      }
    }
    await inTx(getDb().app, (client) =>
      transitionReceipt(
        client,
        { receiptId: health.receipt.id, to: 'supported', reason: 'resolved' },
        opts,
      ),
    );
    await expect(check([health.receipt.id], 'share')).resolves.toHaveLength(1);
  });

  it('a superseded receipt fails as stale_version; an unknown id as receipt_not_supported', async () => {
    const scope = newScope();
    const first = await observe(scope, 'checkout.health', HEALTH_OK);
    await observe(scope, 'checkout.health', HEALTH_BAD);
    expect((await rejection(check([first.receipt.id], 'share'))).reason).toBe(
      'stale_version',
    );
    expect((await rejection(check([randomUUID()], 'share'))).reason).toBe(
      'receipt_not_supported',
    );
  });

  it('a receipt past its expiry fails as expired', async () => {
    const scope = newScope();
    const receipt = await observe(scope, 'checkout.health', HEALTH_OK, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect((await rejection(check([receipt.receipt.id], 'share'))).reason).toBe(
      'expired',
    );
  });

  it('reports every examined entry on failure, and the first failing receipt in input order', async () => {
    const scope = newScope();
    const ok = await observe(scope, 'checkout.health', HEALTH_OK);
    const old = await observe(scope, 'checkout.metrics', HEALTH_OK);
    await observe(scope, 'checkout.metrics', HEALTH_BAD);
    const error = await rejection(
      check([ok.receipt.id, old.receipt.id], 'update'),
    );
    expect(error.reason).toBe('stale_version');
    expect(error.receiptId).toBe(old.receipt.id);
    expect(error.checkedVector).toHaveLength(2);
    expect(error.checkedVector[0].receiptStatus).toBe('supported');
    expect(error.checkedVector[1].receiptStatus).toBe('superseded');
  });
});

describe('controlled versions (G3: stale immediately, before any watcher runs)', () => {
  it('an advanced authority with no replacement receipt fails as stale_pending_observation in both lock modes', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await observeMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 9));
    for (const lockMode of ['share', 'update'] as const) {
      const error = await rejection(check([r1.receipt.id], lockMode));
      expect(error.reason).toBe('stale_pending_observation');
      expect(error.checkedVector[0]).toMatchObject({
        recordedRevision: 1,
        liveRevision: 2,
        receiptStatus: 'supported',
      });
    }
    await observeMember(scope, 'db.pool_max');
    // the pending replacement was never permission; once registered the old one is simply stale
    expect((await rejection(check([r1.receipt.id], 'update'))).reason).toBe(
      'stale_version',
    );
  });

  it('A -> B -> A: the first A stays non-current and the second A is current', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const a1 = await observeMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 7));
    await observeMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 3));
    const a2 = await observeMember(scope, 'db.pool_max');
    expect((await rejection(check([a1.receipt.id], 'update'))).reason).toBe(
      'stale_version',
    );
    await expect(check([a2.receipt.id], 'update')).resolves.toHaveLength(1);
  });

  it('a deleted key leaves its member receipt stale', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'checkout.restrict_orders': true });
    const r1 = await observeMember(scope, 'checkout.restrict_orders');
    await inTx(getDb().app, (client) =>
      deleteConfig(client, 'checkout.restrict_orders'),
    );
    expect((await rejection(check([r1.receipt.id], 'share'))).reason).toBe(
      'stale_pending_observation',
    );
  });
});

describe('membership-only collection (C1/D1)', () => {
  it('a member value change leaves the collection receipt current; only a key insert or delete supersedes it', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, {
      'db.pool_max': 3,
      'ui.banner_text': 'one',
    });
    const c1 = await observeCollection(scope);
    expect(c1.receipt.normalizedValue).toEqual({
      keys: ['db.pool_max', 'ui.banner_text'],
      collectionVersion: 3,
    });
    const member = await observeMember(scope, 'ui.banner_text');

    // B1: the benign banner change
    await inTx(getDb().app, (client) =>
      updateConfig(client, 'ui.banner_text', 'two'),
    );
    await expect(check([c1.receipt.id], 'share')).resolves.toHaveLength(1);
    await expect(check([c1.receipt.id], 'update')).resolves.toHaveLength(1);
    expect((await rejection(check([member.receipt.id], 'share'))).reason).toBe(
      'stale_pending_observation',
    );
    const sameCollection = await observeCollection(scope);
    expect(sameCollection.newRevision).toBe(false);
    expect(sameCollection.receipt.id).toBe(c1.receipt.id);

    // insert: the collection moves, the other members do not
    await inTx(getDb().app, (client) =>
      insertConfig(client, 'checkout.restrict_orders', true),
    );
    expect((await rejection(check([c1.receipt.id], 'share'))).reason).toBe(
      'stale_pending_observation',
    );
    const c2 = await observeCollection(scope);
    expect(c2.newRevision).toBe(true);
    expect(c2.receipt.sourceRevision).toBe(4);
    expect(c2.invalidation!.reason).toBe('collection_changed');
    expect((await rejection(check([c1.receipt.id], 'update'))).reason).toBe(
      'stale_version',
    );

    // delete
    await inTx(getDb().app, (client) =>
      deleteConfig(client, 'checkout.restrict_orders'),
    );
    const c3 = await observeCollection(scope);
    expect(c3.receipt.sourceRevision).toBe(5);
    await expect(check([c3.receipt.id], 'share')).resolves.toHaveLength(1);
  });

  it('refuses a collection value that disagrees with the authority', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    await expect(
      observe(scope, 'checkout.config', {
        keys: ['db.pool_max', 'ghost'],
        collectionVersion: 2,
      }),
    ).rejects.toThrow(/disagree with the authority/);
    await expect(
      observe(scope, 'checkout.config', {
        keys: ['db.pool_max'],
        collectionVersion: 1,
      }),
    ).rejects.toThrow(/older than current revision 2/);
    await expect(
      observe(scope, 'checkout.config', {
        keys: ['db.pool_max'],
        collectionVersion: 9,
      }),
    ).rejects.toThrow(/claimed revision 9/);
  });

  it('a negative membership predicate goes stale when a key is inserted', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const absence = await observeCollection(scope, {
      predicate: "key 'checkout.restrict_orders' does not exist",
    });
    expect(absence.receipt.negative).toEqual({
      predicate: "key 'checkout.restrict_orders' does not exist",
      collectionRevision: 2,
    });
    await expect(check([absence.receipt.id], 'share')).resolves.toHaveLength(1);
    await inTx(getDb().app, (client) =>
      insertConfig(client, 'checkout.restrict_orders', true),
    );
    for (const lockMode of ['share', 'update'] as const)
      expect(
        (await rejection(check([absence.receipt.id], lockMode))).reason,
      ).toBe('stale_pending_observation');
  });

  it('refuses a negative predicate claiming a collection revision other than the live one', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    await expect(
      observe(
        scope,
        'checkout.config',
        { keys: ['db.pool_max'], collectionVersion: 2 },
        {
          negative: {
            predicate: "key 'x' does not exist",
            collectionRevision: 1,
          },
        },
      ),
    ).rejects.toThrow(/older than current revision 2/);
  });
});

describe('freshness from confirmations (I2/D3)', () => {
  it('an aged receipt fails a 120 s check, a same-digest re-observation restores it without a new revision', async () => {
    const scope = newScope();
    const freshness = { 'checkout.health': 120_000 };
    const aged = await observe(scope, 'checkout.health', HEALTH_OK, {
      observedAt: new Date(Date.now() - 121_000),
    });
    const error = await rejection(check([aged.receipt.id], 'share', freshness));
    expect(error.reason).toBe('evidence_too_old');
    expect(error.checkedVector[0].freshnessOk).toBe(false);
    // no policy entry for the key: age does not matter
    await expect(
      check([aged.receipt.id], 'share', { 'redis.stats': 1 }),
    ).resolves.toHaveLength(1);

    const confirmed = await observe(scope, 'checkout.health', HEALTH_OK);
    expect(confirmed.newRevision).toBe(false);
    expect(confirmed.receipt.id).toBe(aged.receipt.id);
    const vector = await check([aged.receipt.id], 'share', freshness);
    expect(vector[0]).toMatchObject({ freshnessOk: true, recordedRevision: 1 });
    expect(Date.parse(vector[0].lastConfirmedAt)).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it('freshness is judged on max(observed_at, last confirmation), not the oldest', async () => {
    const scope = newScope();
    const fresh = await observe(scope, 'redis.stats', HEALTH_OK);
    await expect(
      check([fresh.receipt.id], 'update', { 'redis.stats': 120_000 }),
    ).resolves.toHaveLength(1);
    await expect(
      check([fresh.receipt.id], 'update', { 'redis.stats': 0 }),
    ).rejects.toBeInstanceOf(SupportError);
  });
});

describe('the validator port', () => {
  it('createSupportValidator binds the options and implements the contract signature', async () => {
    const scope = newScope();
    const receipt = await observe(scope, 'checkout.health', HEALTH_OK);
    const validator = createSupportValidator(FX);
    const vector = await inTx(getDb().app, (client) =>
      validator.assertCurrent(client, [receipt.receipt.id], {
        lockMode: 'share',
      }),
    );
    expect(vector).toHaveLength(1);
  });
});

describe('locks (C9)', () => {
  // A failed assertion must not leave a transaction holding row locks for the
  // next test: whatever is still open is rolled back and released afterwards.
  const open = new Set<pg.PoolClient>();
  const connect = async (pool: pg.Pool) => {
    const client = await pool.connect();
    open.add(client);
    return client;
  };
  const done = (client: pg.PoolClient) => {
    if (open.delete(client)) client.release();
  };
  afterEach(async () => {
    for (const client of open) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    open.clear();
  });
  async function openTx(pool: pg.Pool) {
    const client = await connect(pool);
    await client.query('BEGIN');
    return { client, pid: await backendPid(client) };
  }

  it("lockMode 'update' blocks behind a concurrent writer, then fails stale_version once the bump and its registration commit", async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await observeMember(scope, 'db.pool_max');
    const { app, admin } = getDb();

    const writer = await openTx(app);
    await updateConfig(writer.client, 'db.pool_max', 8); // row lock held, uncommitted

    const checker = await connect(app);
    const checkerPid = await backendPid(checker);
    let settled = false;
    const outcome = (async () => {
      await checker.query('BEGIN');
      try {
        return await assertCurrent(
          checker,
          [r1.receipt.id],
          { lockMode: 'update' },
          FX,
        );
      } finally {
        await checker.query('ROLLBACK');
        settled = true;
      }
    })();
    const outcomeResult = outcome.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    expect(await waitsOnLock(admin, checkerPid)).toBe(true);
    expect(settled).toBe(false);

    // the writer's bump becomes visible together with the replacement receipt
    const read = await readMember(writer.client, 'db.pool_max');
    await registerObservation(
      writer.client,
      {
        source: sourceRef(scope, 'checkout.config/db.pool_max'),
        normalizedValue: read.normalizedValue,
        provenance: { kind: 'watcher' },
      },
      opts,
    );
    await writer.client.query('COMMIT');
    done(writer.client);

    const result = await withTimeout(
      outcomeResult,
      5_000,
      'assertCurrent after the writer commits',
    );
    done(checker);
    expect(result).toBeInstanceOf(SupportError);
    expect((result as SupportError).reason).toBe('stale_version');
  });

  it("lockMode 'share' makes a concurrent version advance wait until the publication commits", async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await observeMember(scope, 'db.pool_max');
    const { app, admin } = getDb();

    const publication = await openTx(app);
    await assertCurrent(
      publication.client,
      [r1.receipt.id],
      { lockMode: 'share' },
      FX,
    );

    const writer = await connect(app);
    const writerPid = await backendPid(writer);
    let advanced = false;
    const write = (async () => {
      await writer.query('BEGIN');
      // advanceConfig's statement: the member row FOR UPDATE, then the bump
      await writer.query(
        "SELECT version FROM fx_checkout.config_entries WHERE key = 'db.pool_max' FOR UPDATE",
      );
      await updateConfig(writer, 'db.pool_max', 11);
      await writer.query('COMMIT');
      advanced = true;
    })();

    expect(await waitsOnLock(admin, writerPid)).toBe(true);
    expect(advanced).toBe(false);
    await publication.client.query('COMMIT'); // the publication lands first
    done(publication.client);
    await withTimeout(write, 5_000, 'writer after the publication commits');
    done(writer);
    expect(advanced).toBe(true);
    // and the receipt the publication relied on is now stale
    expect((await rejection(check([r1.receipt.id], 'share'))).reason).toBe(
      'stale_pending_observation',
    );
  });

  it('a share-locked observed source makes a concurrent registration of that source wait (C13)', async () => {
    const scope = newScope();
    const first = await observe(scope, 'checkout.health', HEALTH_OK);
    const { app, admin } = getDb();
    const publication = await openTx(app);
    await assertCurrent(
      publication.client,
      [first.receipt.id],
      { lockMode: 'share' },
      FX,
    );

    const registrar = await connect(app);
    const registrarPid = await backendPid(registrar);
    const registered = (async () => {
      await registrar.query('BEGIN');
      const result = await registerObservation(
        registrar,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: HEALTH_BAD,
          provenance: { kind: 'watcher' },
        },
        opts,
      );
      await registrar.query('COMMIT');
      return result;
    })();
    expect(await waitsOnLock(admin, registrarPid)).toBe(true);
    await publication.client.query('COMMIT');
    done(publication.client);
    const result = await withTimeout(
      registered,
      5_000,
      'registration after the publication commits',
    );
    done(registrar);
    expect(result.receipt.sourceRevision).toBe(2);

    // the same two statements in the opposite order: registration first, publication rejected
    const retry = await openTx(app);
    await expect(
      assertCurrent(
        retry.client,
        [first.receipt.id],
        { lockMode: 'share' },
        FX,
      ),
    ).rejects.toBeInstanceOf(SupportError);
    await retry.client.query('ROLLBACK');
    done(retry.client);
  });

  it('two checkers hold shared locks together (no serialization between publications)', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await observeMember(scope, 'db.pool_max');
    const both = barrier(2);
    const run = () =>
      inTx(getDb().app, async (client) => {
        const vector = await assertCurrent(
          client,
          [r1.receipt.id],
          { lockMode: 'share' },
          FX,
        );
        await withTimeout(
          both.arrive(),
          5_000,
          'second share locker never arrived',
        );
        return vector;
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
