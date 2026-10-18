// Receipt registration against real PostgreSQL as nemodots_app: immutability,
// revision rules for controlled and observed sources, supersession transitions,
// confirmations, environments and size bounds (TEST_PROMPT gate 1 items 1-4,
// 10-13; ARCHITECTURE 5.2; CONTRACTS 2).
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  digest,
  ObservationReceiptSchema,
  ReceiptConfirmationSchema,
  ReceiptTransitionSchema,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  DigestMismatchError,
  InvalidSourceKeyError,
  ObservationTooLargeError,
  ReceiptNotRegistrableError,
  RevisionMismatchError,
  StaleObservationRejectedError,
  listConfirmations,
  listTransitions,
  registerObservation,
  transitionReceipt,
  currentReceipt,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  FX,
  count,
  inTx,
  newScope,
  readMember,
  resetAuthority,
  seedConfig,
  sourceRef,
  updateConfig,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();
const opts = { ledger: FX, marker: null } as const;

const HEALTH_OK = { status: 'ok', checks: { postgres: true } };
const HEALTH_DEGRADED = { status: 'degraded', checks: { postgres: false } };

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

async function registerObserved(
  scope: ReturnType<typeof newScope>,
  key: string,
  value: unknown,
  extra: Partial<Parameters<typeof registerObservation>[1]> = {},
) {
  return inTx(getDb().app, (client) =>
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
}

async function registerMember(scope: ReturnType<typeof newScope>, key: string) {
  return inTx(getDb().app, async (client) => {
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
}

describe('immutability (trigger, holds for every role including the owner)', () => {
  it('rejects updates to value, digest and revision, deletion, and illegal status transitions', async () => {
    const scope = newScope();
    const { receipt } = await registerObserved(
      scope,
      'checkout.health',
      HEALTH_OK,
    );
    expect(ObservationReceiptSchema.safeParse(receipt).success).toBe(true);
    const { app, admin } = getDb();
    const tampering = [
      "UPDATE ledger.observation_receipts SET normalized_value = '{}'::jsonb WHERE id = $1",
      "UPDATE ledger.observation_receipts SET content_digest = repeat('0', 64) WHERE id = $1",
      'UPDATE ledger.observation_receipts SET source_revision = source_revision + 1 WHERE id = $1',
      "UPDATE ledger.observation_receipts SET observed_at = observed_at - interval '1 day' WHERE id = $1",
      'DELETE FROM ledger.observation_receipts WHERE id = $1',
      // a status change must be a legal transition AND advance status_version by exactly one
      "UPDATE ledger.observation_receipts SET status = 'superseded' WHERE id = $1",
      "UPDATE ledger.observation_receipts SET status = 'superseded', status_version = 5 WHERE id = $1",
      'UPDATE ledger.observation_receipts SET status_version = status_version + 1 WHERE id = $1',
    ];
    for (const pool of [app, admin])
      for (const sql of tampering)
        await expect(pool.query(sql, [receipt.id])).rejects.toThrow(
          /immutable/i,
        );
    const after = await currentReceipt(app, {
      ownerId: scope.ownerId,
      environment: scope.environment,
      resource: scope.resource,
      key: 'checkout.health',
    });
    expect(after).toEqual(receipt);
  });

  it('allows only the contract status transitions, and a superseded receipt never regains support', async () => {
    const scope = newScope();
    const first = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    await registerObserved(scope, 'checkout.health', HEALTH_DEGRADED);
    const { admin } = getDb();
    await expect(
      admin.query(
        "UPDATE ledger.observation_receipts SET status = 'supported', status_version = status_version + 1 WHERE id = $1",
        [first.receipt.id],
      ),
    ).rejects.toThrow(/immutable.*illegal status transition/i);
  });

  it('confirmations, transitions, revisions and edges are append-only', async () => {
    const scope = newScope();
    const first = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    await registerObserved(scope, 'checkout.health', HEALTH_OK); // confirmation
    await registerObserved(scope, 'checkout.health', HEALTH_DEGRADED); // transition
    const { app } = getDb();
    for (const table of [
      'receipt_confirmations',
      'receipt_transitions',
      'source_revisions',
    ]) {
      await expect(app.query(`DELETE FROM ledger.${table}`)).rejects.toThrow(
        /append-only/,
      );
      await expect(
        app.query(`UPDATE ledger.${table} SET receipt_id = receipt_id`),
      ).rejects.toThrow(/append-only/);
    }
    expect(
      await count(
        app,
        'SELECT count(*) AS n FROM ledger.receipt_confirmations WHERE receipt_id = $1',
        [first.receipt.id],
      ),
    ).toBe(1);
  });
});

describe('malformed and oversized observations fail safely', () => {
  it('writes nothing for a bad key, a digest/revision claim that disagrees, or an oversize value', async () => {
    const scope = newScope();
    const { app } = getDb();
    const before = await count(
      app,
      'SELECT count(*) AS n FROM ledger.observation_receipts',
    );
    await expect(
      registerObserved(scope, 'billing.ledger', HEALTH_OK),
    ).rejects.toBeInstanceOf(InvalidSourceKeyError);
    await expect(
      registerObserved(scope, 'checkout.metrics', { blob: 'x'.repeat(16_400) }),
    ).rejects.toBeInstanceOf(ObservationTooLargeError);
    await expect(
      registerObserved(scope, 'checkout.metrics', HEALTH_OK, {
        claimed: { contentDigest: digest({ other: true }) },
      }),
    ).rejects.toBeInstanceOf(DigestMismatchError);
    await expect(
      registerObserved(scope, 'checkout.metrics', HEALTH_OK, {
        claimed: { sourceRevision: 7 },
      }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(
      await count(app, 'SELECT count(*) AS n FROM ledger.observation_receipts'),
    ).toBe(before);
  });

  it('accepts a value of exactly 16 KiB canonical and refuses one byte more', async () => {
    const scope = newScope();
    const filler = (bytes: number) => ({
      blob: 'x'.repeat(bytes - '{"blob":""}'.length),
    });
    expect(Buffer.byteLength(JSON.stringify(filler(16_384)))).toBe(16_384);
    const ok = await registerObserved(
      scope,
      'checkout.metrics',
      filler(16_384),
    );
    expect(ok.receipt.sourceRevision).toBe(1);
    await expect(
      registerObserved(scope, 'checkout.metrics', filler(16_385)),
    ).rejects.toBeInstanceOf(ObservationTooLargeError);
  });
});

describe('sources are scoped by owner, environment, resource and key', () => {
  it('the same key in two environments or owners is two sources with independent revisions', async () => {
    const testScope = newScope('test');
    const evalScope = { ...testScope, environment: 'eval' as const };
    const otherOwner = { ...testScope, ownerId: `owner-${randomUUID()}` };
    const t1 = await registerObserved(testScope, 'checkout.health', HEALTH_OK);
    const e1 = await registerObserved(evalScope, 'checkout.health', HEALTH_OK);
    const o1 = await registerObserved(otherOwner, 'checkout.health', HEALTH_OK);
    const t2 = await registerObserved(
      testScope,
      'checkout.health',
      HEALTH_DEGRADED,
    );
    expect([
      t1.receipt.sourceRevision,
      e1.receipt.sourceRevision,
      o1.receipt.sourceRevision,
    ]).toEqual([1, 1, 1]);
    expect(t2.receipt.sourceRevision).toBe(2);
    const { rows: statusRows } = await getDb().app.query<{
      id: string;
      status: string;
    }>(
      'SELECT id, status FROM ledger.observation_receipts WHERE id = ANY($1::uuid[])',
      [[t1.receipt.id, e1.receipt.id, o1.receipt.id, t2.receipt.id]],
    );
    const statusOf = new Map(statusRows.map((row) => [row.id, row.status]));
    expect([t1, e1, o1, t2].map((r) => statusOf.get(r.receipt.id))).toEqual([
      'superseded',
      'supported',
      'supported',
      'supported',
    ]);
    expect(
      await count(
        getDb().app,
        'SELECT count(DISTINCT source_id) AS n FROM ledger.observation_receipts WHERE id = ANY($1::uuid[])',
        [[t1.receipt.id, e1.receipt.id, o1.receipt.id]],
      ),
    ).toBe(3);
  });
});

describe('observed sources', () => {
  it('a different digest mints revision current+1, supersedes with a transition row and links both ways', async () => {
    const scope = newScope();
    const r1 = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    const r2 = await registerObserved(
      scope,
      'checkout.health',
      HEALTH_DEGRADED,
    );
    expect(r1.newRevision && r2.newRevision).toBe(true);
    expect(r2.receipt.sourceRevision).toBe(2);
    expect(r2.receipt.supersedes).toBe(r1.receipt.id);
    expect(r2.supersededReceiptId).toBe(r1.receipt.id);
    const old = await currentReceipt(getDb().app, {
      ownerId: scope.ownerId,
      environment: scope.environment,
      resource: scope.resource,
      key: 'checkout.health',
    });
    expect(old!.id).toBe(r2.receipt.id);
    const transitions = await listTransitions(getDb().app, r1.receipt.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: 'supported',
      to: 'superseded',
      reason: 'newer_observation',
    });
    expect(ReceiptTransitionSchema.safeParse(transitions[0]).success).toBe(
      true,
    );
    const { rows } = await getDb().app.query(
      'SELECT status, status_version, superseded_by FROM ledger.observation_receipts WHERE id = $1',
      [r1.receipt.id],
    );
    expect(rows[0]).toEqual({
      status: 'superseded',
      status_version: 1,
      superseded_by: r2.receipt.id,
    });
    expect(r2.invalidation).not.toBeNull();
    expect(r2.invalidation!.reason).toBe('newer_observation');
  });

  it('same-digest re-observation mints no revision, appends a confirmation and advances lastConfirmedAt', async () => {
    const scope = newScope();
    const old = new Date(Date.now() - 10 * 60_000);
    const first = await registerObserved(scope, 'checkout.health', HEALTH_OK, {
      observedAt: old,
    });
    expect(first.receipt.lastConfirmedAt).toBe(first.receipt.observedAt);
    const again = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    expect(again.newRevision).toBe(false);
    expect(again.confirmation).not.toBeNull();
    expect(again.receipt.id).toBe(first.receipt.id);
    expect(again.receipt.sourceRevision).toBe(1);
    expect(Date.parse(again.receipt.lastConfirmedAt)).toBeGreaterThan(
      Date.parse(first.receipt.lastConfirmedAt),
    );
    expect(again.receipt.observedAt).toBe(first.receipt.observedAt);
    const confirmations = await listConfirmations(
      getDb().app,
      first.receipt.id,
    );
    expect(confirmations).toHaveLength(1);
    expect(ReceiptConfirmationSchema.safeParse(confirmations[0]).success).toBe(
      true,
    );
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.observation_receipts WHERE id = $1 OR supersedes = $1',
        [first.receipt.id],
      ),
    ).toBe(1);
  });

  it('the very same value, five more times: one receipt, five confirmations', async () => {
    const scope = newScope();
    const first = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    for (let i = 0; i < 5; i += 1) {
      const again = await registerObserved(scope, 'checkout.health', HEALTH_OK);
      expect(again.receipt.sourceRevision).toBe(1);
    }
    expect(await listConfirmations(getDb().app, first.receipt.id)).toHaveLength(
      5,
    );
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.source_revisions WHERE receipt_id = $1',
        [first.receipt.id],
      ),
    ).toBe(1);
  });

  it('a claimed revision older than the one assignable is a stale observation', async () => {
    const scope = newScope();
    await registerObserved(scope, 'checkout.health', HEALTH_OK);
    await registerObserved(scope, 'checkout.health', HEALTH_DEGRADED);
    await expect(
      registerObserved(scope, 'checkout.health', HEALTH_OK, {
        claimed: { sourceRevision: 1 },
      }),
    ).rejects.toBeInstanceOf(StaleObservationRejectedError);
  });

  it('a contested head is retracted by a differing observation; the old receipt never regains support', async () => {
    const scope = newScope();
    const first = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    await inTx(getDb().app, (client) =>
      transitionReceipt(
        client,
        {
          receiptId: first.receipt.id,
          to: 'contested',
          reason: 'conflicting_observation',
        },
        opts,
      ),
    );
    const second = await registerObserved(
      scope,
      'checkout.health',
      HEALTH_DEGRADED,
    );
    expect(second.receipt.supersedes).toBe(first.receipt.id);
    const transitions = await listTransitions(getDb().app, first.receipt.id);
    expect(transitions.map((t) => `${t.from}>${t.to}`)).toEqual([
      'supported>contested',
      'contested>retracted',
    ]);
    // re-observing the contested value mints a new revision instead of reviving it
    const third = await registerObserved(scope, 'checkout.health', HEALTH_OK);
    expect(third.receipt.sourceRevision).toBe(3);
    expect(third.receipt.id).not.toBe(first.receipt.id);
  });
});

describe('controlled sources take their revision from the authority', () => {
  it('revision = authority version; a re-observation of the same version confirms; a value change mints one revision', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await registerMember(scope, 'db.pool_max');
    expect(r1.receipt.sourceRevision).toBe(1);
    expect(r1.receipt.collectionRevision).toBe(2); // one insert bumped the collection to 2
    expect(r1.receipt.trust).toBe('controlled_authority');
    const same = await registerMember(scope, 'db.pool_max');
    expect(same.newRevision).toBe(false);
    expect(same.confirmation).not.toBeNull();
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 5));
    const r2 = await registerMember(scope, 'db.pool_max');
    expect(r2.receipt.sourceRevision).toBe(2);
    expect(r2.supersededReceiptId).toBe(r1.receipt.id);
  });

  it('refuses a claimed revision that is behind (late delivery) or ahead of the authority, writing nothing', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await registerMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 6));
    const r2 = await registerMember(scope, 'db.pool_max');
    const before = await count(
      getDb().app,
      'SELECT count(*) AS n FROM ledger.observation_receipts',
    );
    const attempt = (claimed: number) =>
      inTx(getDb().app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.config/db.pool_max'),
            normalizedValue: { key: 'db.pool_max', value: 3, version: 1 },
            provenance: { kind: 'watcher' },
            claimed: { sourceRevision: claimed },
          },
          opts,
        ),
      );
    await expect(attempt(r1.receipt.sourceRevision)).rejects.toBeInstanceOf(
      StaleObservationRejectedError,
    );
    await expect(attempt(999)).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.observation_receipts',
      ),
    ).toBe(before);
    const head = await currentReceipt(getDb().app, {
      ownerId: scope.ownerId,
      environment: scope.environment,
      resource: scope.resource,
      key: 'checkout.config/db.pool_max',
    });
    expect(head!.id).toBe(r2.receipt.id);
    expect(head!.status).toBe('supported');
  });

  it('a value registered twice for one version with different contents is a digest mismatch', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    await registerMember(scope, 'db.pool_max');
    await expect(
      inTx(getDb().app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.config/db.pool_max'),
            normalizedValue: { key: 'db.pool_max', value: 99, version: 1 },
            provenance: { kind: 'watcher' },
          },
          opts,
        ),
      ),
    ).rejects.toBeInstanceOf(DigestMismatchError);
  });

  it('ABA: A -> B -> A mints a third revision; the first A stays superseded', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const a1 = await registerMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 7));
    const b = await registerMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 3));
    const a2 = await registerMember(scope, 'db.pool_max');
    expect([a1, b, a2].map((r) => r.receipt.sourceRevision)).toEqual([1, 2, 3]);
    expect(a1.receipt.contentDigest).not.toBe(a2.receipt.contentDigest); // the version is inside the value
    const { rows } = await getDb().app.query<{ status: string }>(
      'SELECT status FROM ledger.observation_receipts WHERE id = ANY($1::uuid[]) ORDER BY source_revision',
      [[a1.receipt.id, b.receipt.id, a2.receipt.id]],
    );
    expect(rows.map((r) => r.status)).toEqual([
      'superseded',
      'superseded',
      'supported',
    ]);
  });

  it('registers a controlled key that is not in the authority as a missing source', async () => {
    const scope = newScope();
    await expect(
      inTx(getDb().app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.config/no.such_key'),
            normalizedValue: { key: 'no.such_key', value: 1, version: 1 },
            provenance: { kind: 'watcher' },
          },
          opts,
        ),
      ),
    ).rejects.toThrow(/no row in the authority/);
  });

  it('stores causedByActionId and selfWrite as given and never derives them', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const actionId = randomUUID();
    const result = await inTx(getDb().app, async (client) => {
      const read = await readMember(client, 'db.pool_max');
      return registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: read.normalizedValue,
          provenance: {
            kind: 'commit_postcondition',
            causedByActionId: actionId as never,
            selfWrite: 'verified',
          },
        },
        opts,
      );
    });
    expect(result.receipt.provenance).toMatchObject({
      causedByActionId: actionId,
      selfWrite: 'verified',
    });
    const { rows } = await getDb().app.query<{ caused_by_action_id: string }>(
      'SELECT caused_by_action_id FROM ledger.source_revisions WHERE receipt_id = $1',
      [result.receipt.id],
    );
    expect(rows[0].caused_by_action_id).toBe(actionId);
    // the plain registration right after carries none
    const plain = await registerObserved(
      newScope(),
      'checkout.health',
      HEALTH_OK,
    );
    expect(plain.receipt.provenance).toMatchObject({
      causedByActionId: null,
      selfWrite: 'none',
    });
  });
});

describe('ReceiptNotRegistrable', () => {
  it('re-observing a retracted controlled receipt at the same version is refused until the authority advances', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const r1 = await registerMember(scope, 'db.pool_max');
    await inTx(getDb().app, (client) =>
      transitionReceipt(
        client,
        {
          receiptId: r1.receipt.id,
          to: 'retracted',
          reason: 'owner_retraction',
        },
        opts,
      ),
    );
    await expect(registerMember(scope, 'db.pool_max')).rejects.toBeInstanceOf(
      ReceiptNotRegistrableError,
    );
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 4));
    const r2 = await registerMember(scope, 'db.pool_max');
    expect(r2.receipt.sourceRevision).toBe(2);
    expect(r2.supersededReceiptId).toBeNull(); // the retracted head is not superseded again
    expect(r2.receipt.supersedes).toBe(r1.receipt.id);
  });
});
