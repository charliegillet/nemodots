// /api/nemodots routes (CONTRACTS section 9). Thin: authority is the
// authenticated owner supplied in `deps.ownerId`; a mission id from the URL is
// only a lookup key and is checked against that owner. Mount this on the
// upstream app AFTER its `/api/*` middleware (owner token, origin and JSON
// checks), which composition (W5.1) does:
//   app.route('/api/nemodots', nemodotsRoutes(deps))
import { Hono } from 'hono';
import type { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  CheckoutHealthResponseSchema,
  CreateMissionRequestSchema,
  EvalsReportResponseSchema,
  LifecycleRequestSchema,
  MissionIdSchema,
  MissionSchema,
  MissionSnapshotSchema,
  SourceEditRequestSchema,
  InjectorRunRequestSchema,
  InjectorRunResponseSchema,
  SourceEditResponseSchema,
  TelemetrySummarySchema,
  sourceKeyFamily,
  type Mission,
  type MissionId,
  type MissionLifecycleAction,
} from '../contracts/index.js';
import { toMission, type MissionRow } from '../coordinator/rows.js';
import {
  BadRequestError,
  BlockedError,
  NotFoundError,
  ResponseContractError,
  handleError,
} from './errors.js';
import { buildHealth } from './health.js';
import { eventStream, parseLastEventId } from './sse.js';
import type { NemodotsRouteDeps } from './types.js';

export * from './errors.js';
export * from './notifier.js';
export * from './sse.js';
export type * from './types.js';
export { buildHealth } from './health.js';

const CONFIG_PREFIX = 'checkout.config/';

/** Validates a server-built response; a failure is a server fault (500), not a bad request. */
function respond<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResponseContractError();
  return parsed.data;
}

export function nemodotsRoutes(deps: NemodotsRouteDeps) {
  const app = new Hono();
  app.onError(handleError);

  const missionId = (raw: string): MissionId => {
    const parsed = MissionIdSchema.safeParse(raw);
    if (!parsed.success) throw new NotFoundError();
    return parsed.data;
  };
  /** The mission, only if it belongs to the authenticated owner; else 404. */
  const owned = async (raw: string): Promise<Mission> => {
    const id = missionId(raw);
    const mission = await deps.control.get(id);
    if (mission.scope.ownerId !== deps.ownerId) throw new NotFoundError();
    return mission;
  };
  const emptyBody = async (c: { req: { json(): Promise<unknown> } }) => {
    LifecycleRequestSchema.parse(await c.req.json().catch(() => null));
  };

  app.get('/health', async (c) => c.json(await buildHealth(deps)));

  app.post('/missions', async (c) => {
    const request = CreateMissionRequestSchema.parse(
      await c.req.json().catch(() => null),
    );
    const mode = deps.mode();
    if (mode.mode === 'blocked')
      throw new BlockedError([...mode.missingEnv, ...mode.invalidEnv].sort());
    if (request.mode !== undefined && request.mode !== mode.mode)
      throw new BadRequestError(
        'The requested mode does not match the server mode.',
      );
    // The mode is the server's, never the caller's.
    const created = await deps.control.create({ ...request, mode: mode.mode });
    return c.json(respond(MissionSchema, created), 201);
  });

  app.get('/missions', async (c) => {
    const { rows } = await deps.pool.query<MissionRow>(
      `SELECT * FROM coordinator.missions WHERE owner_id = $1 ORDER BY created_at DESC, id`,
      [deps.ownerId],
    );
    return c.json(rows.map((row) => respond(MissionSchema, toMission(row))));
  });

  app.get('/missions/:id', async (c) => {
    const mission = await owned(c.req.param('id'));
    return c.json(
      respond(MissionSnapshotSchema, await deps.control.snapshot(mission.id)),
    );
  });

  const lifecycle: MissionLifecycleAction[] = [
    'start',
    'pause',
    'resume',
    'cancel',
  ];
  for (const action of lifecycle)
    app.post(`/missions/:id/${action}`, async (c) => {
      const mission = await owned(c.req.param('id'));
      await emptyBody(c);
      const result = await deps.control[action](mission.id);
      return c.json(respond(MissionSchema, result));
    });

  app.get('/missions/:id/events', async (c) => {
    const mission = await owned(c.req.param('id'));
    const last = parseLastEventId(c.req.header('last-event-id'));
    return eventStream(c, deps, mission.id, last);
  });

  const views = {
    tasks: 'tasks',
    evidence: 'receipts',
    actions: 'actions',
    recovery: 'recoveries',
    telemetry: 'telemetry',
  } as const;
  for (const [route, field] of Object.entries(views))
    app.get(`/missions/:id/${route}`, async (c) => {
      const mission = await owned(c.req.param('id'));
      const snapshot = respond(
        MissionSnapshotSchema,
        await deps.control.snapshot(mission.id),
      );
      return c.json(snapshot[field as keyof typeof snapshot]);
    });

  app.post('/sandbox/sources/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    if (sourceKeyFamily(key) !== 'checkout.config/<key>')
      throw new BadRequestError(
        'Only controlled configuration members can be edited.',
      );
    const body = SourceEditRequestSchema.parse(
      await c.req.json().catch(() => null),
    );
    const { change } = await deps.ownerEdit({
      key: key.slice(CONFIG_PREFIX.length),
      value: body.value as never,
      expectedVersion: body.expectedVersion,
    });
    return c.json(
      respond(SourceEditResponseSchema, {
        key: `${CONFIG_PREFIX}${change.key}`,
        version: change.versionAfter,
      }),
    );
  });

  app.post('/sandbox/injector/run', async (c) => {
    const body = InjectorRunRequestSchema.parse(
      await c.req.json().catch(() => null),
    );
    const { runId } = await deps.startInjector(body.scenarioClass);
    // Only the run id leaves: no manifest, schedule, seed or step detail.
    return c.json(respond(InjectorRunResponseSchema, { runId }));
  });

  app.get('/sandbox/checkout/health', async (c) => {
    let raw: unknown;
    try {
      raw = await deps.checkoutHealth();
    } catch {
      return c.json({ error: 'Checkout is unreachable.' }, 502);
    }
    const parsed = CheckoutHealthResponseSchema.safeParse(raw);
    if (!parsed.success)
      return c.json(
        { error: 'Checkout returned an unusable health report.' },
        502,
      );
    return c.json(parsed.data);
  });

  app.get('/telemetry/summary', async (c) => {
    const raw = c.req.query('missionId');
    const mission = raw === undefined ? undefined : await owned(raw);
    if (!deps.telemetry) throw new Error('telemetry source is not configured');
    return c.json(
      respond(TelemetrySummarySchema, await deps.telemetry(mission?.id)),
    );
  });

  app.get('/evals/report', async (c) => {
    const raw = deps.evalsReport ? await deps.evalsReport() : null;
    const parsed = EvalsReportResponseSchema.safeParse(raw);
    return c.json(parsed.success ? parsed.data : { status: 'NOT_RUN' });
  });

  return app;
}

/** Reads a checked-in eval summary; anything missing or malformed is NOT_RUN. */
export function evalsReportFromFile(path: string) {
  return async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return { status: 'NOT_RUN' };
    }
  };
}
