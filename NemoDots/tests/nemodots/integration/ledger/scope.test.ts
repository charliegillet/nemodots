// Scope isolation (F4) and Space identity (F4b, CONTRACTS section 1 revision 3).
// A receipt supports work in mission M only if its source's owner, environment,
// Space and resource all equal M's scope; the source identity is
// (owner, environment, space, resource, key) with a null Space as one value.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  sha256Hex,
  type ContextSnapshot,
  type ModelCallRecord,
  type ObservationReceipt,
  type SourceRef,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  SupportError,
  assertCurrent,
  recordModelCall,
  recordReadSet,
  registerObservation,
  getReceipt,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  FX,
  count,
  ensureMission,
  inTx,
  registerReal,
  missionScope,
  newScope,
  readMember,
  resetAuthority,
  seedConfig,
  sourceRef,
  updateConfig,
  useLedgerDb,
  type TestScope,
} from './fixtures.js';

const getDb = useLedgerDb();

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

type Dimension = 'owner' | 'environment' | 'resource' | 'space';

/** A ref of `base` that differs from it in exactly one dimension. */
function refDiffering(
  base: TestScope,
  key: string,
  dimension: Dimension | null,
  spaceId: string | null = null,
): SourceRef {
  const ref = sourceRef(base, key);
  const scope = { ...ref.scope, spaceId } as Record<string, unknown>;
  if (dimension === 'owner') scope.ownerId = `${base.ownerId}-other`;
  if (dimension === 'environment') scope.environment = 'eval';
  if (dimension === 'resource') scope.resource = 'billing';
  if (dimension === 'space') scope.spaceId = 'space-b';
  return { ...ref, scope } as unknown as SourceRef;
}

const register = (ref: SourceRef, value: unknown) =>
  inTx(getDb().app, (client) =>
    registerObservation(
      client,
      { source: ref, normalizedValue: value, provenance: { kind: 'watcher' } },
      { ledger: FX, marker: null },
    ),
  );

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

async function callFor(scope: TestScope, receipt: ObservationReceipt) {
  const vector = [
    {
      sourceKey: receipt.source.key,
      sourceRevision: receipt.sourceRevision,
      receiptId: receipt.id,
    },
  ];
  const snapshot = {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: sha256Hex('prefix'),
    prefixLength: 10,
    contextDigest: sha256Hex(`c-${randomUUID()}`),
    contextLength: 40,
    toolSchemaHash: sha256Hex('tools'),
    injected: {
      receipts: [
        {
          id: receipt.id,
          sourceKey: receipt.source.key,
          sourceRevision: receipt.sourceRevision,
          contentDigest: receipt.contentDigest,
        },
      ],
      inheritedArtifacts: [],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: vector,
    volatile: { nowIso: iso() },
  } as unknown as ContextSnapshot;
  const taskId = randomUUID();
  const attemptId = randomUUID();
  await getDb().admin.query(
    `INSERT INTO fx_coordinator.task_attempts (id, task_id, mission_id, status) VALUES ($1, $2, $3, 'running')`,
    [attemptId, taskId, scope.missionId],
  );
  const record = {
    id: randomUUID(),
    scope: { ...sourceRef(scope, 'checkout.health').scope },
    taskId,
    attemptId,
    role: 'worker',
    model: { requested: 'm', returned: 'm' },
    provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts: [
      {
        n: 1,
        startedAt: iso(-2000),
        headersAt: iso(-1500),
        firstContentAt: iso(-1400),
        finishedAt: iso(-1000),
        httpStatus: 200,
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: null,
          reasoningTokens: 0,
        },
        finishReason: 'stop',
        error: null,
        retryAfterMs: null,
        streamed: false,
        outcome: 'recorded',
      },
    ],
    outcome: 'completed',
    outputDigest: sha256Hex('o'),
    outputDependencyVector: vector,
    toolCalls: [],
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  return { snapshot, record };
}

const rowsWritten = async (receiptId: string, recordId: string) => ({
  edges: await count(
    getDb().app,
    'SELECT count(*) AS n FROM ledger.dependency_edges WHERE from_id = $1',
    [receiptId],
  ),
  records: await count(
    getDb().app,
    'SELECT count(*) AS n FROM ledger.model_call_records WHERE id = $1',
    [recordId],
  ),
});

describe.each<Dimension>(['owner', 'environment', 'resource', 'space'])(
  'a receipt from another %s cannot support the mission',
  (dimension) => {
    it('assertCurrent, recordReadSet and recordModelCall refuse it and write nothing; the same scope is accepted', async () => {
      const mission = newScope();
      const scope = missionScope(mission);
      const foreign = (
        await register(refDiffering(mission, 'checkout.health', dimension), {
          status: 'ok',
        })
      ).receipt;
      const same = (
        await register(refDiffering(mission, 'checkout.health', null), {
          status: 'ok',
        })
      ).receipt;
      expect(foreign.id).not.toBe(same.id);

      const refused = async (run: () => Promise<unknown>) => {
        const error = await run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SupportError);
        expect((error as SupportError).reason).toBe('citation_out_of_scope');
        expect((error as SupportError).detail).toContain(dimension);
      };

      await refused(() =>
        inTx(getDb().app, (client) =>
          assertCurrent(
            client,
            [foreign.id],
            { lockMode: 'share', missionId: mission.missionId, scope },
            FX,
          ),
        ),
      );
      const attempt = { taskId: randomUUID(), attemptId: randomUUID() };
      await refused(() =>
        inTx(getDb().app, (client) =>
          recordReadSet(
            client,
            {
              missionId: mission.missionId,
              ...attempt,
              receiptIds: [foreign.id],
              scope,
            },
            FX,
          ),
        ),
      );
      const bad = await callFor(mission, foreign);
      await refused(() =>
        inTx(getDb().app, (client) => recordModelCall(client, bad, FX)),
      );
      expect(await rowsWritten(foreign.id, bad.record.id)).toEqual({
        edges: 0,
        records: 0,
      });
      expect(
        await count(
          getDb().app,
          'SELECT count(*) AS n FROM ledger.dependency_edges WHERE to_id = $1',
          [attempt.attemptId],
        ),
      ).toBe(0);

      // a vector mixing a good and a foreign receipt is refused as a whole
      await refused(() =>
        inTx(getDb().app, (client) =>
          assertCurrent(
            client,
            [same.id, foreign.id],
            { lockMode: 'share', missionId: mission.missionId, scope },
            FX,
          ),
        ),
      );

      // same scope: accepted everywhere
      await inTx(getDb().app, async (client) => {
        await assertCurrent(
          client,
          [same.id],
          { lockMode: 'share', missionId: mission.missionId, scope },
          FX,
        );
        await recordReadSet(
          client,
          {
            missionId: mission.missionId,
            ...attempt,
            receiptIds: [same.id],
            scope,
          },
          FX,
        );
      });
      const good = await callFor(mission, same);
      const stored = await inTx(getDb().app, (client) =>
        recordModelCall(client, good, FX),
      );
      expect(stored.created).toBe(true);
    });
  },
);

describe('the mission scope is the server row, not the caller', () => {
  it('a claimed scope that disagrees with coordinator.missions is refused', async () => {
    const { admin, app } = getDb();
    const mission = newScope();
    // the real default-schema coordinator.missions row for this mission
    await admin.query(
      `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
       VALUES ($1, $2, 'test', 'checkout', 'scope test', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
      [mission.missionId, mission.ownerId],
    );
    const receipt = (
      await inTx(app, (client) =>
        registerReal(client, {
          source: sourceRef(mission, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
        }),
      )
    ).receipt;
    // honest claim: accepted
    await inTx(app, (client) =>
      assertCurrent(client, [receipt.id], {
        lockMode: 'share',
        missionId: mission.missionId,
      }),
    );
    // a forged claim naming the receipt's scope for a mission of another owner
    const other = newScope();
    await admin.query(
      `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
       VALUES ($1, $2, 'test', 'checkout', 'other owner', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
      [other.missionId, other.ownerId],
    );
    const error = await inTx(app, (client) =>
      assertCurrent(client, [receipt.id], {
        lockMode: 'share',
        missionId: other.missionId,
        scope: missionScope(mission),
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('citation_out_of_scope');
    // and without a claim the stored mission row decides
    const decided = await inTx(app, (client) =>
      assertCurrent(client, [receipt.id], {
        lockMode: 'share',
        missionId: other.missionId,
      }),
    ).catch((e: unknown) => e);
    expect((decided as SupportError).reason).toBe('citation_out_of_scope');
  });

  it('an unknown mission is refused even when the caller claims the right scope, and nothing is written', async () => {
    const mission = newScope();
    const receipt = (
      await register(refDiffering(mission, 'checkout.health', null), {
        status: 'ok',
      })
    ).receipt;
    const unknown = randomUUID();
    const attempt = { taskId: randomUUID(), attemptId: randomUUID() };
    for (const run of [
      (client: import('pg').PoolClient) =>
        assertCurrent(
          client,
          [receipt.id],
          {
            lockMode: 'update',
            missionId: unknown,
            scope: missionScope(mission),
          },
          FX,
        ),
      (client: import('pg').PoolClient) =>
        recordReadSet(
          client,
          {
            missionId: unknown,
            ...attempt,
            receiptIds: [receipt.id],
            scope: missionScope(mission),
          },
          FX,
        ),
    ]) {
      const error = await inTx(getDb().app, async (client) => {
        await run(client);
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupportError);
      expect((error as SupportError).reason).toBe('citation_out_of_scope');
      expect((error as SupportError).detail).toContain('unknown');
    }
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.dependency_edges WHERE to_id = $1',
        [attempt.attemptId],
      ),
    ).toBe(0);
    // nothing stayed locked: the receipt row can be taken NOWAIT right away
    await inTx(getDb().admin, async (client) => {
      await client.query(
        'SELECT 1 FROM ledger.observation_receipts WHERE id = $1 FOR UPDATE NOWAIT',
        [receipt.id],
      );
    });
  });

  it('an unknown mission with no claim fails closed', async () => {
    const mission = newScope();
    const receipt = (
      await register(refDiffering(mission, 'checkout.health', null), {
        status: 'ok',
      })
    ).receipt;
    const error = await inTx(getDb().app, (client) =>
      assertCurrent(
        client,
        [receipt.id],
        { lockMode: 'share', missionId: randomUUID() },
        FX,
      ),
    ).catch((e: unknown) => e);
    expect((error as SupportError).reason).toBe('citation_out_of_scope');
  });
});

describe('source identity includes the Space (F4b)', () => {
  it('owner, environment, Space, resource and key each make a different source', async () => {
    const base = newScope();
    const variants = [
      refDiffering(base, 'checkout.health', null),
      refDiffering(base, 'checkout.health', 'owner'),
      refDiffering(base, 'checkout.health', 'environment'),
      refDiffering(base, 'checkout.health', 'space'),
      refDiffering(base, 'checkout.health', 'resource'),
      refDiffering(base, 'checkout.metrics', null),
    ];
    const receipts = [];
    for (const ref of variants)
      receipts.push((await register(ref, { status: 'ok' })).receipt);
    const sources = await getDb().admin.query(
      'SELECT DISTINCT source_id FROM ledger.observation_receipts WHERE id = ANY($1::uuid[])',
      [receipts.map((r) => r.id)],
    );
    expect(sources.rows).toHaveLength(6);
    expect(receipts.every((r) => r.sourceRevision === 1)).toBe(true);
  });

  it('a registration in Space B never supersedes the receipt of Space A, and null is one Space', async () => {
    const base = newScope();
    const a = (
      await register(refDiffering(base, 'checkout.health', null, 'space-a'), {
        status: 'ok',
      })
    ).receipt;
    const b = await register(
      refDiffering(base, 'checkout.health', null, 'space-b'),
      { status: 'down' },
    );
    expect(b.newRevision).toBe(true);
    expect(b.supersededReceiptId).toBeNull();
    expect(b.receipt.sourceRevision).toBe(1);
    expect((await getReceipt(getDb().app, a.id)).status).toBe('supported');
    expect(a.source.scope.spaceId).toBe('space-a');
    expect(b.receipt.source.scope.spaceId).toBe('space-b');

    // two registrations without a Space are the same source (NULLS NOT DISTINCT)
    const n1 = await register(refDiffering(base, 'checkout.health', null), {
      status: 'ok',
    });
    const n2 = await register(refDiffering(base, 'checkout.health', null), {
      status: 'down',
    });
    expect(n2.receipt.sourceRevision).toBe(2);
    expect(n2.supersededReceiptId).toBe(n1.receipt.id);
    expect(
      await count(
        getDb().admin,
        'SELECT count(*) AS n FROM ledger.sources WHERE owner_id = $1 AND space_id IS NULL',
        [base.ownerId],
      ),
    ).toBe(1);
  });

  it('controlled config in two Spaces reads the same authority version but keeps one receipt per source', async () => {
    const base = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const member = (space: string | null) =>
      inTx(getDb().app, async (client) => {
        const read = await readMember(client, 'db.pool_max');
        return registerObservation(
          client,
          {
            source: refDiffering(
              base,
              'checkout.config/db.pool_max',
              null,
              space,
            ),
            normalizedValue: read.normalizedValue,
            provenance: { kind: 'watcher' },
          },
          { ledger: FX, marker: null },
        );
      });
    const a = await member('space-a');
    const b = await member('space-b');
    expect(a.receipt.id).not.toBe(b.receipt.id);
    expect(a.receipt.sourceRevision).toBe(1);
    expect(b.receipt.sourceRevision).toBe(1);

    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 4));
    const a2 = await member('space-a');
    expect(a2.receipt.sourceRevision).toBe(2);
    expect(a2.supersededReceiptId).toBe(a.receipt.id);
    // Space B's receipt is untouched by Space A's registration
    expect((await getReceipt(getDb().app, b.receipt.id)).status).toBe(
      'supported',
    );
    // it is nevertheless stale against the shared authority (fails closed)
    const missionB = randomUUID();
    await ensureMission(missionB, {
      ownerId: base.ownerId,
      environment: base.environment,
      spaceId: 'space-b',
      resource: base.resource,
    });
    const error = await inTx(getDb().app, (client) =>
      assertCurrent(
        client,
        [b.receipt.id],
        { lockMode: 'share', missionId: missionB },
        FX,
      ),
    ).catch((e: unknown) => e);
    expect((error as SupportError).reason).toBe('stale_pending_observation');
  });
});
