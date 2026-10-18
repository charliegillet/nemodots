// Live, healthy path: a mission from a goal only, on a dedicated stack
// instance, planned and worked by Nemotron on Crusoe through the real
// composition root, accepted by the independent probe. No fixture, no stub,
// no NEMODOTS_TEST_HOOKS. Missing live variables print BLOCKED and fail.
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import {
  requireLive,
  sleep,
  startLiveInstance,
  writeResults,
  type Check,
  diagnose,
  type LiveInstance,
} from './support.js';

const GOAL = 'Restore checkout availability while preserving customer data.';
const checks: Check[] = [];
let failed = true;
let instance: LiveInstance;
let nemodots: NemoDots;
let pool: pg.Pool;
let blocked: string | null = null;

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
    'healthy',
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

it('plans, works with zero committed actions and is accepted by the independent probe', async () => {
  const health = await request('/health');
  expect(health).toMatchObject({
    mode: 'live',
    postgres: 'ok',
    redis: 'ok',
    checkout: { reachable: true, status: 'ok' },
  });
  expect(health.provider.reachable).toBe(true);
  expect(health.provider.modelListed).toBe(true);

  // the goal and nothing else
  const created = await request('/missions', { goal: GOAL });
  expect(created.status).toBe('created');
  await request(`/missions/${created.id}/start`, {});

  const startedAt = Date.now();
  const deadline = startedAt + 14 * 60_000;
  let snapshot: Json = {};
  while (Date.now() < deadline) {
    snapshot = await request(`/missions/${created.id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.mission.status))
      break;
    await sleep(2000);
  }
  const elapsedMs = Date.now() - startedAt;
  if (snapshot.mission.status !== 'succeeded')
    checks.push({
      name: 'healthy mission (not finished)',
      status: 'FAIL',
      observed: await diagnose(pool, created.id),
    });
  expect(snapshot.mission.status).toBe('succeeded');

  // plan persisted, written by the planner attempt
  const plan = await pool.query(
    `SELECT count(*)::int AS n FROM coordinator.task_outputs WHERE mission_id = $1 AND kind = 'plan'`,
    [created.id],
  );
  expect(plan.rows[0].n).toBeGreaterThanOrEqual(1);

  // at least two workers did real work
  const workers = snapshot.tasks.filter(
    (t: Json) => t.role !== 'planner' && t.status === 'succeeded',
  );
  expect(workers.length).toBeGreaterThanOrEqual(2);
  // A healthy system needs no repair: nothing was committed or dispatched.
  const committed = snapshot.actions.filter((a: Json) =>
    ['committed', 'dispatched', 'verified', 'outcome_unknown'].includes(
      a.status,
    ),
  );
  checks.push({
    name: 'zero committed actions',
    status: committed.length === 0 ? 'PASS' : 'FAIL',
    observed: {
      proposed: snapshot.actions.length,
      committed: committed.length,
    },
  });
  expect(committed).toEqual([]);

  // independent acceptance, not a model's word
  expect(snapshot.mission.acceptanceReceiptId).toBeTruthy();
  expect(snapshot.probe).toMatchObject({
    source: { key: 'checkout.acceptance' },
  });
  expect(snapshot.probe.normalizedValue.verdict).toBe('pass');
  expect(snapshot.invalidations.filter((i: Json) => !i.resolvedAt)).toEqual([]);

  // every model call went to the configured host and returned the requested model
  const host = new URL(process.env.OPENAI_BASE_URL!).host;
  const calls = await pool.query(
    `SELECT provider_host, provider_mode, model_requested, model_returned, role
       FROM ledger.model_call_records WHERE mission_id = $1`,
    [created.id],
  );
  expect(calls.rows.length).toBeGreaterThanOrEqual(3);
  for (const row of calls.rows) {
    expect(row.provider_host).toBe(host);
    expect(row.provider_mode).toBe('live');
    expect(row.model_returned).toBe(row.model_requested);
  }
  expect(calls.rows.some((r) => r.role === 'planner')).toBe(true);

  checks.push({
    name: 'healthy mission',
    status: 'PASS',
    observed: {
      elapsedMs,
      tasks: snapshot.tasks.length,
      delegatedTasks: snapshot.tasks.filter((t: Json) => t.parentId !== null)
        .length,
      succeededWorkers: workers.length,
      attempts: snapshot.attempts.length,
      findings: snapshot.findings.length,
      modelCalls: calls.rows.length,
      providerHost: host,
      modelRequested: calls.rows[0].model_requested,
      telemetry: {
        calls: snapshot.telemetry.calls,
        orphanedCalls: snapshot.telemetry.orphanedCalls,
        tokens: snapshot.telemetry.tokens,
        retries: snapshot.telemetry.retries,
        errors: snapshot.telemetry.errors,
        ttftMs: snapshot.telemetry.ttftMs,
      },
    },
  });
  failed = false;
}, 900_000);
