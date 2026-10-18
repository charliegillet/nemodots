// W6.3 demo adversary on the DEMO PATH, with a SCRIPTED ADAPTER POLICY (see
// scripted-mission.ts; this is not a live autonomous trial and proves nothing
// about Nemotron's reasoning). Two missions, both on the selective rule:
//   demo    the changed-evidence demonstration as DEMO.md and the live suite
//           set it up: warmed cache, dependent_change_after_proposal through
//           the product route, admission.minAgeMs = 3000;
//   single  the single-fault control (cache_schema_mismatch, minAgeMs 0),
//           which reaches `succeeded`, so preservation is also checked on a
//           completed mission.
// Each check reads raw rows; none reuses the ledger's closure, the
// coordinator's recovery or the live test's helpers.
import { beforeAll, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import {
  scriptedEvidence,
  type EdgeRow,
  type Evidence,
} from './scripted-mission.js';
import {
  CONTROL_VOCABULARY,
  MANIFEST_VOCABULARY,
  hits,
  scenarioIdentifiers,
  type Json,
} from './support.js';

const KEY = 'checkout.config/cache.schema_version';
const runs = new Map<string, Evidence>();
/** The mission the current describe block inspects. */
let ev: Evidence;
const use = (name: string) => () => {
  ev = runs.get(name)!;
};

beforeAll(async () => {
  const common = {
    rule: 'selective',
    latencyMs: 300,
    probeWindowMs: 4000,
    workers: 6,
    timeoutMs: 150_000,
  } as const;
  const [demo, single] = await Promise.all([
    scriptedEvidence(withTestDatabase, withTestRedis, {
      ...common,
      minAgeMs: 3000,
    }),
    scriptedEvidence(withTestDatabase, withTestRedis, {
      ...common,
      scenarioClass: 'cache_schema_mismatch',
      minAgeMs: 0,
    }),
  ]);
  runs.set('demo', demo);
  runs.set('single', single);
}, 300_000);

const ms = (value: unknown) => new Date(value as string).getTime();
const taskBy = (title: string) =>
  ev.tasks.filter((task) => task.title === title);
const firstInvalidation = () =>
  ev.invalidationEvents.find((event) => event.source_key === KEY);

/** Tasks reached from a receipt over evidence/inheritance edges that existed at `asOf`. */
function reached(receiptId: string, asOf: number | null): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of ev.edges as EdgeRow[]) {
    if (e.kind !== 'evidence' && e.kind !== 'inheritance') continue;
    if (asOf !== null && ms(e.created_at) > asOf) continue;
    const from = `${e.from_kind}:${e.from_id}`;
    out.set(from, [...(out.get(from) ?? []), `${e.to_kind}:${e.to_id}`]);
  }
  const taskOf = new Map(
    ev.nodes.map((n) => [`${n.kind}:${n.id}`, n.task_id as string | null]),
  );
  const seen = new Set<string>();
  const queue = [`receipt:${receiptId}`];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...(out.get(node) ?? []));
  }
  const tasks = new Set<string>();
  for (const node of seen) {
    const task = taskOf.get(node);
    if (task) tasks.add(task);
  }
  return tasks;
}

/**
 * ARCHITECTURE 5.4: for a verified self-write "the acting lineage (proposing
 * attempt, its task, ancestors awaiting the result) is not invalidated". The
 * lineage is derived here from the receipt's caused_by_action_id and the task
 * tree, not from the product's closure.
 */
function actingLineage(event: Json): Set<string> {
  const lineage = new Set<string>();
  if (event.self_write !== 'verified') return lineage;
  const receipt = ev.receipts.find((r) => r.id === event.new_receipt_id);
  const intent = ev.intents.find((i) => i.id === receipt?.caused_by_action_id);
  let task = ev.tasks.find((t) => t.id === intent?.task_id);
  while (task) {
    lineage.add(task.id);
    const parent = task.parent_id;
    task = ev.tasks.find((t) => t.id === parent);
  }
  return lineage;
}

/** The expected closure of one event: traversal minus the acting lineage. */
function expectedClosure(event: Json): Set<string> {
  const lineage = actingLineage(event);
  return new Set(
    [...reached(event.old_receipt_id, ms(event.created_at))].filter(
      (task) => !lineage.has(task),
    ),
  );
}

const entryOf = (event: Json) =>
  (event.per_mission as Json[]).find((entry) => entry.missionId) ?? {
    affected: { taskIds: [], attemptIds: [] },
    preserved: { taskIds: [] },
  };
const attemptTask = () =>
  new Map(ev.attempts.map((a) => [a.id as string, a.task_id as string]));

describe('[scripted demo] the honest disjunction on the demo path (D6)', () => {
  beforeAll(use('demo'));
  it('the dependent change fired on the proposal', () => {
    expect(ev.faultSteps.map((s) => [s.step_index, s.status])).toEqual([
      [0, 'applied'],
      [1, 'applied'],
    ]);
  });

  it('branch A: the stale intent was blocked(stale_version) and a repair of the proposing task read the new receipt', () => {
    const depAt = ms(ev.faultSteps[1].applied_at);
    const stale = ev.intents.find(
      (i) =>
        i.payload?.key === 'cache.schema_version' &&
        i.status === 'blocked' &&
        i.block_reason === 'stale_version' &&
        ms(i.proposed_at) <= depAt,
    );
    expect(
      stale,
      'a blocked(stale_version) intent proposed before the change',
    ).toBeTruthy();
    const event = firstInvalidation();
    expect(event).toBeTruthy();
    const proposer = stale!.task_id;
    const repairs = ev.attempts.filter(
      (a) => a.task_id === proposer && a.kind === 'repair',
    );
    const sawNew = repairs.some((a) =>
      (a.read_set_vector as Json[]).some(
        (entry) =>
          entry.sourceKey === KEY &&
          ev.receipts.some(
            (r) =>
              r.id === entry.receiptId &&
              r.source_revision >=
                (ev.receipts.find((x) => x.id === event!.new_receipt_id)
                  ?.source_revision ?? Infinity),
          ),
      ),
    );
    expect(
      sawNew,
      'a repair attempt of the proposer read the new revision',
    ).toBe(true);
    // no controlled commit landed on the superseded version
    const committedStale = ev.intents.filter(
      (i) => i.committed_at && ms(i.proposed_at) <= depAt,
    );
    expect(committedStale).toEqual([]);
  });
});

describe.each(['demo', 'single'])(
  '[scripted %s] leakage: agent-visible text, receipts, events and SSE (D7/D10)',
  (name) => {
    beforeAll(use(name));
    const forbidden = () => [
      ...scenarioIdentifiers(),
      ...MANIFEST_VOCABULARY,
      ...CONTROL_VOCABULARY,
      ev.runId,
      ev.probeSecret,
    ];

    it('every model request body (the complete agent-visible corpus) is clean', () => {
      expect(ev.calls.length).toBeGreaterThan(20);
      const found = ev.calls.flatMap((call) =>
        hits(call.raw, [...forbidden(), 'PROBE-SKU', 'caused_by']).map(
          (hit) => `call ${call.n} (${call.role}): ${hit}`,
        ),
      );
      expect(found).toEqual([]);
    });

    it('no receipt row carries control, scenario, manifest, injector or probe-secret data', () => {
      expect(ev.receipts.length).toBeGreaterThan(5);
      const found = ev.receipts.flatMap((receipt) =>
        hits(JSON.stringify(receipt), forbidden()).map(
          (hit) => `${receipt.source_key}: ${hit}`,
        ),
      );
      expect(found).toEqual([]);
    });

    it('no mission event (the SSE corpus) and no SSE frame carries them either', () => {
      expect(ev.events.length).toBeGreaterThan(20);
      expect(ev.sse).toContain('id:');
      const found = [
        ...ev.events.flatMap((event) =>
          hits(JSON.stringify(event.payload), forbidden()).map(
            (hit) => `event ${event.id} ${event.kind}: ${hit}`,
          ),
        ),
        ...hits(ev.sse, forbidden()).map((hit) => `sse: ${hit}`),
      ];
      expect(found).toEqual([]);
    });
  },
);

describe.each(['demo', 'single'])(
  '[scripted %s] structural preservation recomputed from raw edges (D5)',
  (name) => {
    beforeAll(use(name));
    it('the closure of every invalidation equals an independent traversal of the edges that existed then (minus the acting lineage of a verified self-write)', () => {
      expect(ev.invalidationEvents.length).toBeGreaterThan(0);
      const taskOfAttempt = attemptTask();
      const diffs: Json[] = [];
      for (const event of ev.invalidationEvents) {
        const entry = entryOf(event);
        const product = new Set<string>([
          ...entry.affected.taskIds,
          ...entry.affected.attemptIds.map((id: string) =>
            taskOfAttempt.get(id),
          ),
        ]);
        const mine = expectedClosure(event);
        const onlyProduct = [...product].filter((t) => !mine.has(t));
        const onlyMine = [...mine].filter((t) => !product.has(t));
        if (onlyProduct.length || onlyMine.length)
          diffs.push({ source: event.source_key, onlyProduct, onlyMine });
      }
      expect(diffs).toEqual([]);
    });

    it('the preserved set the product records equals the existing tasks the traversal did not reach', () => {
      const diffs: Json[] = [];
      for (const event of ev.invalidationEvents) {
        const at = ms(event.created_at);
        const existing = ev.tasks.filter((t) => ms(t.created_at) <= at);
        const mine = expectedClosure(event);
        const expected = new Set(
          existing.filter((t) => !mine.has(t.id)).map((t) => t.id as string),
        );
        const product = new Set<string>(entryOf(event).preserved.taskIds);
        const onlyProduct = [...product].filter((t) => !expected.has(t));
        const onlyMine = [...expected].filter((t) => !product.has(t));
        if (onlyProduct.length || onlyMine.length)
          diffs.push({ source: event.source_key, onlyProduct, onlyMine });
      }
      expect(diffs).toEqual([]);
    });

    it("the live test's untimed traversal agrees with the timed one for the changed key", () => {
      const event = firstInvalidation()!;
      const timed = reached(event.old_receipt_id, ms(event.created_at));
      const untimed = reached(event.old_receipt_id, null);
      expect([...untimed].filter((t) => !timed.has(t))).toEqual([]);
    });

    it('the independent branch made no new attempt and no model call after the first invalidation', () => {
      const [routing] = taskBy('Routing branch');
      const at = ms(firstInvalidation()!.created_at);
      const attempts = ev.attempts.filter((a) => a.task_id === routing.id);
      expect(attempts.map((a) => [a.kind, a.status])).toEqual([
        ['initial', 'published'],
      ]);
      expect(ms(attempts[0].finished_at)).toBeLessThanOrEqual(at);
      expect(
        ev.modelCalls.filter(
          (c) => c.task_id === routing.id && ms(c.created_at) > at,
        ),
      ).toEqual([]);
      // and it was not reached by any invalidation of the mission
      for (const event of ev.invalidationEvents)
        expect(
          reached(event.old_receipt_id, ms(event.created_at)).has(routing.id),
          event.source_key,
        ).toBe(false);
    });

    it('every output still usable at mission end rests only on revisions that were current at mission end', () => {
      const end = ms(ev.mission.finished_at ?? new Date().toISOString());
      const latest = new Map<string, number>();
      for (const rev of ev.sourceRevisions)
        if (ms(rev.created_at) <= end)
          latest.set(
            rev.source_id,
            Math.max(latest.get(rev.source_id) ?? 0, rev.source_revision),
          );
      const byId = new Map(ev.receipts.map((r) => [r.id as string, r]));
      const usable = ev.outputs.filter((o) => o.usable);
      expect(usable.length).toBeGreaterThan(0);
      const stale: string[] = [];
      for (const output of usable)
        for (const entry of output.dependency_vector as Json[]) {
          const receipt = byId.get(entry.receiptId);
          if (!receipt) {
            stale.push(`${output.id}: unknown receipt ${entry.receiptId}`);
            continue;
          }
          const current = latest.get(receipt.source_id);
          if (current !== entry.sourceRevision)
            stale.push(
              `${output.id}: ${entry.sourceKey} r${entry.sourceRevision}, current r${current}`,
            );
        }
      expect(stale).toEqual([]);
    });
  },
);

describe('[scripted demo] DA-02: an invalidation whose affected tasks were all repaired must close', () => {
  beforeAll(use('demo'));
  // openInvalidation (contracts/recovery.ts) treats an `invalidated` attempt as
  // resolved only through successors whose repairOf points at it and that are
  // `published` or `invalidated`. A schema advance supersedes the config key
  // and checkout.metrics ~200 ms apart: the repair scheduled for the first
  // event is ABORTED by the second, the next repair's repairOf names the
  // aborted attempt, and the first event can never close. The mission then
  // fails `repair_not_schedulable` after a verified repair.
  it('no invalidation is left open (or settled unrecoverable) after every affected task published a later repair', () => {
    const taskOfAttempt = attemptTask();
    const unclosable: Json[] = [];
    for (const event of ev.invalidationEvents) {
      const at = ms(event.created_at);
      const entry = entryOf(event);
      const affected = new Set<string>([
        ...entry.affected.taskIds,
        ...entry.affected.attemptIds.map((id: string) => taskOfAttempt.get(id)),
      ]);
      const repairedAll = [...affected].every((taskId) =>
        ev.attempts.some(
          (a) =>
            a.task_id === taskId &&
            a.status === 'published' &&
            ms(a.started_at) > at,
        ),
      );
      const settled = ev.recoveries.find(
        (r) =>
          r.invalidation_event_id === event.id &&
          r.kind === 'invalidation_resolved' &&
          String(r.detail).startsWith('repair_not_schedulable'),
      );
      const row = ev.coordinatorInvalidations.find(
        (r) => r.event_id === event.id,
      );
      if (repairedAll && (settled || !row?.resolved_at))
        unclosable.push({
          source: event.source_key,
          settled: settled?.detail ?? 'still open',
          abortedRepairChains: ev.attempts
            .filter(
              (a) =>
                entry.affected.attemptIds.includes(a.id) &&
                a.status === 'invalidated',
            )
            .map((a) => {
              const next = ev.attempts.filter(
                (b) => b.repair_of?.attemptId === a.id,
              );
              return `attempt ${a.n} invalidated -> ${next.map((b) => `${b.n}:${b.status}`).join(',') || 'none'}`;
            }),
        });
    }
    expect(unclosable).toEqual([]);
  });

  it('the demo mission succeeds (an acceptable repair exists: set the schema to the found version)', () => {
    expect({
      status: ev.mission.status,
      reason: ev.mission.failure_reason,
      // informational: whether the repair had been verified before the end
      verifiedRepairs: ev.intents.filter((i) => i.status === 'verified').length,
    }).toEqual({
      status: 'succeeded',
      reason: null,
      verifiedRepairs: expect.any(Number),
    });
  });
});
