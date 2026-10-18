// /api/nemodots routes over the real upstream middleware, real PostgreSQL and
// the real coordinator (CONTRACTS.md section 9).
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckoutHealthResponseSchema,
  HealthStatusSchema,
  MissionSchema,
  MissionSnapshotSchema,
  TelemetrySummarySchema,
  type Mission,
} from '../../../../src/server/nemodots/contracts/index.js';
import { UnknownScenarioError } from '../../../../src/server/nemodots/routes/index.js';
import { withHarness } from '../coordinator/harness.js';
import {
  FIXTURE_ENV,
  LIVE_ENV,
  LIVE_SECRET_KEY,
  OWNER_TOKEN,
  mountRoutes,
} from './harness.js';

const goal = { goal: 'checkout is failing for some customers' };

async function created(
  r: ReturnType<typeof mountRoutes>,
  body: unknown = goal,
): Promise<Mission> {
  const response = await r.post('/missions', body);
  expect(response.status).toBe(201);
  return MissionSchema.parse(await response.json());
}

describe('health', () => {
  it('reports mode, missing env names (never values) and the provider host', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {
        env: {
          OPENAI_API_KEY: LIVE_SECRET_KEY,
          OPENAI_MODEL: 'nvidia/test-model',
          OPENAI_BASE_URL: 'not a url',
        },
      });
      const text = await (await r.get('/health')).text();
      const body = HealthStatusSchema.parse(JSON.parse(text));
      expect(body.mode).toBe('blocked');
      expect(body.missingEnv).toEqual([]);
      expect(text).not.toContain(LIVE_SECRET_KEY);

      const blocked = mountRoutes(h, {
        env: { OPENAI_API_KEY: LIVE_SECRET_KEY },
      });
      const b = HealthStatusSchema.parse(
        await (await blocked.get('/health')).json(),
      );
      expect(b.mode).toBe('blocked');
      expect(b.missingEnv).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
      expect(b.provider.host).toBeNull();
      expect(b.postgres).toBe('ok');
      r.close();
      blocked.close();
    });
  });

  it('live: proves the configured model is served and names the host from OPENAI_BASE_URL', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {
        env: LIVE_ENV,
        listModels: async () => ['other', 'nvidia/test-model'],
        pingRedis: async () => true,
        checkout: {
          baseUrl: 'http://127.0.0.1:4510',
          fetch: (async () =>
            new Response(
              JSON.stringify({
                status: 'ok',
                checks: {
                  postgres: true,
                  redis: true,
                  config_parse: true,
                  writes: true,
                  cache: true,
                  pool: true,
                },
                errors: [],
              }),
              { status: 200 },
            )) as typeof fetch,
        },
        intelligenceConfigured: () => true,
        incidentDotIds: () => 3,
      });
      const text = await (await r.get('/health')).text();
      const body = HealthStatusSchema.parse(JSON.parse(text));
      expect(body).toMatchObject({
        mode: 'live',
        missingEnv: [],
        postgres: 'ok',
        redis: 'ok',
        checkout: { reachable: true, status: 'ok' },
        intelligence: 'configured',
        incidentDotIds: 3,
        provider: {
          reachable: true,
          modelListed: true,
          model: 'nvidia/test-model',
          host: 'inference.example.test',
        },
      });
      expect(text).not.toContain(LIVE_SECRET_KEY);
      expect(text).not.toContain('127.0.0.1:4510');
      r.close();
    });
  });
});

describe('POST /missions', () => {
  it('blocked mode answers 503 with the missing env names only', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { env: { OPENAI_API_KEY: LIVE_SECRET_KEY } });
      const response = await r.post('/missions', goal);
      expect(response.status).toBe(503);
      const text = await response.text();
      const body = JSON.parse(text) as { error: string; missingEnv: string[] };
      expect(Object.keys(body).sort()).toEqual(['error', 'missingEnv']);
      expect(body.missingEnv).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
      expect(text).not.toContain(LIVE_SECRET_KEY);
      const { rows } = await h.pool.query(
        'SELECT count(*)::int AS n FROM coordinator.missions',
      );
      expect(rows[0].n).toBe(0);
      r.close();
    });
  });

  it('stamps the server-resolved mode; a body mode must equal it or be omitted (I11)', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const omitted = await created(r);
      expect(omitted.mode).toBe('fixture');
      const equal = await created(r, { ...goal, mode: 'fixture' });
      expect(equal.mode).toBe('fixture');

      const mismatch = await r.post('/missions', { ...goal, mode: 'live' });
      expect(mismatch.status).toBe(400);
      expect(((await mismatch.json()) as { error: string }).error).toMatch(
        /server mode/,
      );
      const { rows } = await h.pool.query(
        'SELECT count(*)::int AS n FROM coordinator.missions',
      );
      expect(rows[0].n).toBe(2);
      r.close();
    });
  });

  it('validates every field strictly and bounds admission.minAgeMs to 0..60000', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      expect(
        (await created(r, { ...goal, admission: { minAgeMs: 0 } })).admission,
      ).toEqual({
        minAgeMs: 0,
      });
      expect(
        (await created(r, { ...goal, admission: { minAgeMs: 60_000 } }))
          .admission,
      ).toEqual({ minAgeMs: 60_000 });
      for (const bad of [
        { ...goal, admission: { minAgeMs: 60_001 } },
        { ...goal, admission: { minAgeMs: -1 } },
        { ...goal, admission: { minAgeMs: 1.5 } },
        { ...goal, admission: { minAgeMs: 1, extra: true } },
        { ...goal, ownerId: 'someone-else' },
        { ...goal, missionId: '4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80' },
        { goal: '' },
        {},
        { ...goal, constraints: 'not an array' },
      ]) {
        const response = await r.post('/missions', bad);
        expect(response.status, JSON.stringify(bad)).toBe(400);
      }
      expect((await r.post('/missions', '{not json')).status).toBe(400);
      r.close();
    });
  });

  it('lists the owner missions newest first', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const a = await created(r);
      const b = await created(r);
      const listed = (await (await r.get('/missions')).json()) as Mission[];
      expect(listed.map((m) => MissionSchema.parse(m).id)).toEqual([
        b.id,
        a.id,
      ]);
      // a mission owned by someone else is invisible: list and by id
      await h.admin.query(
        `UPDATE coordinator.missions SET owner_id = 'intruder' WHERE id = $1`,
        [a.id],
      );
      const after = (await (await r.get('/missions')).json()) as Mission[];
      expect(after.map((m) => m.id)).toEqual([b.id]);
      expect((await r.get(`/missions/${a.id}`)).status).toBe(404);
      expect((await r.post(`/missions/${a.id}/cancel`, {})).status).toBe(404);
      r.close();
    });
  });
});

describe('lifecycle', () => {
  it('start, pause, resume, cancel through MissionControlPort; illegal moves are 409', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await created(r);
      const act = async (action: string) => {
        const response = await r.post(`/missions/${mission.id}/${action}`, {});
        return {
          status: response.status,
          body: (await response.json()) as never,
        };
      };

      expect((await act('pause')).status).toBe(409); // created is not pausable
      expect((await act('resume')).status).toBe(409);
      const started = await act('start');
      expect(started.status).toBe(200);
      expect(MissionSchema.parse(started.body).status).toBe('running');
      expect((await act('start')).status).toBe(409);
      expect(MissionSchema.parse((await act('pause')).body).status).toBe(
        'paused',
      );
      expect((await act('pause')).status).toBe(409);
      expect(MissionSchema.parse((await act('resume')).body).status).toBe(
        'running',
      );
      const cancelled = await act('cancel');
      expect(MissionSchema.parse(cancelled.body).status).toBe('cancelled');
      expect((await act('cancel')).status).toBe(409);
      expect((await act('start')).status).toBe(409);
      r.close();
    });
  });

  it('rejects bodies with keys, unknown ids and malformed ids', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await created(r);
      expect(
        (await r.post(`/missions/${mission.id}/start`, { missionId: 'x' }))
          .status,
      ).toBe(400);
      expect(
        (
          await r.post(
            '/missions/4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80/start',
            {},
          )
        ).status,
      ).toBe(404);
      expect((await r.post('/missions/not-a-uuid/start', {})).status).toBe(400);
      expect((await r.get('/missions/not-a-uuid')).status).toBe(400);
      expect((await r.post(`/missions/${mission.id}/explode`, {})).status).toBe(
        404,
      );
      // an empty body is the same as {}
      const empty = await r.fetchApi(`/missions/${mission.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      expect(empty.status).toBe(200);
      r.close();
    });
  });

  it('a blocked server refuses to start or resume, but still pauses and cancels', async () => {
    await withHarness(async (h) => {
      const open = mountRoutes(h);
      const mission = await created(open);
      expect(
        (await open.post(`/missions/${mission.id}/start`, {})).status,
      ).toBe(200);
      const blocked = mountRoutes(h, { env: {} });
      expect(
        (await blocked.post(`/missions/${mission.id}/pause`, {})).status,
      ).toBe(200);
      const resume = await blocked.post(`/missions/${mission.id}/resume`, {});
      expect(resume.status).toBe(503);
      expect(
        ((await resume.json()) as { missingEnv: string[] }).missingEnv,
      ).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);
      expect(
        (await blocked.post(`/missions/${mission.id}/cancel`, {})).status,
      ).toBe(200);
      open.close();
      blocked.close();
    });
  });
});

describe('snapshot and typed views', () => {
  it('serves a schema-valid snapshot with no control data and no role URLs, and typed arrays', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { secrets: ['super-secret-probe-value'] });
      const mission = await created(r);
      await r.post(`/missions/${mission.id}/start`, {});
      const text = await (await r.get(`/missions/${mission.id}`)).text();
      const snapshot = MissionSnapshotSchema.parse(JSON.parse(text));
      expect(snapshot.mission.id).toBe(mission.id);
      expect(snapshot.tasks.length).toBeGreaterThan(0);
      expect(snapshot.lastEventId).toBeGreaterThan(0);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(
        [
          'actions',
          'attempts',
          'authorizations',
          'confirmations',
          'findings',
          'invalidations',
          'lastEventId',
          'mission',
          'outputs',
          'probe',
          'receipts',
          'recoveries',
          'results',
          'tasks',
          'telemetry',
        ].sort(),
      );
      expect(text).not.toMatch(/postgres(ql)?:\/\/|redis:\/\//i);
      expect(text).not.toMatch(/fault_schedule|scenario_run|"control"/i);

      const tasks = (await (
        await r.get(`/missions/${mission.id}/tasks`)
      ).json()) as unknown[];
      expect(tasks).toHaveLength(snapshot.tasks.length);
      for (const view of ['evidence', 'actions', 'recovery']) {
        const response = await r.get(`/missions/${mission.id}/${view}`);
        expect(response.status).toBe(200);
        expect(Array.isArray(await response.json())).toBe(true);
      }
      TelemetrySummarySchema.parse(
        await (await r.get(`/missions/${mission.id}/telemetry`)).json(),
      );
      expect(
        (await r.get('/missions/4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80/tasks'))
          .status,
      ).toBe(404);
      r.close();
    });
  });

  it('the response guard replaces a body carrying a role URL or a configured secret with a generic 500', async () => {
    await withHarness(async (h) => {
      const secret = 'probe-secret-0123456789abcdef';
      const dir = await mkdtemp(path.join(os.tmpdir(), 'nemodots-routes-'));
      const leaky = path.join(dir, 'report.json');
      await writeFile(
        leaky,
        JSON.stringify({
          status: 'PASS',
          generatedAt: new Date().toISOString(),
          summary: {
            note: 'connect postgres://nemodots_app:pw@127.0.0.1:55432/db',
          },
        }),
      );
      const withUrl = mountRoutes(h, {
        evalsReportPath: leaky,
        env: {
          ...FIXTURE_ENV,
          NEMODOTS_APP_URL: 'postgres://nemodots_app:pw@127.0.0.1:55432/db',
        },
      });
      const a = await withUrl.get('/evals/report');
      expect(a.status).toBe(500);
      expect(await a.json()).toEqual({ error: 'Internal error.' });

      await writeFile(
        leaky,
        JSON.stringify({
          status: 'PASS',
          generatedAt: new Date().toISOString(),
          summary: { note: `header ${secret}` },
        }),
      );
      const withSecret = mountRoutes(h, {
        evalsReportPath: leaky,
        secrets: [secret],
      });
      const b = await withSecret.get('/evals/report');
      expect(b.status).toBe(500);
      expect(await b.text()).not.toContain(secret);
      withUrl.close();
      withSecret.close();
    });
  });
});

describe('sandbox routes', () => {
  it('injector run returns {runId} only and passes the scenario class, nothing from the body ids', async () => {
    await withHarness(async (h) => {
      const calls: string[] = [];
      const r = mountRoutes(h, {
        injector: {
          async run(scenarioClass) {
            calls.push(scenarioClass);
            if (scenarioClass === 'missing_scenario')
              throw new UnknownScenarioError(scenarioClass);
            return {
              runId: 'run-0001',
              manifest: { oracle: 'secret' },
            } as { runId: string };
          },
        },
      });
      const response = await r.post('/sandbox/injector/run', {
        scenarioClass: 'benign_change',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ runId: 'run-0001' });
      expect(calls).toEqual(['benign_change']);
      expect(
        (await r.post('/sandbox/injector/run', { scenarioClass: 'Bad Class' }))
          .status,
      ).toBe(400);
      expect(
        (
          await r.post('/sandbox/injector/run', {
            scenarioClass: 'benign_change',
            seed: 1,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await r.post('/sandbox/injector/run', {
            scenarioClass: 'missing_scenario',
          })
        ).status,
      ).toBe(400);
      expect(calls).toEqual(['benign_change', 'missing_scenario']);
      r.close();
    });
  });

  it('proxies the checkout /health with sampledAt, and answers 503 when it is unreachable or unconfigured', async () => {
    await withHarness(async (h) => {
      const reply = (async () =>
        new Response(
          JSON.stringify({
            status: 'degraded',
            checks: {
              postgres: true,
              redis: true,
              config_parse: true,
              writes: false,
              cache: true,
              pool: true,
            },
            errors: ['writes_disabled'],
          }),
          { status: 503 },
        )) as typeof fetch;
      const r = mountRoutes(h, {
        checkout: { baseUrl: 'http://127.0.0.1:4510', fetch: reply },
        now: () => new Date('2026-10-17T10:00:00.000Z'),
      });
      const response = await r.get('/sandbox/checkout/health');
      expect(response.status).toBe(200);
      const body = CheckoutHealthResponseSchema.parse(await response.json());
      expect(body).toMatchObject({
        status: 'degraded',
        writes: false,
        errorClasses: ['writes_disabled'],
        sampledAt: '2026-10-17T10:00:00.000Z',
      });

      const down = mountRoutes(h, {
        checkout: {
          baseUrl: 'http://127.0.0.1:4510',
          fetch: (async () => {
            throw new Error('ECONNREFUSED');
          }) as typeof fetch,
        },
      });
      expect((await down.get('/sandbox/checkout/health')).status).toBe(503);
      const none = mountRoutes(h);
      expect((await none.get('/sandbox/checkout/health')).status).toBe(503);
      r.close();
      down.close();
      none.close();
    });
  });
});

describe('telemetry and evals', () => {
  it('serves a schema-valid summary globally and per owned mission', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await created(r);
      TelemetrySummarySchema.parse(
        await (await r.get('/telemetry/summary')).json(),
      );
      const scoped = TelemetrySummarySchema.parse(
        await (
          await r.get(`/telemetry/summary?missionId=${mission.id}`)
        ).json(),
      );
      expect(scoped.calls).toBe(0);
      expect((await r.get('/telemetry/summary?missionId=nope')).status).toBe(
        400,
      );
      expect(
        (
          await r.get(
            '/telemetry/summary?missionId=4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80',
          )
        ).status,
      ).toBe(404);
      r.close();
    });
  });

  it('evals report: NOT_RUN without a report, the stored report when present, 503 when malformed', async () => {
    await withHarness(async (h) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'nemodots-routes-'));
      const file = path.join(dir, 'report.json');
      const none = mountRoutes(h);
      expect(await (await none.get('/evals/report')).json()).toEqual({
        status: 'NOT_RUN',
      });
      const missing = mountRoutes(h, { evalsReportPath: file });
      expect(await (await missing.get('/evals/report')).json()).toEqual({
        status: 'NOT_RUN',
      });

      const report = {
        status: 'PASS',
        generatedAt: '2026-10-17T10:00:00.000Z',
        summary: { trials: 3 },
      };
      await writeFile(file, JSON.stringify(report));
      expect(await (await missing.get('/evals/report')).json()).toEqual(report);

      await writeFile(file, JSON.stringify({ status: 'MAYBE' }));
      expect((await missing.get('/evals/report')).status).toBe(503);
      await writeFile(file, '{oops');
      expect((await missing.get('/evals/report')).status).toBe(503);
      none.close();
      missing.close();
    });
  });
});

describe('upstream /api middleware applies to every route', () => {
  it('enforces OWNER_TOKEN, same-origin and JSON-only mutations', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await created(r);

      for (const route of [
        '/health',
        '/missions',
        `/missions/${mission.id}`,
        `/missions/${mission.id}/events`,
        '/telemetry/summary',
        '/evals/report',
      ])
        expect((await r.get(route, null)).status, route).toBe(401);
      expect((await r.get('/health', 'wrong-token')).status).toBe(401);
      expect((await r.post('/missions', goal, null)).status).toBe(401);
      expect((await r.get('/health', OWNER_TOKEN)).status).toBe(200);

      const crossOrigin = await r.fetchApi('/missions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify(goal),
      });
      expect(crossOrigin.status).toBe(403);
      const crossSite = await r.fetchApi('/missions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify(goal),
      });
      expect(crossSite.status).toBe(403);
      for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        const response = await r.fetchApi('/missions', {
          method: 'POST',
          headers: { 'content-type': type },
          body: JSON.stringify(goal),
        });
        expect(response.status, type).toBe(415);
      }
      const noType = await r.fetchApi(`/missions/${mission.id}/cancel`, {
        method: 'POST',
      });
      expect(noType.status).toBe(415);
      const huge = await r.fetchApi('/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x'.repeat(1_100_000) }),
      });
      expect(huge.status).toBe(413);
      const { rows } = await h.pool.query(
        'SELECT count(*)::int AS n FROM coordinator.missions',
      );
      expect(rows[0].n).toBe(1);
      r.close();
    });
  });

  it('the routes themselves reject non-JSON mutations when mounted without the upstream guard', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {}, { ownerToken: null });
      const response = await r.fetchApi('/missions', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(goal),
      });
      expect(response.status).toBe(415);
      r.close();
    });
  });
});

describe('review fixes', () => {
  it('a goal that mentions a URL scheme round-trips through create, list, snapshot and views', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const text = 'checkout cannot reach redis://cache after deploy';
      const mission = await created(r, { goal: text });
      expect(mission.goal).toBe(text);
      const list = (await (await r.get('/missions')).json()) as Mission[];
      expect(list.map((m) => m.goal)).toEqual([text]);
      const snap = await r.get(`/missions/${mission.id}`);
      expect(snap.status).toBe(200);
      expect((await snap.json()).mission.goal).toBe(text);
      expect((await r.get(`/missions/${mission.id}/tasks`)).status).toBe(200);
      r.close();
    });
  });

  it('the guard still blocks the real role URLs from the environment', async () => {
    await withHarness(async (h) => {
      const url = 'redis://:hunter2hunter2@127.0.0.1:56379/0';
      const r = mountRoutes(h, {
        env: { ...FIXTURE_ENV, NEMODOTS_REDIS_URL: url },
      });
      const response = await r.post('/missions', { goal: `leak ${url}` });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('hunter2');
      r.close();
    });
  });

  it('a route env that disagrees with the coordinator mode is a 400, not a mislabelled mission', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { env: LIVE_ENV });
      for (const body of [goal, { ...goal, mode: 'live' }]) {
        const response = await r.post('/missions', body);
        expect(response.status).toBe(400);
      }
      const { rows } = await h.pool.query(
        'SELECT count(*)::int AS n FROM coordinator.missions',
      );
      expect(rows[0].n).toBe(0);
      r.close();
    });
  });

  it('construction fails when ownerId differs from the coordinator owner', async () => {
    await withHarness(async (h) => {
      expect(() =>
        mountRoutes(h, { coordinatorOwnerId: 'someone-else' }),
      ).toThrow(/ownerId/);
      expect(() =>
        mountRoutes(h, { coordinatorOwnerId: 'owner' }),
      ).not.toThrow();
    });
  });
});
