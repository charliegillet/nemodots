// W6.3 demo adversary: a SCRIPTED ADAPTER-POLICY mission (BUILD_PROMPT: label
// it as such; it is never a live autonomous trial). Everything is the real
// product except the model: the composition root (createNemoDots), the checkout
// API on its own HTTP port against a fresh test database, the injector started
// through the product route, the watcher, ledger, coordinator, actions and the
// team code (prompts, tools, worker loop, closing check, pre-change
// verification). The "model" is a local Chat Completions server that follows a
// fixed policy below and records every request body, so the complete
// agent-visible text corpus can be scanned.
//
// The policy: two root investigators. "Cache branch" reads health, delegates a
// cache specialist to DIAGNOSE (reads the schema key and the metrics, changes
// nothing), consumes its output, then delegates a second cache specialist to
// REPAIR (reads both again, delegates a verifier, waits, proposes set_config to
// the schema the metrics report as found). "Routing branch" reads only the
// routing key and one SKU's inventory and finishes (independent evidence).
// Replans add two verifiers that read health. Nothing in the policy reads a
// manifest or the control schema; it acts only on tool results.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import { STRATEGY_RULES } from '../../../../src/server/nemodots/evals/strategies/index.js';
import type { RecoveryScopeRule } from '../../../../src/server/nemodots/contracts/index.js';
import { createCheckoutApp } from '../../../../src/server/nemodots/sandbox/checkout-app.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import type { TestDatabase } from '../../helpers/test-db.js';
import type { TestRedis } from '../../helpers/test-redis.js';
import type { Json } from './support.js';

export const GOAL =
  'Restore checkout availability while preserving customer data.';
export const MODEL = 'stub/model';
export const PROVIDER_KEY = 'scripted-provider-key-0123456789';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------ the provider

export interface ProviderCall {
  n: number;
  role: string;
  title: string;
  repair: boolean;
  format: string | null;
  hasTools: boolean;
  /** messages after the system message, as sent */
  history: Json[];
  /** the complete request body as received (agent-visible text and tool schemas) */
  raw: string;
  reply: { content: string | null; toolCalls: { name: string; args: Json }[] };
}

interface Step {
  name: string;
  args: Json;
  result: Json;
}

const unescape = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The JSON a tool returned, from its <data kind="tool_result"> block. */
function toolJson(content: string): Json {
  const body = content
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) => unescape(line.slice(2)))
    .join('\n');
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function stepsOf(history: Json[]): Step[] {
  const steps: Step[] = [];
  const results = new Map<string, Json>();
  for (const message of history)
    if (message.role === 'tool')
      results.set(
        message.tool_call_id,
        toolJson(String(message.content ?? '')),
      );
  for (const message of history)
    if (message.role === 'assistant')
      for (const call of message.tool_calls ?? []) {
        let args: Json;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }
        steps.push({
          name: call.function.name,
          args,
          result: results.get(call.id) ?? {},
        });
      }
  return steps;
}

function roleOf(system: string): string {
  const line = /^Role: ([^\n]*)$/m.exec(system)?.[1] ?? '';
  if (line.startsWith('planner')) return 'planner';
  if (line.startsWith('investigator')) return 'investigator';
  if (line.startsWith('verifier')) return 'verifier';
  if (line.startsWith('postcondition')) return 'postcondition';
  if (line.includes('cache namespace and schema')) return 'cache_specialist';
  if (line.includes('database pool')) return 'database_specialist';
  if (line.includes('inventory routing')) return 'routing_specialist';
  return 'unknown';
}

const titleOf = (system: string) =>
  unescape(/^\| Task: (.*)$/m.exec(system)?.[1] ?? '');

type Reply = ProviderCall['reply'];
const say = (content: string): Reply => ({ content, toolCalls: [] });
const call = (name: string, args: Json): Reply => ({
  content: null,
  toolCalls: [{ name, args }],
});

const INVESTIGATOR_CAPS = [
  'observe',
  'delegate',
  'publish_finding',
  'request_replan',
];

interface PolicyState {
  replans: number;
}

/** The fixed policy. It sees only what the product sent. */
function decide(
  state: PolicyState,
  role: string,
  title: string,
  format: string | null,
  hasTools: boolean,
  steps: Step[],
): Reply {
  if (format === 'incident_plan')
    return say(
      JSON.stringify({
        tasks: [
          {
            title: 'Cache branch',
            question: 'Is the catalogue cache serving product reads correctly?',
            role: 'investigator',
            capabilities: INVESTIGATOR_CAPS,
            dependsOn: [],
          },
          {
            title: 'Routing branch',
            question: 'Do inventory reads agree with the authority?',
            role: 'investigator',
            capabilities: INVESTIGATOR_CAPS,
            dependsOn: [],
          },
        ],
      }),
    );
  if (format === 'incident_replan') {
    state.replans += 1;
    return say(
      JSON.stringify({
        tasks: [1, 2].map((i) => ({
          title: `Confirm health ${state.replans}.${i}`,
          question: 'Does checkout health report ok now?',
          role: 'verifier',
          capabilities: ['observe', 'publish_finding'],
          dependsOn: [],
        })),
        cancelTaskIds: [],
      }),
    );
  }
  if (format === 'closing_check')
    return say(
      JSON.stringify({
        defectFound: false,
        area: 'none',
        reason: 'my own readings show nothing broken in my area',
      }),
    );
  const done = (text: string) => say(text);
  if (!hasTools) return done('Final answer: see the receipts I read.');
  const observed = (key: string) =>
    steps.find((s) => s.name === 'observe_source' && s.args.sourceKey === key)
      ?.result;
  const next = (keys: string[]) => keys.find((key) => !observed(key));
  const count = (name: string) => steps.filter((s) => s.name === name).length;
  const last = steps.at(-1);

  if (role === 'investigator' && title === 'Routing branch') {
    const key = next([
      'checkout.config/routing.inventory_source',
      'checkout.inventory/SKU-0001',
    ]);
    if (key) return call('observe_source', { sourceKey: key });
    return done('Routing branch: authority and API agree.');
  }
  if (role === 'investigator') {
    if (!observed('checkout.health'))
      return call('observe_source', { sourceKey: 'checkout.health' });
    const health = observed('checkout.health');
    const delegations = steps.filter((s) => s.name === 'delegate_task');
    const waits = count('wait_for_children');
    const child = (childTitle: string, question: string) =>
      call('delegate_task', {
        title: childTitle,
        role: 'cache_specialist',
        question,
        dependsOn: [],
        justification: `health receipt ${health.receiptId} reports ${JSON.stringify(health.value?.errors ?? health.value?.errorClasses ?? health.value)}`,
      });
    if (delegations.length === 0)
      return child(
        'Diagnose cache',
        'Diagnose the cache from the configuration and metrics readings; change nothing.',
      );
    if (waits === 0) return call('wait_for_children', {});
    if (delegations.length === 1)
      return child(
        'Repair cache',
        'Repair the cache if your readings confirm a schema mismatch.',
      );
    if (
      last?.name === 'wait_for_children' &&
      last.result.allTerminal === false &&
      waits < 6
    )
      return call('wait_for_children', {});
    if (waits === 1) return call('wait_for_children', {});
    return done('Cache branch: the cache specialists reported their outcome.');
  }
  if (role === 'cache_specialist') {
    const key = next([
      'checkout.config/cache.schema_version',
      'checkout.metrics',
    ]);
    if (key) return call('observe_source', { sourceKey: key });
    if (title === 'Diagnose cache')
      return done('Diagnosis recorded from the schema and metrics receipts.');
    const schema = observed('checkout.config/cache.schema_version');
    const metrics = observed('checkout.metrics');
    const found = metrics?.value?.cacheDecodeError?.foundSchema;
    if (typeof found !== 'number')
      return done('No decode error in the metrics: nothing to repair.');
    const proposals = steps.filter((s) => s.name === 'propose_action');
    const lastProposal = proposals.at(-1)?.result;
    const verifierWanted =
      count('delegate_task') === 0 ||
      lastProposal?.error === 'verification_required';
    if (verifierWanted && count('delegate_task') < 3)
      return call('delegate_task', {
        title: `Verify schema reading ${String(schema.receiptId).slice(0, 8)}-${count('delegate_task')}`,
        role: 'verifier',
        question: 'Read the cache schema version setting and state its value.',
        dependsOn: [],
        justification: `schema receipt ${schema.receiptId}, metrics receipt ${metrics.receiptId}`,
      });
    if (last?.name === 'delegate_task') return call('wait_for_children', {});
    if (
      proposals.length === 0 ||
      lastProposal?.error === 'verification_required'
    )
      if (proposals.length < 3)
        return call('propose_action', {
          action: 'set_config',
          payload: {
            key: 'cache.schema_version',
            value: found,
            expectedCurrentValueDigest: '0'.repeat(64),
          },
          supportingReceiptIds: [schema.receiptId, metrics.receiptId],
          rationale: 'align the schema setting with the stored entries',
        });
    return done(
      `Proposal outcome: ${JSON.stringify(lastProposal ?? {}).slice(0, 200)}`,
    );
  }
  if (role === 'verifier' && title.startsWith('Verify schema')) {
    if (!observed('checkout.config/cache.schema_version'))
      return call('observe_source', {
        sourceKey: 'checkout.config/cache.schema_version',
      });
    return done('The schema setting reads as recorded in my receipt.');
  }
  // replan verifiers, the postcondition and anything else: read health once
  if (!observed('checkout.health'))
    return call('observe_source', { sourceKey: 'checkout.health' });
  return done('Health read; see the receipt.');
}

export interface ScriptedProvider {
  baseUrl: string;
  calls: ProviderCall[];
  close(): Promise<void>;
}

export async function scriptedProvider(
  latencyMs = 0,
): Promise<ScriptedProvider> {
  const calls: ProviderCall[] = [];
  const state: PolicyState = { replans: 0 };
  let toolCallSeq = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      if (latencyMs > 0 && !request.url?.endsWith('/models'))
        await sleep(latencyMs);
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/models')) {
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      let parsed: Json;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const messages: Json[] = parsed.messages ?? [];
      const system = String(messages[0]?.content ?? '');
      const history = messages.slice(1);
      const role = roleOf(system);
      const title = titleOf(system);
      const format = parsed.response_format?.json_schema?.name ?? null;
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const reply = decide(
        state,
        role,
        title,
        format,
        hasTools,
        stepsOf(history),
      );
      calls.push({
        n: calls.length + 1,
        role,
        title,
        repair: system.includes('This attempt repairs earlier work'),
        format,
        hasTools,
        history,
        raw: body,
        reply,
      });
      const toolCalls = reply.toolCalls.map((tc) => ({
        id: `call_${(toolCallSeq += 1)}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
      response.end(
        JSON.stringify({
          id: `cmpl-${calls.length}`,
          model: MODEL,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: reply.content,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------------ the mission

export interface ScriptedRun {
  missionId: string;
  runId: string;
  status: string;
  elapsedMs: number;
  probeSecret: string;
  /** read-only pool on the test database (verifier role) */
  verifier: pg.Pool;
  nemodots: NemoDots;
  provider: ScriptedProvider;
  sse: string;
  snapshot: Json;
}

export interface RunOptions {
  rule: 'selective' | 'broad-restart' | 'dag-restart';
  scenarioClass?: string;
  minAgeMs?: number;
  timeoutMs?: number;
  /** per model call; 0 answers at once (faster than any real model) */
  latencyMs?: number;
  probeWindowMs?: number;
  /** NEMODOTS_WORKERS (the product default is 2) */
  workers?: number;
  /** stop waiting for a terminal status once this returns true */
  stopWhen?: (missionId: string, verifier: pg.Pool) => Promise<boolean>;
}

/**
 * Runs one scripted mission end to end and returns handles for inspection.
 * The caller owns `close()` of everything through `closers`.
 */
export async function runScriptedMission(
  db: TestDatabase,
  redis: TestRedis,
  options: RunOptions,
  closers: (() => Promise<void> | void)[],
): Promise<ScriptedRun> {
  const probeSecret = randomBytes(16).toString('hex');
  const admin = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  admin.on('error', () => {});
  closers.push(() => admin.end());
  await seedCheckout(admin);

  const checkout = createCheckoutApp({
    pgUrl: db.urls.checkout,
    redisUrl: redis.url,
    redisPrefix: redis.prefix,
    probeSecret,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve(
      { fetch: checkout.app.fetch, port: 0, hostname: '127.0.0.1' },
      () => resolve(s as unknown as Server),
    ) as unknown as Server;
  });
  const checkoutUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await checkout.close();
  });

  const provider = await scriptedProvider(options.latencyMs ?? 0);
  closers.push(() => provider.close());

  const nemodots = createNemoDots(
    {
      NEMODOTS_INSTANCE: 'dev',
      NEMODOTS_PG_URL_APP: db.urls.app,
      NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
      NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
      NEMODOTS_PROBE_SECRET: probeSecret,
      NEMODOTS_REDIS_URL: redis.url,
      NEMODOTS_REDIS_PREFIX: redis.prefix,
      NEMODOTS_CHECKOUT_URL: checkoutUrl,
      NEMODOTS_WATCH_INTERVAL_MS: '200',
      NEMODOTS_WORKERS: String(options.workers ?? 4),
      NEMODOTS_PROBE_WINDOW_MS: String(options.probeWindowMs ?? 1500),
      OPENAI_API_KEY: PROVIDER_KEY,
      OPENAI_BASE_URL: provider.baseUrl,
      OPENAI_MODEL: MODEL,
    },
    {
      workspace: { ownerId: 'demo-adversary' },
      recoveryScopeRules: STRATEGY_RULES as unknown as Record<
        string,
        RecoveryScopeRule
      >,
    },
  );
  closers.push(() => nemodots.stop());
  await nemodots.start();
  if (nemodots.state() !== 'running')
    throw new Error(`NemoDots did not start (${nemodots.state()})`);

  const verifier = new pg.Pool({ connectionString: db.urls.verifier, max: 2 });
  verifier.on('error', () => {});
  closers.push(() => verifier.end());

  const post = async (path: string, body: unknown) =>
    (await (
      await nemodots.router.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Json;

  // the scenario's prerequisite (as the live changed-evidence test does it):
  // entries cached under the baseline schema, so a schema change breaks reads
  for (let i = 0; i < 3; i += 1) {
    await fetch(`${checkoutUrl}/health`);
    await fetch(`${checkoutUrl}/products`);
  }
  const scenarioClass =
    options.scenarioClass ?? 'dependent_change_after_proposal';
  const { runId } = await post('/sandbox/injector/run', { scenarioClass });
  await until(
    'the first fault step',
    async () =>
      (
        await verifier.query(
          `SELECT 1 FROM control.fault_schedules WHERE run_id = $1 AND step_index = 0 AND status = 'applied'`,
          [runId],
        )
      ).rows[0],
    15_000,
  );
  await sleep(600); // the checkout caches configuration for 250 ms

  const coordinator = nemodots.coordinator!;
  const mission = await coordinator.control.create(
    { goal: GOAL, admission: { minAgeMs: options.minAgeMs ?? 3000 } },
    { recoveryScopeRule: options.rule },
  );
  const startedAt = Date.now();
  await coordinator.control.start(mission.id);
  let snapshot: Json = {};
  const deadline = startedAt + (options.timeoutMs ?? 150_000);
  while (Date.now() < deadline) {
    snapshot = await (
      await nemodots.router.request(`/missions/${mission.id}`)
    ).json();
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.mission?.status))
      break;
    if (options.stopWhen && (await options.stopWhen(mission.id, verifier)))
      break;
    await sleep(500);
  }
  const elapsedMs = Date.now() - startedAt;

  // the SSE corpus as a client receives it (replay from the beginning)
  const controller = new AbortController();
  let sse = '';
  try {
    const response = await nemodots.router.request(
      `/missions/${mission.id}/events`,
      { headers: { 'Last-Event-ID': '0' }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const stop = Date.now() + 2_500;
    while (Date.now() < stop) {
      const chunk = await Promise.race([
        reader.read(),
        sleep(400).then(() => null),
      ]);
      if (chunk === null) continue;
      if (chunk.done) break;
      sse += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } catch {
    // an aborted stream is the expected way out
  }

  return {
    missionId: mission.id,
    runId,
    status: String(snapshot.mission?.status ?? 'unknown'),
    elapsedMs,
    probeSecret,
    verifier,
    nemodots,
    provider,
    sse,
    snapshot,
  };
}

// ------------------------------------------------------------ independent reads

export interface EdgeRow {
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  created_at: Date;
}

/**
 * Tasks reached from a receipt over evidence and inheritance edges that
 * existed at `asOf`, computed from raw ledger rows (no product closure code).
 */
export async function reachedTasks(
  pool: pg.Pool,
  missionId: string,
  receiptId: string,
  asOf: Date | null,
): Promise<Set<string>> {
  const edges = (
    await pool.query<EdgeRow>(
      `SELECT kind, from_kind, from_id, to_kind, to_id, created_at
         FROM ledger.dependency_edges WHERE kind IN ('evidence', 'inheritance')`,
    )
  ).rows.filter((e) => asOf === null || e.created_at <= asOf);
  const nodes = (
    await pool.query<{
      kind: string;
      id: string;
      task_id: string | null;
      mission_id: string | null;
    }>(`SELECT kind, id, task_id, mission_id FROM ledger.dependency_nodes`)
  ).rows;
  const taskOf = new Map(
    nodes
      .filter((n) => n.mission_id === missionId)
      .map((n) => [`${n.kind}:${n.id}`, n.task_id]),
  );
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const from = `${e.from_kind}:${e.from_id}`;
    out.set(from, [...(out.get(from) ?? []), `${e.to_kind}:${e.to_id}`]);
  }
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
    // a task node is its own task
    if (node.startsWith('task:') && taskOf.has(node)) tasks.add(node.slice(5));
  }
  return tasks;
}

// ------------------------------------------------------------ evidence

/** Everything the assertions need, read as plain rows before the database is dropped. */
export interface Evidence {
  rule: string;
  runId: string;
  probeSecret: string;
  status: string;
  elapsedMs: number;
  mission: Json;
  missionEvents: Json[];
  tasks: Json[];
  attempts: Json[];
  intents: Json[];
  authorizations: Json[];
  invalidationEvents: Json[];
  coordinatorInvalidations: Json[];
  recoveries: Json[];
  edges: EdgeRow[];
  nodes: Json[];
  receipts: Json[];
  sourceRevisions: Json[];
  sources: Json[];
  outputs: Json[];
  modelCalls: Json[];
  events: Json[];
  faultSteps: Json[];
  /** the context snapshot of the first model call of every attempt */
  firstSnapshots: Json[];
  calls: ProviderCall[];
  sse: string;
}

export async function collectEvidence(
  run: ScriptedRun,
  rule: string,
): Promise<Evidence> {
  const q = async (sql: string, values: unknown[] = [run.missionId]) =>
    (await run.verifier.query(sql, values)).rows as Json[];
  return {
    rule,
    runId: run.runId,
    probeSecret: run.probeSecret,
    status: run.status,
    elapsedMs: run.elapsedMs,
    mission: (
      await q(
        `SELECT status, failure_reason, admission_min_age_ms, recovery_scope_rule, mode, provider,
                started_at, finished_at
           FROM coordinator.missions WHERE id = $1`,
      )
    )[0],
    missionEvents: await q(
      `SELECT id, payload, created_at FROM coordinator.events
        WHERE mission_id = $1 AND kind = 'mission.status' ORDER BY id`,
    ),
    tasks: await q(
      `SELECT id, title, role, status, parent_id, prerequisites, attempt_count, max_attempts, output_id, created_at
         FROM coordinator.tasks WHERE mission_id = $1 ORDER BY ordinal`,
    ),
    attempts: await q(
      `SELECT id, task_id, n, kind, status, abort_reason, failure_reason, repair_of,
              read_set_vector, model_call_ids, started_at, finished_at
         FROM coordinator.task_attempts WHERE mission_id = $1 ORDER BY started_at, n`,
    ),
    intents: await q(
      `SELECT id, task_id, attempt_id, action, payload, status, block_reason, block_detail,
              dependency_vector, expected_target_version, proposed_at, admitted_at, committed_at, verified_at, failed_at
         FROM coordinator.action_intents WHERE mission_id = $1 ORDER BY proposed_at`,
    ),
    authorizations: await q(
      `SELECT a.action_id, a.stage, a.decision, a.block_reason, a.decided_at, a.checked_vector
         FROM coordinator.authorizations a JOIN coordinator.action_intents i ON i.id = a.action_id
        WHERE i.mission_id = $1 ORDER BY a.decided_at`,
    ),
    invalidationEvents: await q(
      `SELECT id, source_key, old_receipt_id, new_receipt_id, reason, self_write, affected, per_mission, created_at
         FROM ledger.invalidation_events WHERE mission_ids ? $1::text ORDER BY created_at`,
    ),
    coordinatorInvalidations: await q(
      `SELECT event_id, source_key, reason, created_at, processed_at, resolved_at
         FROM coordinator.invalidations WHERE mission_id = $1 ORDER BY created_at`,
    ),
    recoveries: await q(
      `SELECT invalidation_event_id, kind, task_id, attempt_id, detail, created_at
         FROM coordinator.recovery_events WHERE mission_id = $1 ORDER BY created_at`,
    ),
    edges: (await q(
      `SELECT kind, from_kind, from_id, to_kind, to_id, created_at FROM ledger.dependency_edges
        WHERE mission_id = $1 OR from_kind = 'receipt'`,
    )) as EdgeRow[],
    nodes: await q(
      `SELECT kind, id, task_id, mission_id, created_at FROM ledger.dependency_nodes WHERE mission_id = $1`,
    ),
    receipts: await q(
      `SELECT r.*, s.key AS source_key FROM ledger.observation_receipts r
         JOIN ledger.sources s ON s.id = r.source_id`,
      [],
    ),
    sourceRevisions: await q(
      `SELECT v.source_id, s.key AS source_key, v.source_revision, v.receipt_id, v.created_at
         FROM ledger.source_revisions v JOIN ledger.sources s ON s.id = v.source_id`,
      [],
    ),
    sources: await q(`SELECT * FROM ledger.sources`, []),
    outputs: await q(
      `SELECT id, task_id, attempt_id, kind, usable, unusable_reason, dependency_vector, published_at
         FROM coordinator.task_outputs WHERE mission_id = $1`,
    ),
    modelCalls: await q(
      `SELECT id, task_id, attempt_id, role, created_at FROM ledger.model_call_records WHERE mission_id = $1`,
    ),
    events: await q(
      `SELECT id, kind, payload, created_at FROM coordinator.events WHERE mission_id = $1 ORDER BY id`,
    ),
    faultSteps: await q(
      `SELECT step_index, kind, status, error, applied_at, version_before, version_after
         FROM control.fault_schedules WHERE run_id = $1 ORDER BY step_index`,
      [run.runId],
    ),
    firstSnapshots: await q(
      `SELECT a.id AS attempt_id, a.task_id, a.kind, a.repair_of, s.layout, s.injected
         FROM coordinator.task_attempts a
         JOIN LATERAL (SELECT m.context_snapshot_id FROM ledger.model_call_records m
                        WHERE m.attempt_id = a.id ORDER BY m.created_at LIMIT 1) m ON true
         JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
        WHERE a.mission_id = $1`,
    ),
    calls: run.provider.calls,
    sse: run.sse,
  };
}

/** Runs one scripted mission on a fresh database and returns its evidence. */
export async function scriptedEvidence(
  withDb: <T>(fn: (db: TestDatabase) => Promise<T>) => Promise<T>,
  withRedis: <T>(fn: (redis: TestRedis) => Promise<T>) => Promise<T>,
  options: RunOptions,
): Promise<Evidence> {
  return withDb((db) =>
    withRedis(async (redis) => {
      const closers: (() => Promise<void> | void)[] = [];
      try {
        const run = await runScriptedMission(db, redis, options, closers);
        // stop the system before reading, so nothing moves under the reads
        await run.nemodots.stop();
        return await collectEvidence(run, options.rule);
      } finally {
        for (const close of closers.splice(0).reverse())
          await Promise.resolve()
            .then(close)
            .catch(() => undefined);
      }
    }),
  );
}
