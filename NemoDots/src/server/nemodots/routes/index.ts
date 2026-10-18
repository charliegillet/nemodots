import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import {
  CreateMissionRequestSchema,
  EvalsReportResponseSchema,
  InjectorRunRequestSchema,
  MissionIdSchema,
  MissionLifecycleActionSchema,
  SourceEditRequestSchema,
  type EvalsReportResponse,
  type HealthStatus,
  type Mission,
  type MissionId,
  type MissionSnapshot,
} from '../contracts/index.js';
import type { MissionControl } from '../coordinator/control.js';
import { MissionNotFoundError } from '../coordinator/errors.js';
import { toMission, type MissionRow } from '../coordinator/rows.js';
import { resolveMode } from '../inference/mode.js';
import { validateConfigValue } from '../sandbox/config-schema.js';
import { summarizeTelemetry } from '../telemetry/summary.js';
import { memberKeyOf, memberSourceKey } from '../watcher/sources.js';
import type { OwnerEdit } from '../watcher/manual.js';
import { BlockedError, RouteError, mapError } from './errors.js';
import {
  DEFAULT_EVENT_STREAM_OPTIONS,
  EventHub,
  missionEventStream,
  type EventStreamOptions,
} from './events-stream.js';
import {
  createHealth,
  fetchCheckoutHealth,
  type CheckoutProxy,
} from './health.js';
import type { InjectorTrigger } from './injector.js';

export {
  BlockedError,
  RouteError,
  UnknownScenarioError,
  mapError,
} from './errors.js';
export { createInjectorTrigger } from './injector.js';
export type { InjectorStarter, InjectorTrigger } from './injector.js';
export { EventHub, checkEvent } from './events-stream.js';
export type { CheckoutProxy } from './health.js';

type Env = Record<string, string | undefined>;

/** Everything the routes need; the composition root (W5) supplies it. */
export interface NemoDotsRouteDeps {
  /** nemodots_app pool. */
  pool: pg.Pool;
  /** MissionControlPort plus `get`; lifecycle and snapshots go through it. */
  control: Pick<
    MissionControl,
    'create' | 'start' | 'pause' | 'resume' | 'cancel' | 'snapshot' | 'get'
  >;
  /** The single owner (OWNER_ID); missions of any other owner do not exist here. */
  ownerId: string;
  /** Environment for mode, missingEnv and provider.host. Defaults to process.env. */
  env?: Env;
  /** InferencePort.listModels: proves the configured model is served (live). */
  listModels?: () => Promise<string[]>;
  pingRedis?: () => Promise<boolean>;
  /** Checkout API for GET /sandbox/checkout/health and the health summary. */
  checkout?: CheckoutProxy | null;
  /** watcher/manual.ts createOwnerEdit(...). */
  ownerEdit: OwnerEdit;
  /** createInjectorTrigger(...) over the injector. */
  injector: InjectorTrigger;
  /** URL (app role) for the shared LISTEN connection; omitted: poll only. */
  listenUrl?: string | (() => string);
  /** JSON file with {status, generatedAt, summary}; absent: NOT_RUN. */
  evalsReportPath?: string;
  intelligenceConfigured?: () => boolean;
  incidentDotIds?: () => number;
  /**
   * Strings that must never appear in a response body (probe secret, owner
   * token, API keys). A response containing one is replaced by a 500.
   */
  secrets?: readonly string[];
  stream?: Partial<EventStreamOptions>;
  /** Class-name-only error reporting; payloads and messages are not passed. */
  onError?: (info: { name: string; route: string }) => void;
  /** An event failed EventPayloadSchema and was not written. */
  onInvalidEvent?: (info: { eventId: number; kind: string }) => void;
  now?: () => Date;
  probeTimeoutMs?: number;
  providerTtlMs?: number;
}

const URL_SCHEME = /\b(?:postgres(?:ql)?|redis|rediss):\/\//i;

const MissionIdParam = MissionIdSchema;

function envIncidentCount(env: Env): number {
  return (env.NEMODOTS_INCIDENT_DOT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean).length;
}

export function nemodotsRoutes(deps: NemoDotsRouteDeps): Hono {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const probeTimeoutMs = deps.probeTimeoutMs ?? 3_000;
  const secrets = (deps.secrets ?? []).filter((s) => s.length >= 8);
  const streamOptions: EventStreamOptions = {
    ...DEFAULT_EVENT_STREAM_OPTIONS,
    ...deps.stream,
  };
  const report = (error: unknown, route: string) =>
    deps.onError?.({
      name: error instanceof Error ? error.name : typeof error,
      route,
    });
  const hub = new EventHub(deps.listenUrl, (error) => report(error, 'listen'));
  const health = createHealth({
    pool: deps.pool,
    env,
    listModels: deps.listModels,
    pingRedis: deps.pingRedis,
    checkout: deps.checkout ?? null,
    intelligenceConfigured:
      deps.intelligenceConfigured ??
      (() => Boolean(env.CPK_INTELLIGENCE_API_KEY?.trim())),
    incidentDotIds: deps.incidentDotIds ?? (() => envIncidentCount(env)),
    now,
    probeTimeoutMs,
    providerTtlMs: deps.providerTtlMs ?? 10_000,
  });

  const app = new Hono();

  app.onError((error, c) => {
    const mapped = mapError(error);
    if (mapped.status === 500 || mapped.status === 503)
      report(error, new URL(c.req.url).pathname);
    return c.json(mapped.body, mapped.status);
  });

  // ---------------------------------------------------------------- helpers

  /** JSON response that refuses to carry role URLs or configured secrets. */
  const send = (c: Context, body: unknown, status: 200 | 201 = 200) => {
    const text = JSON.stringify(body);
    if (URL_SCHEME.test(text) || secrets.some((s) => text.includes(s))) {
      report(new Error('response guard'), 'guard');
      throw new RouteError(500, 'Internal error.');
    }
    return c.body(text, status, { 'content-type': 'application/json' });
  };

  const readBody = async (c: Context): Promise<unknown> => {
    if (!c.req.header('content-type')?.includes('application/json'))
      throw new RouteError(415, 'Use application/json.');
    const text = await c.req.text();
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new RouteError(400, 'Request body must be valid JSON.');
    }
  };

  const missionId = (c: Context): MissionId => {
    const parsed = MissionIdParam.safeParse(c.req.param('id'));
    if (!parsed.success) throw new RouteError(400, 'Invalid mission id.');
    return parsed.data;
  };

  /** The path's mission, which must belong to the owner. The path is the scope. */
  const ownedMission = async (id: MissionId): Promise<void> => {
    const { rows } = await deps.pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM coordinator.missions WHERE id = $1`,
      [id],
    );
    if (!rows[0] || rows[0].owner_id !== deps.ownerId)
      throw new MissionNotFoundError(id);
  };

  const snapshotOf = async (c: Context): Promise<MissionSnapshot> => {
    const id = missionId(c);
    await ownedMission(id);
    return deps.control.snapshot(id);
  };

  const requireRunnable = () => {
    const resolved = resolveMode(env);
    if (resolved.mode === 'blocked')
      throw new BlockedError(resolved.missingEnv);
  };

  // ----------------------------------------------------------------- health

  app.get('/health', async (c) => {
    const status: HealthStatus = await health();
    return send(c, status);
  });

  // --------------------------------------------------------------- missions

  app.post('/missions', async (c) => {
    const request = CreateMissionRequestSchema.parse(await readBody(c));
    const resolved = resolveMode(env);
    if (resolved.mode === 'blocked')
      throw new BlockedError(resolved.missingEnv);
    // The mission mode is always the server-resolved mode (I11): a body mode
    // may only repeat it, and is not passed on.
    if (request.mode !== undefined && request.mode !== resolved.mode)
      throw new RouteError(
        400,
        'mode must equal the server mode or be omitted.',
      );
    const { mode: _mode, ...rest } = request;
    void _mode;
    const mission = await deps.control.create(rest);
    return send(c, mission, 201);
  });

  app.get('/missions', async (c) => {
    const { rows } = await deps.pool.query<MissionRow>(
      `SELECT * FROM coordinator.missions
        WHERE owner_id = $1
        ORDER BY created_at DESC, id
        LIMIT 200`,
      [deps.ownerId],
    );
    const missions: Mission[] = rows.map(toMission);
    return send(c, missions);
  });

  app.get('/missions/:id', async (c) => send(c, await snapshotOf(c)));

  app.post('/missions/:id/:action{start|pause|resume|cancel}', async (c) => {
    const id = missionId(c);
    const action = MissionLifecycleActionSchema.parse(c.req.param('action'));
    const body = await readBody(c);
    z.object({}).strict().parse(body);
    await ownedMission(id);
    if (action === 'start' || action === 'resume') requireRunnable();
    const mission = await deps.control[action](id);
    return send(c, mission);
  });

  // ------------------------------------------------------------ typed views

  app.get('/missions/:id/tasks', async (c) =>
    send(c, (await snapshotOf(c)).tasks),
  );
  app.get('/missions/:id/evidence', async (c) =>
    send(c, (await snapshotOf(c)).receipts),
  );
  app.get('/missions/:id/actions', async (c) =>
    send(c, (await snapshotOf(c)).actions),
  );
  app.get('/missions/:id/recovery', async (c) =>
    send(c, (await snapshotOf(c)).recoveries),
  );
  app.get('/missions/:id/telemetry', async (c) =>
    send(c, (await snapshotOf(c)).telemetry),
  );

  // -------------------------------------------------------------------- SSE

  app.get('/missions/:id/events', async (c) => {
    const id = missionId(c);
    await ownedMission(id);
    const header = c.req.header('last-event-id');
    let afterId = 0;
    if (header !== undefined && header.trim() !== '') {
      if (!/^\d{1,15}$/.test(header.trim()))
        throw new RouteError(400, 'Invalid Last-Event-ID.');
      afterId = Number(header.trim());
    }
    return missionEventStream(
      c,
      {
        pool: deps.pool,
        hub,
        options: streamOptions,
        now: () => Date.now(),
        onInvalidEvent: (info) => deps.onInvalidEvent?.(info),
        onError: (error) => report(error, 'events'),
      },
      id,
      afterId,
    );
  });

  // ---------------------------------------------------------------- sandbox

  app.post('/sandbox/sources/:key', async (c) => {
    const request = SourceEditRequestSchema.parse(await readBody(c));
    const raw = c.req.param('key');
    const key = memberKeyOf(raw) ?? raw;
    const check = validateConfigValue(key, request.value);
    if (!check.ok)
      throw new RouteError(
        400,
        check.reason === 'unknown_key'
          ? 'Unknown config key.'
          : 'Value is outside the key domain.',
      );
    const result = await deps.ownerEdit({
      key,
      value: check.value,
      expectedVersion: request.expectedVersion,
    });
    return send(c, {
      key: memberSourceKey(key),
      version: result.change.versionAfter,
    });
  });

  app.post('/sandbox/injector/run', async (c) => {
    const request = InjectorRunRequestSchema.parse(await readBody(c));
    const run = await deps.injector.run(request.scenarioClass);
    // Only the run id leaves the server; nothing about the scenario does.
    return send(c, { runId: run.runId });
  });

  app.get('/sandbox/checkout/health', async (c) => {
    if (!deps.checkout)
      throw new RouteError(503, 'The checkout sandbox is not configured.');
    const sampled = await fetchCheckoutHealth(
      deps.checkout,
      probeTimeoutMs,
      now(),
    );
    if (!sampled)
      throw new RouteError(503, 'The checkout sandbox is unreachable.');
    return send(c, sampled);
  });

  // -------------------------------------------------------------- telemetry

  app.get('/telemetry/summary', async (c) => {
    const raw = c.req.query('missionId');
    let id: MissionId | null = null;
    if (raw !== undefined && raw !== '') {
      const parsed = MissionIdParam.safeParse(raw);
      if (!parsed.success) throw new RouteError(400, 'Invalid mission id.');
      id = parsed.data;
      await ownedMission(id);
    }
    return send(c, await summarizeTelemetry(deps.pool, id));
  });

  app.get('/evals/report', async (c) => {
    let text: string;
    if (!deps.evalsReportPath)
      return send(c, { status: 'NOT_RUN' } satisfies EvalsReportResponse);
    try {
      text = await readFile(deps.evalsReportPath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT')
        return send(c, { status: 'NOT_RUN' } satisfies EvalsReportResponse);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RouteError(503, 'The evaluation report is unreadable.');
    }
    const report = EvalsReportResponseSchema.safeParse(parsed);
    if (!report.success)
      throw new RouteError(503, 'The evaluation report is malformed.');
    return send(c, report.data);
  });

  return app;
}
