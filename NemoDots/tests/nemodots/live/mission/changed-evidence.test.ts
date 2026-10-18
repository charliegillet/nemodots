// Live, the core demonstration: a seeded cache fault, a mission with a 3 s
// admission delay, and a scenario-driven second change of the SAME key the
// moment a repair is proposed. The honest disjunction is recorded, not chosen:
//   (A) the intent is blocked(stale_version) and a repair attempt's readset
//       contains the new receipt, or
//   (B) the commit landed first and a second invalidation with repair follows.
// In either case a final set_config must commit and the independent probe pass.
// The preserved set is computed STRUCTURALLY from recorded edges (tasks with no
// evidence or inheritance path from the superseded receipt) and must make zero
// new model calls after the invalidation; an empty set is NOT_MET and fails,
// it is never forced. Delegation (investigator -> specialist, depth >= 2) is
// asserted here. Everything is reported per check; nothing is faked.
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import {
  diagnose,
  requireLive,
  sleep,
  startLiveInstance,
  writeResults,
  type Check,
  type LiveInstance,
} from './support.js';

const GOAL = 'Restore checkout availability while preserving customer data.';
const KEY = 'checkout.config/cache.schema_version';
const SPECIALISTS = [
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
];
const checks: Check[] = [];
let failed = true;
let blocked: string | null = null;
let instance: LiveInstance;
let nemodots: NemoDots;
let pool: pg.Pool;

beforeAll(async () => {
  try {
    requireLive();
  } catch (error) {
    blocked = (error as Error).message;
    throw error;
  }
  instance = await startLiveInstance();
  nemodots = createNemoDots(instance.env, {
    workspace: { ownerId: 'live-owner' },
  });
  await nemodots.start();
  pool = new pg.Pool({
    connectionString: instance.env.NEMODOTS_PG_URL_VERIFIER,
    max: 2,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await nemodots?.stop().catch(() => undefined);
  instance?.stop();
  writeResults(
    'changed-evidence',
    instance?.name ?? 'none',
    blocked ? 'BLOCKED' : failed ? 'FAIL' : 'PASS',
    checks,
  );
}, 60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const request = (path: string, body?: unknown) =>
  Promise.resolve(
    nemodots.router.request(
      path,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    ),
  ).then((r) => r.json() as Promise<Json>);

const record = (check: Check) => {
  checks.push(check);
  return check.status === 'PASS';
};

/** Tasks reached from `receiptIds` over evidence and inheritance edges. */
async function affectedTasks(missionId: string, receiptIds: string[]) {
  const { rows: edges } = await pool.query<{
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
  }>(
    `SELECT e.from_kind, e.from_id, e.to_kind, e.to_id
       FROM ledger.dependency_edges e
      WHERE e.kind IN ('evidence', 'inheritance')
        AND (e.mission_id = $1 OR e.from_kind = 'receipt')`,
    [missionId],
  );
  const nodes = await pool.query<{
    kind: string;
    id: string;
    task_id: string | null;
  }>(
    `SELECT kind, id, task_id FROM ledger.dependency_nodes WHERE mission_id = $1`,
    [missionId],
  );
  const taskOf = new Map(
    nodes.rows.map((n) => [`${n.kind}:${n.id}`, n.task_id]),
  );
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const from = `${e.from_kind}:${e.from_id}`;
    out.set(from, [...(out.get(from) ?? []), `${e.to_kind}:${e.to_id}`]);
  }
  const seen = new Set<string>();
  const queue = receiptIds.map((id) => `receipt:${id}`);
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

it('a dependent change after a proposal: honest outcome, structural preservation, repair, acceptance', async () => {
  // 0. the scenario's prerequisite: the cache holds entries stored under the
  // baseline schema (a health check writes its canary; /products fills the
  // catalogue). Without them a schema change breaks nothing.
  const checkout = instance.env.NEMODOTS_CHECKOUT_URL;
  for (let i = 0; i < 3; i++) {
    await fetch(`${checkout}/health`);
    await fetch(`${checkout}/products`);
  }

  // 1. the fault: the manifest's immediate step runs before the mission
  const run = await request('/sandbox/injector/run', {
    scenarioClass: 'dependent_change_after_proposal',
  });
  expect(run.runId).toBeTruthy();
  const faultAt = Date.now() + 30_000;
  let first: Json | undefined;
  while (Date.now() < faultAt && !first) {
    const { rows } = await pool.query(
      `SELECT * FROM control.fault_schedules WHERE run_id = $1 AND step_index = 0 AND status = 'applied'`,
      [run.runId],
    );
    first = rows[0];
    if (!first) await sleep(250);
  }
  expect(first, 'the seeded fault was applied').toBeTruthy();
  // the fault must be observable, or the rest of the scenario proves nothing
  await sleep(1_000); // checkout caches its configuration for 250 ms
  const afterFault = await fetch(`${checkout}/health`).then(
    (r) => r.json() as Promise<Json>,
  );
  record({
    name: 'seeded fault is observable in checkout health',
    status: afterFault.status !== 'ok' ? 'PASS' : 'NOT_MET',
    observed: { status: afterFault.status, errors: afterFault.errors },
  });

  // 2. the mission: the goal only, admission delay 3 s
  const created = await request('/missions', {
    goal: GOAL,
    admission: { minAgeMs: 3000 },
  });
  expect(created.admission.minAgeMs).toBe(3000);
  await request(`/missions/${created.id}/start`, {});

  const startedAt = Date.now();
  const deadline = startedAt + 16 * 60_000;
  let snapshot: Json = {};
  while (Date.now() < deadline) {
    snapshot = await request(`/missions/${created.id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.mission.status))
      break;
    await sleep(3000);
  }
  const elapsedMs = Date.now() - startedAt;
  const finished = snapshot.mission.status === 'succeeded';
  if (!finished)
    record({
      name: 'mission finished',
      status: 'FAIL',
      observed: {
        status: snapshot.mission.status,
        elapsedMs,
        diagnosis: await diagnose(pool, created.id),
      },
    });

  // 3. what happened to the dependent change
  const steps = await pool.query(
    `SELECT step_index, status, applied_at, version_before, version_after, error
       FROM control.fault_schedules WHERE run_id = $1 ORDER BY step_index`,
    [run.runId],
  );
  const dependent = steps.rows.find((s) => s.step_index === 1);
  const fired = dependent?.status === 'applied';
  record({
    name: 'dependent change fired on a proposal',
    status: fired ? 'PASS' : 'NOT_MET',
    observed: {
      steps: steps.rows.map((s) => ({
        index: s.step_index,
        status: s.status,
        error: s.error,
      })),
    },
  });

  const intents = await pool.query(
    `SELECT id, action, status, block_reason, expected_target_version, committed_target_version,
            proposed_at, committed_at
       FROM coordinator.action_intents
      WHERE mission_id = $1 AND target::text LIKE '%cache.schema_version%'
      ORDER BY proposed_at`,
    [created.id],
  );
  const invalidations = await pool.query(
    `SELECT id, created_at, old_receipt_id, new_receipt_id
       FROM ledger.invalidation_events
      WHERE mission_ids ? $1::text AND source_key = $2 ORDER BY created_at`,
    [created.id, KEY],
  );
  const repairs = await pool.query(
    `SELECT id, read_set_vector, started_at FROM coordinator.task_attempts
      WHERE mission_id = $1 AND kind = 'repair'`,
    [created.id],
  );
  const depAt = dependent?.applied_at
    ? new Date(dependent.applied_at).getTime()
    : null;
  const depVersion = dependent?.version_after
    ? Number(dependent.version_after)
    : null;

  const staleBlock = intents.rows.find(
    (i) => i.status === 'blocked' && i.block_reason === 'stale_version',
  );
  const repairSawNew = repairs.rows.some((r) =>
    (r.read_set_vector as Json[]).some(
      (e) =>
        e.sourceKey === KEY &&
        depVersion !== null &&
        Number(e.sourceRevision) >= depVersion,
    ),
  );
  const committedFirst = intents.rows.find(
    (i) =>
      ['committed', 'dispatched', 'verified'].includes(i.status) &&
      depAt !== null &&
      i.committed_at &&
      new Date(i.committed_at).getTime() < depAt,
  );
  const secondInvalidation = invalidations.rows.some(
    (i) => depAt !== null && new Date(i.created_at).getTime() >= depAt,
  );
  const outcome: 'A' | 'B' | 'neither' =
    staleBlock && repairSawNew
      ? 'A'
      : committedFirst && secondInvalidation && repairs.rows.length > 0
        ? 'B'
        : 'neither';
  record({
    name: 'honest disjunction',
    status: outcome === 'neither' ? 'NOT_MET' : 'PASS',
    observed: {
      outcome,
      meaning:
        outcome === 'A'
          ? 'blocked(stale_version); a repair attempt read the new receipt'
          : outcome === 'B'
            ? 'the commit landed first; a second invalidation and repair followed'
            : 'neither branch of the disjunction was observed',
      intents: intents.rows.map((i) => ({
        action: i.action,
        status: i.status,
        blockReason: i.block_reason,
        expected: i.expected_target_version,
        committed: i.committed_target_version,
      })),
      invalidations: invalidations.rows.length,
      repairAttempts: repairs.rows.length,
    },
  });

  // 4. the final set_config commits and the independent probe passes
  const finalCommit = intents.rows.find(
    (i) =>
      i.action === 'set_config' &&
      ['committed', 'verified'].includes(i.status) &&
      (depAt === null ||
        (i.committed_at && new Date(i.committed_at).getTime() > depAt)),
  );
  record({
    name: 'final set_config committed after the dependent change',
    status: finalCommit ? 'PASS' : 'FAIL',
    observed: { found: !!finalCommit },
  });
  record({
    name: 'independent probe passed',
    status:
      snapshot.probe?.normalizedValue?.verdict === 'pass' ? 'PASS' : 'FAIL',
    observed: { verdict: snapshot.probe?.normalizedValue?.verdict ?? null },
  });

  // 5. independent work is not re-executed. The independent set is computed
  // from recorded edges, never from the model: every non-planner task with no
  // evidence or inheritance path from the superseded receipt. A running
  // independent task may keep working; it must never be restarted or aborted.
  const firstInvalidation = invalidations.rows[0];
  let independent: string[] = [];
  let restarted: Json[] = [];
  let completedBefore: string[] = [];
  let callsAfter = -1;
  if (firstInvalidation) {
    const reached = await affectedTasks(created.id, [
      firstInvalidation.old_receipt_id,
    ]);
    const tasks = await pool.query(
      `SELECT t.id FROM coordinator.tasks t
        WHERE t.mission_id = $1 AND t.role <> 'planner'
          AND EXISTS (SELECT 1 FROM coordinator.task_attempts a WHERE a.task_id = t.id)`,
      [created.id],
    );
    independent = tasks.rows
      .map((r) => r.id as string)
      .filter((id) => !reached.has(id));
    if (independent.length) {
      // (a) no new attempt after the invalidation, and no abort of a running one
      restarted = (
        await pool.query(
          `SELECT task_id, kind, n, status FROM coordinator.task_attempts
            WHERE task_id = ANY($1::uuid[])
              AND ( ((n > 1 OR kind <> 'initial') AND started_at > $2)
                 OR (status IN ('invalidated', 'aborted') AND finished_at > $2) )`,
          [independent, firstInvalidation.created_at],
        )
      ).rows;
      // (b) work that had already published is not re-run: zero new model calls
      completedBefore = (
        await pool.query(
          `SELECT DISTINCT task_id FROM coordinator.task_attempts
            WHERE task_id = ANY($1::uuid[]) AND status = 'published' AND finished_at <= $2`,
          [independent, firstInvalidation.created_at],
        )
      ).rows.map((r) => r.task_id as string);
      if (completedBefore.length)
        callsAfter = (
          await pool.query(
            `SELECT count(*)::int AS n FROM ledger.model_call_records
              WHERE mission_id = $1 AND task_id = ANY($2::uuid[]) AND created_at > $3`,
            [created.id, completedBefore, firstInvalidation.created_at],
          )
        ).rows[0].n;
    }
  }
  const emptySet = independent.length === 0;
  const emptyNote = !firstInvalidation
    ? 'the cache.schema_version receipt was never superseded, so there is no invalidation to preserve work from'
    : 'no task was structurally independent of the superseded receipt; reported, not forced';
  record({
    name: 'independent tasks were not restarted or aborted after the invalidation',
    status: emptySet ? 'NOT_MET' : restarted.length === 0 ? 'PASS' : 'FAIL',
    observed: {
      independentTasks: independent.length,
      newAttemptsOrAborts: restarted.length,
      attempts: restarted.slice(0, 6),
      note: emptySet ? emptyNote : undefined,
    },
  });
  record({
    name: 'independent work already published made zero new model calls',
    status:
      emptySet || completedBefore.length === 0
        ? 'NOT_MET'
        : callsAfter === 0
          ? 'PASS'
          : 'FAIL',
    observed: {
      independentPublishedBefore: completedBefore.length,
      newModelCalls: callsAfter,
      note:
        emptySet || completedBefore.length === 0
          ? emptySet
            ? emptyNote
            : 'no independent task had published before the invalidation'
          : undefined,
    },
  });

  // 6. recursive delegation
  const tree = await pool.query(
    `SELECT c.id, c.role AS role, c.depth AS depth, p.role AS parent_role
       FROM coordinator.tasks c JOIN coordinator.tasks p ON p.id = c.parent_id
      WHERE c.mission_id = $1`,
    [created.id],
  );
  const investigatorToSpecialist = tree.rows.some(
    (r) => r.parent_role === 'investigator' && SPECIALISTS.includes(r.role),
  );
  const maxDepth = Math.max(0, ...tree.rows.map((r) => Number(r.depth)));
  record({
    name: 'investigator delegated to a specialist',
    status: investigatorToSpecialist ? 'PASS' : 'NOT_MET',
    observed: { delegatedTasks: tree.rows.length },
  });
  record({
    name: 'delegation reached depth 2',
    status: maxDepth >= 2 ? 'PASS' : 'NOT_MET',
    observed: { maxDepth },
  });

  // 7. every call: configured host, live, model returned = requested
  const host = new URL(process.env.OPENAI_BASE_URL!).host;
  const calls = await pool.query(
    `SELECT provider_host, provider_mode, model_requested, model_returned
       FROM ledger.model_call_records WHERE mission_id = $1`,
    [created.id],
  );
  const callsOk =
    calls.rows.length > 0 &&
    calls.rows.every(
      (r) =>
        r.provider_host === host &&
        r.provider_mode === 'live' &&
        r.model_returned === r.model_requested,
    );
  record({
    name: 'provider host and model on every call',
    status: callsOk ? 'PASS' : 'FAIL',
    observed: { calls: calls.rows.length, host },
  });
  record({
    name: 'mission succeeded',
    status: finished ? 'PASS' : 'FAIL',
    observed: { status: snapshot.mission.status, elapsedMs },
  });

  const bad = checks.filter((c) => c.status !== 'PASS');
  failed = bad.length > 0;
  expect(bad.map((c) => `${c.name}: ${c.status}`)).toEqual([]);
}, 1_140_000);
