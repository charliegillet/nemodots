// The collector maps database rows to plain observations. The SQL itself is
// exercised against a real stack by the live smoke; here a scripted Queryable
// answers each statement (matched by a fragment of its text) so the row mapping
// is pinned.
import { describe, expect, it } from 'vitest';
import {
  collectObservations,
  type Queryable,
} from '../../../src/server/nemodots/evals/collect.js';

type Handler = [RegExp, Record<string, unknown>[]];
function fakeDb(handlers: Handler[]): Queryable & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async query<R>(text: string) {
      texts.push(text);
      const hit = handlers.find(([pattern]) => pattern.test(text));
      return { rows: (hit ? hit[1] : []) as R[] };
    },
  };
}

const T = (s: number) =>
  new Date(Date.parse('2026-10-18T10:00:00Z') + s * 1000);

const handlers: Handler[] = [
  [/SELECT DISTINCT s\.layout/, [{ layout: 'ordinary' }]],
  [
    /FROM coordinator\.missions/,
    [{ status: 'succeeded', recovery_scope_rule: 'dag-restart' }],
  ],
  [
    /FROM coordinator\.tasks t/,
    [
      {
        id: 't1',
        parent_id: null,
        role: 'investigator',
        status: 'succeeded',
        prerequisites: [],
        output_id: 'o1',
        attempt_count: 2,
        output_usable: true,
      },
      {
        id: 't2',
        parent_id: 't1',
        role: 'verifier',
        status: 'failed',
        prerequisites: ['t1'],
        output_id: null,
        attempt_count: 1,
        output_usable: null,
      },
    ],
  ],
  [
    /FROM coordinator\.task_attempts/,
    [
      {
        id: 'a1',
        task_id: 't1',
        kind: 'repair',
        status: 'published',
        repair_of: { attemptId: 'a0', invalidationEventId: 'e1' },
        started_at: T(5),
        finished_at: T(9),
      },
    ],
  ],
  [
    /FROM ledger\.dependency_nodes/,
    [
      { kind: 'attempt', id: 'a1', mission_id: 'm', task_id: 't1' },
      { kind: 'receipt', id: 'r1', mission_id: null, task_id: null },
    ],
  ],
  [
    /FROM ledger\.dependency_edges/,
    [
      {
        kind: 'evidence',
        from_kind: 'receipt',
        from_id: 'r1',
        to_kind: 'attempt',
        to_id: 'a1',
        created_at: T(1),
      },
    ],
  ],
  [
    /FROM ledger\.invalidation_events/,
    [
      {
        id: 'e1',
        source_key: 'checkout.config/cache.schema_version',
        reason: 'newer_observation',
        self_write: 'none',
        old_receipt_id: 'r1',
        new_receipt_id: 'r2',
        created_at: T(4),
        per_mission: [
          { missionId: 'other', affected: { attemptIds: ['zzz'] } },
          { missionId: 'm', affected: { attemptIds: ['a1'], taskIds: ['t1'] } },
        ],
        closure: { depth: 2, nodes: 3, capped: false },
      },
      {
        id: 'e2',
        source_key: 'checkout.health',
        reason: 'closure_cap_exceeded',
        self_write: 'none',
        old_receipt_id: 'r9',
        new_receipt_id: null,
        created_at: T(6),
        per_mission: [],
        closure: { capped: true },
      },
    ],
  ],
  [
    /FROM coordinator\.action_intents/,
    [
      {
        id: 'i1',
        task_id: 't1',
        attempt_id: 'a1',
        action: 'set_config',
        payload: {
          key: 'cache.schema_version',
          value: 1,
          expectedCurrentValueDigest: 'x',
        },
        status: 'verified',
        block_reason: null,
        failure_reason: null,
        expected_target_version: 5,
        idempotency_key: 'k1',
        payload_hash: 'h1',
        proposed_at: T(10),
        admitted_at: T(11),
        committed_at: T(12),
        verified_at: T(13),
      },
      {
        id: 'i2',
        task_id: 't1',
        attempt_id: 'a1',
        action: 'flush_cache_namespace',
        payload: { namespace: 'ns', reason: 'r' },
        status: 'blocked',
        block_reason: 'stale_version',
        failure_reason: null,
        expected_target_version: 1,
        idempotency_key: 'k2',
        payload_hash: 'h2',
        proposed_at: T(10),
        admitted_at: null,
        committed_at: null,
        verified_at: null,
      },
    ],
  ],
  [
    /FROM coordinator\.authorizations/,
    [
      {
        action_id: 'i2',
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
        decided_at: T(11),
        checked_vector: [
          {
            sourceKey: 'checkout.config/cache.namespace',
            recordedRevision: 1,
            liveRevision: 2,
            receiptStatus: 'superseded',
            freshnessOk: true,
          },
        ],
        author_fence: { token: 1, valid: true },
        dispatch_fence: null,
      },
    ],
  ],
  [
    /FROM coordinator\.result_receipts/,
    [
      {
        action_id: 'i1',
        outcome: 'verified',
        external_effect: { scriptResult: 'applied' },
      },
    ],
  ],
  [
    /FROM checkout\.config_versions/,
    [
      {
        key: 'cache.schema_version',
        version: 2,
        value: 2,
        caused_by_action_id: null,
        caused_by_actor: 'injector',
        at: T(2),
      },
      {
        key: 'cache.schema_version',
        version: 3,
        value: 1,
        caused_by_action_id: 'i1',
        caused_by_actor: 'action',
        at: T(12),
      },
    ],
  ],
  [/count\(\*\) FILTER/, [{ mismatches: '1', fixture: '2' }]],
  [
    /min\(started_at\) AS first_started/,
    [{ first_started: T(3), inference_ms: '2500.5' }],
  ],
  [/FROM ledger\.tool_spans/, [{ tool_ms: '800' }]],
];

const collect = (db: Queryable, live = true) =>
  collectObservations({
    db,
    missionId: 'm',
    startedAt: T(0).toISOString(),
    endedAt: T(60).toISOString(),
    providerHost: 'api.example.test',
    live,
    independent: { probe: 'pass', failedInvariants: [], healthOk: true },
  });

describe('collectObservations', () => {
  it('maps tasks, attempts, edges, nodes and intents to plain records', async () => {
    const obs = await collect(fakeDb(handlers));
    expect(obs.missionStatus).toBe('succeeded');
    expect(obs.tasks).toEqual([
      {
        id: 't1',
        parentId: null,
        role: 'investigator',
        status: 'succeeded',
        prerequisites: [],
        outputId: 'o1',
        outputUsable: true,
        attemptCount: 2,
      },
      {
        id: 't2',
        parentId: 't1',
        role: 'verifier',
        status: 'failed',
        prerequisites: ['t1'],
        outputId: null,
        outputUsable: null,
        attemptCount: 1,
      },
    ]);
    expect(obs.attempts[0]).toMatchObject({
      id: 'a1',
      kind: 'repair',
      repairOfEventId: 'e1',
      finishedAt: T(9).toISOString(),
    });
    expect(obs.edges[0]).toMatchObject({
      kind: 'evidence',
      fromId: 'r1',
      toId: 'a1',
      createdAt: T(1).toISOString(),
    });
    expect(obs.nodes.map((n) => n.kind)).toEqual(['attempt', 'receipt']);
    expect(obs.intents[0].target).toEqual({
      key: 'cache.schema_version',
      value: 1,
    });
    expect(obs.intents[1]).toMatchObject({
      action: 'flush_cache_namespace',
      target: { key: 'cache.namespace', value: 'ns' },
      blockReason: 'stale_version',
      admittedAt: null,
    });
  });

  it("takes only this mission's subset of an invalidation event and flags capped closures", async () => {
    const obs = await collect(fakeDb(handlers));
    expect(obs.invalidations[0].affected).toEqual({
      modelCallIds: [],
      attemptIds: ['a1'],
      outputIds: [],
      actionIds: [],
      taskIds: ['t1'],
    });
    expect(obs.invalidations[0].capped).toBe(false);
    expect(obs.invalidations[1]).toMatchObject({
      capped: true,
      newReceiptId: null,
    });
    expect(obs.invalidations[1].affected.attemptIds).toEqual([]);
  });

  it('maps authorizations, results and the version history (actor kept for the oracle only)', async () => {
    const obs = await collect(fakeDb(handlers));
    expect(obs.authorizations[0]).toMatchObject({
      actionId: 'i2',
      decision: 'blocked',
      authorFenceValid: true,
      dispatchFenceValid: null,
    });
    expect(obs.authorizations[0].checkedVector[0]).toMatchObject({
      recordedRevision: 1,
      liveRevision: 2,
    });
    expect(obs.results).toEqual([
      { actionId: 'i1', outcome: 'verified', scriptResult: 'applied' },
    ]);
    expect(
      obs.configHistory.map((r) => [r.version, r.actor, r.causedByActionId]),
    ).toEqual([
      [2, 'injector', null],
      [3, 'action', 'i1'],
    ]);
  });

  it('timing: setup, inference-seconds and tool time come from rows; missing marks are null, not 0', async () => {
    const obs = await collect(fakeDb(handlers));
    expect(obs.timing.setupMs).toBe(3000);
    expect(obs.timing.inferenceMs).toBeCloseTo(2500.5);
    expect(obs.timing.toolMs).toBe(800);
    expect(obs.timing.recoveryMs).toBeNull();
    // no marks: completion falls back to the harness's wall clock
    expect(obs.timing.completionMs).toBe(60000);
  });

  it('provider mismatches and fixture calls are counted only for live trials', async () => {
    expect((await collect(fakeDb(handlers))).telemetry).toMatchObject({
      providerMismatches: 1,
      fixtureCalls: 2,
    });
    expect((await collect(fakeDb(handlers), false)).telemetry).toMatchObject({
      providerMismatches: 0,
      fixtureCalls: 0,
    });
  });

  it('reads no prompts or completions', async () => {
    const db = fakeDb(handlers);
    await collect(db);
    const sql = db.texts.join('\n');
    expect(sql).not.toMatch(
      /normalized_value|\bcontent\b|\bmessages\b|rationale|output_digest/,
    );
    expect(sql).not.toMatch(/control\./);
  });

  it('records what the database says the mission ran under (arm integrity)', async () => {
    const obs = await collect(fakeDb(handlers));
    expect(obs.arm).toEqual({
      recoveryScopeRule: 'dag-restart',
      contextLayouts: ['ordinary'],
    });
  });

  it('an empty mission yields empty collections and zero telemetry', async () => {
    const obs = await collect(
      fakeDb([[/FROM coordinator\.missions/, [{ status: 'cancelled' }]]]),
    );
    expect(obs.tasks).toEqual([]);
    expect(obs.telemetry).toMatchObject({ calls: 0, cachedTokens: null });
  });
});
