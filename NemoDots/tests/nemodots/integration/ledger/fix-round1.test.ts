// Regression tests for the round-1 review findings of the ledger (member
// observations vs the authority row, retirement vs publication, lock order of
// the closure against publications and commits, per-mission edge lock,
// readset currency, observedAt bounds, coarse invalidation).
//
// Every test pins an outcome with real concurrent transactions on the app
// role. "No deadlock" is asserted twice: no 40P01, and the blocked side
// finishes well inside PostgreSQL's deadlock_timeout (1 s by default), so a
// pass cannot come from the deadlock detector resolving a cycle.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidObservationError,
  SupportError,
  addEdges,
  assertCurrent,
  recordReadSet,
  registerObservation,
  registerWithoutClosure,
  transitionReceipt,
} from '../../../../src/server/nemodots/ledger/index.js';
import { withTimeout } from '../../helpers/barrier.js';
import {
  FX,
  backendPid,
  count,
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
  type TestScope,
} from './fixtures.js';

const getDb = useLedgerDb();

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

// Connections a test holds open across awaits. A failing assertion must not
// leave a transaction (and its locks) behind for the next test, so the
// backends are terminated and the connections destroyed after every test.
const held: { client: pg.PoolClient; pid: number }[] = [];
async function open(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect();
  held.push({ client, pid: await backendPid(client) });
  return client;
}
afterEach(async () => {
  for (const { client, pid } of held.splice(0)) {
    await getDb()
      .admin.query('SELECT pg_terminate_backend($1)', [pid])
      .catch(() => {});
    client.release(new Error('terminated by the test'));
  }
});

/** Well inside deadlock_timeout (1 s): a blocked statement that was merely unblocked. */
const FAST_MS = 800;

const code = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;

async function registerMember(scope: TestScope, key: string) {
  return inTx(getDb().app, async (client) => {
    const read = await readMember(client, key);
    return registerObservation(
      client,
      {
        source: sourceRef(scope, `checkout.config/${key}`),
        normalizedValue: read.normalizedValue,
        provenance: { kind: 'watcher' },
      },
      { ledger: FX, marker: null },
    );
  });
}

async function registerHealth(scope: TestScope, value: unknown) {
  return inTx(getDb().app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(scope, 'checkout.health'),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
      },
      { ledger: FX, marker: null },
    ),
  );
}

async function insertAttempt(scope: TestScope, status = 'running') {
  const id = randomUUID();
  const taskId = randomUUID();
  await getDb().admin.query(
    'INSERT INTO fx_coordinator.task_attempts (id, task_id, mission_id, status) VALUES ($1,$2,$3,$4)',
    [id, taskId, scope.missionId, status],
  );
  return { id, taskId };
}

async function statusOf(table: string, id: string): Promise<string> {
  const { rows } = await getDb().admin.query<{ status: string }>(
    `SELECT status FROM fx_coordinator.${table} WHERE id = $1`,
    [id],
  );
  return rows[0].status;
}

const receiptCount = (scope: TestScope) =>
  count(
    getDb().admin,
    `SELECT count(*) AS n FROM ledger.observation_receipts r
       JOIN ledger.sources s ON s.id = r.source_id WHERE s.owner_id = $1`,
    [scope.ownerId],
  );

// --- 1. member observations must describe the authority row -----------------

describe('controlled member: the observation must describe the locked authority row', () => {
  it('a value read at v1 and registered after the key advanced to v2 is rejected, nothing is registered', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const stale = await inTx(app, (client) =>
      readMember(client, 'db.pool_max'),
    );
    await inTx(app, (client) => updateConfig(client, 'db.pool_max', 4));

    const error = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: stale.normalizedValue,
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('stale_observation_rejected');
    expect(await receiptCount(scope)).toBe(0);

    const fresh = await registerMember(scope, 'db.pool_max');
    expect(fresh.receipt.sourceRevision).toBe(2);
    expect(fresh.receipt.normalizedValue).toEqual({
      key: 'db.pool_max',
      value: 4,
      version: 2,
    });
  });

  it('the same version with a value that differs from the authority row is a digest_mismatch', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const error = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: { key: 'db.pool_max', value: 99, version: 1 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('digest_mismatch');
    expect(await receiptCount(scope)).toBe(0);
  });

  it('an embedded version ahead of the authority is a revision_mismatch', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const error = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: { key: 'db.pool_max', value: 3, version: 2 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('revision_mismatch');
  });

  it('a value naming another key, or not shaped { key, value, version }, is invalid', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3, 'cache.ttl': 5 });
    for (const normalizedValue of [
      { key: 'cache.ttl', value: 3, version: 1 },
      { key: 'db.pool_max', value: 3 },
      { key: 'db.pool_max', value: 3, version: 1, extra: true },
      3,
    ]) {
      const error = await inTx(app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.config/db.pool_max'),
            normalizedValue,
            provenance: { kind: 'watcher' },
          },
          { ledger: FX, marker: null },
        ),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidObservationError);
    }
    expect(await receiptCount(scope)).toBe(0);
  });
});

// --- 2. retirement of a controlled receipt vs a publication (C9/C13) --------

describe('retiring a controlled receipt vs a concurrent G2 publication', () => {
  for (const [to, reason] of [
    ['retracted', 'owner_retraction'],
    ['expired', 'ttl_elapsed'],
  ] as const) {
    it(`${to}: a publication opened during the retirement waits, then is refused; no edge reaches the retired receipt`, async () => {
      const { app, admin } = getDb();
      const scope = newScope();
      await seedConfig(app, { 'db.pool_max': 3 });
      const reg = await registerMember(scope, 'db.pool_max');
      const attempt = await insertAttempt(scope);

      const retractor = await open(app);
      await retractor.query('BEGIN');
      await transitionReceipt(
        retractor,
        { receiptId: reg.receipt.id, to, reason },
        { ledger: FX },
      );

      const publisher = await open(app);
      const pid = await backendPid(publisher);
      let publicationError: unknown = null;
      const publication = (async () => {
        try {
          await publisher.query('BEGIN');
          await assertCurrent(
            publisher,
            [reg.receipt.id],
            { lockMode: 'share' },
            FX,
          );
          await recordReadSet(
            publisher,
            {
              missionId: scope.missionId,
              taskId: attempt.taskId,
              attemptId: attempt.id,
              receiptIds: [reg.receipt.id],
            },
            FX,
          );
          await publisher.query('COMMIT');
        } catch (error) {
          publicationError = error;
          await publisher.query('ROLLBACK').catch(() => {});
        }
      })();
      expect(await waitsOnLock(admin, pid, 3_000)).toBe(true);
      await retractor.query('COMMIT');
      await publication;

      expect(publicationError).toBeInstanceOf(SupportError);
      expect((publicationError as SupportError).reason).toBe(
        'receipt_not_supported',
      );
      expect(
        await count(
          admin,
          'SELECT count(*) AS n FROM ledger.dependency_edges WHERE from_id = $1',
          [reg.receipt.id],
        ),
      ).toBe(0);
    });

    it(`${to}: a publication that committed first is inside the closure, its attempt is invalidated`, async () => {
      const { app, admin } = getDb();
      const scope = newScope();
      await seedConfig(app, { 'db.pool_max': 3 });
      const reg = await registerMember(scope, 'db.pool_max');
      const attempt = await insertAttempt(scope);

      const publisher = await open(app);
      await publisher.query('BEGIN');
      await assertCurrent(
        publisher,
        [reg.receipt.id],
        { lockMode: 'share' },
        FX,
      );
      await recordReadSet(
        publisher,
        {
          missionId: scope.missionId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          receiptIds: [reg.receipt.id],
        },
        FX,
      );

      const retractor = await open(app);
      const pid = await backendPid(retractor);
      await retractor.query('BEGIN');
      const retirement = transitionReceipt(
        retractor,
        { receiptId: reg.receipt.id, to, reason },
        { ledger: FX },
      );
      expect(await waitsOnLock(admin, pid, 3_000)).toBe(true);
      await publisher.query('COMMIT');
      const result = await withTimeout(retirement, 5_000, 'retirement');
      await retractor.query('COMMIT');

      expect(result.invalidation!.affected.attemptIds).toEqual([attempt.id]);
      expect(await statusOf('task_attempts', attempt.id)).toBe('invalidated');
    });
  }
});

// --- 3./4. closure vs G1 commit and G2 publication: no lock cycle -----------

describe('closure versus in-flight commits and publications (lock order)', () => {
  it('controlled: the registration waits for the committer holding the intent; the committer finishes unblocked and the intent is then blocked', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const reg = await registerMember(scope, 'db.pool_max');
    const taskId = randomUUID();
    const intentId = randomUUID();
    await admin.query(
      `INSERT INTO fx_coordinator.action_intents (id, mission_id, task_id, status) VALUES ($1,$2,$3,'admitted')`,
      [intentId, scope.missionId, taskId],
    );
    await inTx(app, (client) =>
      addEdges(client, [
        {
          kind: 'evidence',
          from: { kind: 'receipt', id: reg.receipt.id },
          to: {
            kind: 'action_intent',
            id: intentId,
            missionId: scope.missionId,
            taskId,
          },
        },
      ]),
    );
    await inTx(app, (client) => updateConfig(client, 'db.pool_max', 4));

    // G1 commit, ARCHITECTURE 5.1: the intent first, then the config row.
    const committer = await open(app);
    await committer.query('BEGIN');
    await committer.query(
      'SELECT id FROM fx_coordinator.action_intents WHERE id = $1 FOR UPDATE',
      [intentId],
    );

    const watcher = await open(app);
    const watcherPid = await backendPid(watcher);
    let watcherError: unknown = null;
    const registration = (async () => {
      try {
        await watcher.query('BEGIN');
        const read = await readMember(watcher, 'db.pool_max');
        const result = await registerObservation(
          watcher,
          {
            source: sourceRef(scope, 'checkout.config/db.pool_max'),
            normalizedValue: read.normalizedValue,
            provenance: { kind: 'watcher' },
          },
          { ledger: FX },
        );
        await watcher.query('COMMIT');
        return result;
      } catch (error) {
        watcherError = error;
        await watcher.query('ROLLBACK').catch(() => {});
        return null;
      }
    })();
    expect(await waitsOnLock(admin, watcherPid, 3_000)).toBe(true);

    const started = Date.now();
    let commitError: unknown = null;
    try {
      await committer.query(
        'SELECT key FROM fx_checkout.config_entries WHERE key = $1 FOR UPDATE',
        ['db.pool_max'],
      );
      await committer.query('COMMIT');
    } catch (error) {
      commitError = error;
      await committer.query('ROLLBACK').catch(() => {});
    }
    const commitMs = Date.now() - started;
    const result = await withTimeout(registration, 5_000, 'registration');

    expect(code(commitError)).toBeNull();
    expect(code(watcherError)).toBeNull();
    expect(commitMs).toBeLessThan(FAST_MS);
    expect(result!.receipt.sourceRevision).toBe(2);
    expect(result!.invalidation!.affected.actionIds).toEqual([intentId]);
    expect(await statusOf('action_intents', intentId)).toBe('blocked');
  });

  it('observed: the registration waits for a publication holding the attempt; the publication passes assertCurrent unblocked and its new edge is inside the closure', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    const head = await registerHealth(scope, { status: 'ok' });
    const held = await insertAttempt(scope);
    const late = await insertAttempt(scope);
    await inTx(app, (client) =>
      recordReadSet(
        client,
        {
          missionId: scope.missionId,
          taskId: held.taskId,
          attemptId: held.id,
          receiptIds: [head.receipt.id],
        },
        FX,
      ),
    );

    // Publication (fence.ts): the attempt row first, the ledger afterwards.
    const publisher = await open(app);
    await publisher.query('BEGIN');
    await publisher.query(
      'SELECT id FROM fx_coordinator.task_attempts WHERE id = $1 FOR UPDATE',
      [held.id],
    );

    const watcher = await open(app);
    const watcherPid = await backendPid(watcher);
    let watcherError: unknown = null;
    const registration = (async () => {
      try {
        await watcher.query('BEGIN');
        const result = await registerObservation(
          watcher,
          {
            source: sourceRef(scope, 'checkout.health'),
            normalizedValue: { status: 'down' },
            provenance: { kind: 'watcher' },
          },
          { ledger: FX },
        );
        await watcher.query('COMMIT');
        return result;
      } catch (error) {
        watcherError = error;
        await watcher.query('ROLLBACK').catch(() => {});
        return null;
      }
    })();
    expect(await waitsOnLock(admin, watcherPid, 3_000)).toBe(true);

    const started = Date.now();
    let publicationError: unknown = null;
    try {
      await assertCurrent(
        publisher,
        [head.receipt.id],
        { lockMode: 'share' },
        FX,
      );
      // The publication records another attempt's read of the same receipt.
      await recordReadSet(
        publisher,
        {
          missionId: scope.missionId,
          taskId: late.taskId,
          attemptId: late.id,
          receiptIds: [head.receipt.id],
        },
        FX,
      );
      await publisher.query('COMMIT');
    } catch (error) {
      publicationError = error;
      await publisher.query('ROLLBACK').catch(() => {});
    }
    const publicationMs = Date.now() - started;
    const result = await withTimeout(registration, 5_000, 'registration');

    expect(code(publicationError)).toBeNull();
    expect(code(watcherError)).toBeNull();
    expect(publicationMs).toBeLessThan(FAST_MS);
    expect(result!.invalidation!.affected.attemptIds).toEqual(
      [held.id, late.id].sort(),
    );
    expect(await statusOf('task_attempts', held.id)).toBe('invalidated');
    expect(await statusOf('task_attempts', late.id)).toBe('invalidated');
  });
});

// --- 5. the edge lock is per mission -----------------------------------------

describe('edge cycle lock', () => {
  const node = (
    kind: 'attempt' | 'task_output',
    id: string,
    missionId: string,
    taskId: string,
  ) => ({ kind, id, missionId, taskId });

  it('an open edge write in one mission does not block an edge write in another', async () => {
    const { app, admin } = getDb();
    const a = { mission: randomUUID(), task: randomUUID() };
    const b = { mission: randomUUID(), task: randomUUID() };
    const edge = (m: { mission: string; task: string }) => ({
      kind: 'evidence' as const,
      from: node('attempt', randomUUID(), m.mission, m.task),
      to: node('task_output', randomUUID(), m.mission, m.task),
    });
    const holder = await open(app);
    await holder.query('BEGIN');
    await addEdges(holder, [edge(a)]);

    const other = await open(app);
    const pid = await backendPid(other);
    await other.query('BEGIN');
    const write = addEdges(other, [edge(b)]);
    const blocked = await waitsOnLock(admin, pid, 750);
    // Releasing the holder first keeps a regression a failed assertion, not a hang.
    await holder.query('COMMIT');
    await write;
    await other.query('COMMIT');
    expect(blocked).toBe(false);
  });

  it('two writers of one mission still serialize: opposing edges race to exactly one edge_cycle', async () => {
    const { app } = getDb();
    const mission = randomUUID();
    const task = randomUUID();
    const attempt = node('attempt', randomUUID(), mission, task);
    const output = node('task_output', randomUUID(), mission, task);
    const outcomes = await withTimeout(
      Promise.all([
        inTx(app, (client) =>
          addEdges(client, [{ kind: 'evidence', from: attempt, to: output }]),
        ).then(
          () => 'ok',
          (e: unknown) => code(e),
        ),
        inTx(app, (client) =>
          addEdges(client, [
            { kind: 'inheritance', from: output, to: attempt },
          ]),
        ).then(
          () => 'ok',
          (e: unknown) => code(e),
        ),
      ]),
      10_000,
      'opposing edges',
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'edge_cycle')).toHaveLength(1);
  });
});

// --- 6. recordReadSet checks currency ----------------------------------------

describe('recordReadSet', () => {
  it('refuses a superseded receipt and stores no edge', async () => {
    const { app } = getDb();
    const scope = newScope();
    const first = await registerHealth(scope, { status: 'ok' });
    await registerHealth(scope, { status: 'down' });
    const attempt = await insertAttempt(scope);
    const error = await inTx(app, (client) =>
      recordReadSet(
        client,
        {
          missionId: scope.missionId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          receiptIds: [first.receipt.id],
        },
        FX,
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('stale_version');
    expect(
      await count(
        app,
        'SELECT count(*) AS n FROM ledger.dependency_edges WHERE from_id = $1',
        [first.receipt.id],
      ),
    ).toBe(0);
  });

  it('a read set opened during a registration waits and is then refused', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    const first = await registerHealth(scope, { status: 'ok' });
    const attempt = await insertAttempt(scope);

    const registrar = await open(app);
    await registrar.query('BEGIN');
    await registerObservation(
      registrar,
      {
        source: sourceRef(scope, 'checkout.health'),
        normalizedValue: { status: 'down' },
        provenance: { kind: 'watcher' },
      },
      { ledger: FX },
    );
    const reader = await open(app);
    const pid = await backendPid(reader);
    await reader.query('BEGIN');
    const read = recordReadSet(
      reader,
      {
        missionId: scope.missionId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        receiptIds: [first.receipt.id],
      },
      FX,
    ).catch((e: unknown) => e);
    expect(await waitsOnLock(admin, pid, 3_000)).toBe(true);
    await registrar.query('COMMIT');
    const error = await read;
    await reader.query('ROLLBACK');
    expect(error).toBeInstanceOf(SupportError);
    expect(
      await count(
        admin,
        'SELECT count(*) AS n FROM ledger.dependency_edges WHERE from_id = $1',
        [first.receipt.id],
      ),
    ).toBe(0);
  });
});

// --- 7. observedAt is bounded by the database clock -------------------------

describe('observedAt', () => {
  it('a time beyond the clock skew is refused, so it cannot defeat freshness', async () => {
    const { app } = getDb();
    const scope = newScope();
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const error = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
          observedAt: future,
        },
        { ledger: FX, marker: null },
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidObservationError);
    expect(await receiptCount(scope)).toBe(0);
  });

  it('a past time and a time within the skew are accepted', async () => {
    const { app } = getDb();
    for (const offset of [-3_600_000, 2_000]) {
      const scope = newScope();
      const result = await inTx(app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.health'),
            normalizedValue: { status: 'ok' },
            provenance: { kind: 'watcher' },
            observedAt: new Date(Date.now() + offset),
          },
          { ledger: FX, marker: null },
        ),
      );
      expect(result.newRevision).toBe(true);
    }
  });
});

// --- 8. registerWithoutClosure needs a coarse set ----------------------------

describe('registerWithoutClosure (cap path)', () => {
  const affectedOf = (patch: Record<string, string[]>) => ({
    modelCallIds: [],
    attemptIds: [],
    outputIds: [],
    actionIds: [],
    taskIds: [],
    ...patch,
  });

  it('refuses to supersede a live receipt without a coarse invalidation, and writes nothing', async () => {
    const { app } = getDb();
    const scope = newScope();
    const first = await registerHealth(scope, { status: 'ok' });
    const error = await inTx(app, (client) =>
      (
        registerWithoutClosure as (
          client: pg.PoolClient,
          input: unknown,
          options: unknown,
        ) => Promise<unknown>
      )(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX },
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('coarse_required');
    expect(await receiptCount(scope)).toBe(1);
    expect(
      await count(
        app,
        "SELECT count(*) AS n FROM ledger.observation_receipts WHERE id = $1 AND status = 'supported'",
        [first.receipt.id],
      ),
    ).toBe(1);
  });

  it('applies the compare-and-set marks to the coarse set', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    await registerHealth(scope, { status: 'ok' });
    const attempt = await insertAttempt(scope);
    const intentId = randomUUID();
    await admin.query(
      `INSERT INTO fx_coordinator.action_intents (id, mission_id, task_id, status) VALUES ($1,$2,$3,'proposed')`,
      [intentId, scope.missionId, attempt.taskId],
    );
    const result = await inTx(app, (client) =>
      registerWithoutClosure(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        {
          ledger: FX,
          coarse: {
            perMission: [
              {
                missionId: scope.missionId as never,
                affected: affectedOf({
                  attemptIds: [attempt.id],
                  actionIds: [intentId],
                }) as never,
                preserved: { taskIds: [] },
              },
            ],
          },
        },
      ),
    );
    expect(result.invalidation).toMatchObject({
      reason: 'closure_cap_exceeded',
      closure: { capped: true },
    });
    expect(result.marks).toMatchObject({
      attemptsInvalidated: [attempt.id],
      intentsBlocked: [intentId],
    });
    expect(await statusOf('task_attempts', attempt.id)).toBe('invalidated');
    expect(await statusOf('action_intents', intentId)).toBe('blocked');
  });
});

// --- 9. a dead attempt does not taint a repaired task (closure rule R2) ------

describe('closure rule R2: dead attempts', () => {
  it('a repaired task whose invalidated attempt read the changed receipt is not invalidated again', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    const health = await registerHealth(scope, { status: 'ok' });
    const redis = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'redis.stats'),
          normalizedValue: { hits: 1 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    const taskId = randomUUID();
    const oldAttempt = randomUUID();
    const newAttempt = randomUUID();
    await admin.query(
      `INSERT INTO fx_coordinator.tasks (id, mission_id, status) VALUES ($1, $2, 'succeeded')`,
      [taskId, scope.missionId],
    );
    await admin.query(
      `INSERT INTO fx_coordinator.task_attempts (id, task_id, mission_id, status)
       VALUES ($1, $3, $4, 'running'), ($2, $3, $4, 'running')`,
      [oldAttempt, newAttempt, taskId, scope.missionId],
    );
    await inTx(app, async (client) => {
      await recordReadSet(
        client,
        {
          missionId: scope.missionId,
          taskId,
          attemptId: oldAttempt,
          receiptIds: [health.receipt.id],
        },
        FX,
      );
      await recordReadSet(
        client,
        {
          missionId: scope.missionId,
          taskId,
          attemptId: newAttempt,
          receiptIds: [redis.receipt.id],
        },
        FX,
      );
    });
    // The first attempt was invalidated earlier and its repair attempt published.
    await admin.query(
      `UPDATE fx_coordinator.task_attempts SET status = 'invalidated', abort_reason = 'readset_invalidated' WHERE id = $1`,
      [oldAttempt],
    );
    await admin.query(
      `UPDATE fx_coordinator.task_attempts SET status = 'published' WHERE id = $1`,
      [newAttempt],
    );

    const result = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX },
      ),
    );
    expect(result.invalidation!.affected.taskIds).toEqual([]);
    expect(result.marks!.tasksInvalidated).toEqual([]);
    expect(result.invalidation!.perMission[0].preserved.taskIds).toEqual([
      taskId,
    ]);
    expect(await statusOf('tasks', taskId)).toBe('succeeded');
  });
});

// --- 10. a read set that is still open cannot be missed by the closure -------

describe('recordReadSet versus a concurrent registration', () => {
  it('the registration waits for the open read set and then reaches its attempt', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    const first = await registerHealth(scope, { status: 'ok' });
    const attempt = await insertAttempt(scope);

    const reader = await open(app);
    await reader.query('BEGIN');
    await recordReadSet(
      reader,
      {
        missionId: scope.missionId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        receiptIds: [first.receipt.id],
      },
      FX,
    );

    const registrar = await open(app);
    const pid = await backendPid(registrar);
    await registrar.query('BEGIN');
    const registration = registerObservation(
      registrar,
      {
        source: sourceRef(scope, 'checkout.health'),
        normalizedValue: { status: 'down' },
        provenance: { kind: 'watcher' },
      },
      { ledger: FX },
    );
    // Before the fix it completed at once with an empty closure.
    expect(await waitsOnLock(admin, pid, 3_000)).toBe(true);
    await reader.query('COMMIT');
    const result = await withTimeout(registration, 5_000, 'registration');
    await registrar.query('COMMIT');

    expect(result.invalidation!.affected.attemptIds).toEqual([attempt.id]);
    expect(await statusOf('task_attempts', attempt.id)).toBe('invalidated');
  });
});

// --- 11. confirmations carry the sample time, not the arrival time -----------

describe('confirmation freshness', () => {
  const observeHealth = (scope: TestScope, observedAt?: Date) =>
    inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
          ...(observedAt ? { observedAt } : {}),
        },
        { ledger: FX, marker: null },
      ),
    );

  it('a same-digest re-observation sampled earlier does not claim to be fresh now', async () => {
    const scope = newScope();
    const tenMinutes = Date.now() - 600_000;
    const fiveMinutes = Date.now() - 300_000;
    await observeHealth(scope, new Date(tenMinutes));
    const again = await observeHealth(scope, new Date(fiveMinutes));
    expect(again.newRevision).toBe(false);
    expect(Date.parse(again.confirmation!.confirmedAt)).toBe(fiveMinutes);
    expect(Date.parse(again.receipt.lastConfirmedAt)).toBe(fiveMinutes);
    // ... so a 120 s freshness policy still refuses it.
    const error = await inTx(getDb().app, (client) =>
      assertCurrent(
        client,
        [again.receipt.id],
        { lockMode: 'share', freshness: { 'checkout.health': 120_000 } },
        FX,
      ),
    ).catch((e: unknown) => e);
    expect((error as SupportError).reason).toBe('evidence_too_old');
  });

  it('a re-observation without a sample time is stamped now, and a future one is refused', async () => {
    const scope = newScope();
    await observeHealth(scope, new Date(Date.now() - 600_000));
    const now = await observeHealth(scope);
    expect(Date.now() - Date.parse(now.receipt.lastConfirmedAt)).toBeLessThan(
      30_000,
    );
    const error = await observeHealth(
      scope,
      new Date(Date.now() + 3_600_000),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidObservationError);
  });
});

// --- 12. a confirmation cannot add a membership predicate --------------------

describe('membership predicate on an unchanged collection', () => {
  const observeCollection = (
    scope: TestScope,
    negative?: { predicate: string; collectionRevision: number },
  ) =>
    inTx(getDb().app, async (client) => {
      const keys = await client.query<{ key: string }>(
        'SELECT key FROM fx_checkout.config_entries ORDER BY key',
      );
      const version = await client.query<{ version: number }>(
        'SELECT version FROM fx_checkout.config_collection',
      );
      return registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config'),
          normalizedValue: {
            keys: keys.rows.map((row) => row.key),
            collectionVersion: version.rows[0].version,
          },
          provenance: { kind: 'watcher' },
          ...(negative ? { negative } : {}),
        },
        { ledger: FX, marker: null },
      );
    });

  it('refuses a predicate the stored receipt does not carry; the same predicate confirms', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const plain = await observeCollection(scope);
    const claim = {
      predicate: "key 'checkout.restrict_orders' does not exist",
      collectionRevision: 2,
    };
    const error = await observeCollection(scope, claim).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidObservationError);
    expect(
      await count(
        app,
        'SELECT count(*) AS n FROM ledger.receipt_confirmations WHERE receipt_id = $1',
        [plain.receipt.id],
      ),
    ).toBe(0);

    // At a new collection revision the predicate is stored with the new receipt,
    // and an identical re-observation then confirms it.
    await inTx(app, (client) => insertConfig(client, 'cache.ttl', 5));
    const withPredicate = await observeCollection(scope, {
      ...claim,
      collectionRevision: 3,
    });
    expect(withPredicate.newRevision).toBe(true);
    expect(withPredicate.receipt.negative).toEqual({
      ...claim,
      collectionRevision: 3,
    });
    const confirmed = await observeCollection(scope, {
      ...claim,
      collectionRevision: 3,
    });
    expect(confirmed.newRevision).toBe(false);
    expect(confirmed.receipt.negative).toEqual(withPredicate.receipt.negative);
  });
});

// --- 13. controlled receipts do not expire ------------------------------------

describe('controlled receipts and expiresAt', () => {
  it('a controlled registration with expiresAt is refused: expiry could never be repaired by observation', async () => {
    const { app } = getDb();
    const scope = newScope();
    await seedConfig(app, { 'db.pool_max': 3 });
    const error = await inTx(app, async (client) => {
      const read = await readMember(client, 'db.pool_max');
      return registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'watcher' },
          expiresAt: new Date(Date.now() + 60_000),
        },
        { ledger: FX, marker: null },
      );
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidObservationError);
    expect(await receiptCount(scope)).toBe(0);
  });
});
