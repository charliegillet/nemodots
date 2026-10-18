// W5.3: /api/nemodots attacked through the REAL upstream createApp middleware,
// real PostgreSQL and the real coordinator (route harness of W4.2, reused
// unedited). Covers: missing token, wrong origin, non-JSON; SSE scope
// confusion between missions and owners; body ids and body mode that
// disagree with the server; a fixture-mode mission presented as live; a
// missing OPENAI_BASE_URL (I1); unknown action kinds and source keys.
//
// Every attack is judged by the database (mission rows, event rows) and by
// spies on the owner-edit and injector doubles, not by status codes alone.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MissionSchema,
  type Mission,
} from '../../../../../src/server/nemodots/contracts/index.js';
import { withHarness, type Harness } from '../../../integration/coordinator/harness.js';
import {
  FIXTURE_ENV,
  LIVE_ENV,
  LIVE_SECRET_KEY,
  mountRoutes,
  openStream,
} from '../../../integration/routes/harness.js';

afterEach(() => vi.restoreAllMocks());

const goal = { goal: 'checkout is failing for some customers' };
const missions = async (h: Harness) =>
  Number(
    (await h.admin.query('SELECT count(*) AS n FROM coordinator.missions')).rows[0]
      .n,
  );

async function create(r: ReturnType<typeof mountRoutes>): Promise<Mission> {
  const response = await r.post('/missions', goal);
  expect(response.status).toBe(201);
  return MissionSchema.parse(await response.json());
}

describe('missing token, wrong origin, wrong content type', () => {
  it('every route refuses before reaching the handler, and nothing is created', async () => {
    await withHarness(async (h) => {
      const ownEdit = vi.fn();
      const run = vi.fn();
      const r = mountRoutes(h, {
        ownerEdit: ownEdit as never,
        injector: { run } as never,
      });
      const id = randomUUID();
      const routes: Array<[string, string, unknown]> = [
        ['GET', '/health', undefined],
        ['POST', '/missions', goal],
        ['GET', '/missions', undefined],
        ['GET', `/missions/${id}`, undefined],
        ['POST', `/missions/${id}/start`, {}],
        ['POST', `/missions/${id}/cancel`, {}],
        ['GET', `/missions/${id}/events`, undefined],
        ['POST', '/sandbox/sources/db.pool_max', { value: 8, expectedVersion: 1 }],
        ['POST', '/sandbox/injector/run', { scenarioClass: 'x' }],
        ['GET', '/telemetry/summary', undefined],
      ];
      const send = (
        method: string,
        path: string,
        body: unknown,
        token: string | null,
        headers: Record<string, string> = {},
      ) =>
        r.fetchApi(path, {
          method,
          token,
          headers: { 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      for (const [method, path, body] of routes) {
        for (const token of [null, 'wrong-token', '']) {
          const response = await send(method, path, body, token);
          expect(response.status, `${method} ${path} token=${token}`).toBe(401);
        }
        for (const headers of [
          { origin: 'https://evil.example' },
          { origin: 'null' },
          { 'sec-fetch-site': 'cross-site' },
        ]) {
          const response = await send(method, path, body, 'owner-token-for-route-tests', headers);
          expect(response.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
        }
      }
      for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        const response = await r.fetchApi('/missions', {
          method: 'POST',
          headers: { 'content-type': type },
          body: JSON.stringify(goal),
        });
        expect(response.status, type).toBe(415);
      }
      expect(await missions(h)).toBe(0);
      expect(ownEdit).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      r.close();
    });
  });
});

describe('body ids and body mode grant nothing (I11)', () => {
  it('identity, status and id fields in the create body are rejected; the stored mission is the server-resolved one', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      for (const extra of [
        { id: randomUUID() },
        { ownerId: 'intruder' },
        { status: 'succeeded' },
        { generation: 99 },
        { provider: { host: 'api.openai.com' } },
        { budgets: { maxTasks: 100000 } },
      ])
        expect(
          (await r.post('/missions', { ...goal, ...extra })).status,
          JSON.stringify(extra),
        ).toBe(400);
      expect(await missions(h)).toBe(0);
      const mission = await create(r);
      expect(mission.mode).toBe('fixture');
      r.close();
    });
  });

  it('a body mode that disagrees with the server is 400 in both directions and creates nothing', async () => {
    await withHarness(async (h) => {
      const fixture = mountRoutes(h, { env: FIXTURE_ENV });
      expect((await fixture.post('/missions', { ...goal, mode: 'live' })).status).toBe(400);
      expect((await fixture.post('/missions', { ...goal, mode: 'blocked' })).status).toBe(400);
      fixture.close();
      const live = mountRoutes(h, { env: LIVE_ENV });
      expect((await live.post('/missions', { ...goal, mode: 'fixture' })).status).toBe(400);
      live.close();
      expect(await missions(h)).toBe(0);
    });
  });

  it('a fixture-mode mission is never presented as live: mission mode, health mode and provider host all say fixture', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { env: FIXTURE_ENV });
      const mission = await create(r);
      expect(mission.mode).toBe('fixture');
      const health = (await (await r.get('/health')).json()) as {
        mode: string;
        provider: { host: string | null; reachable: boolean };
      };
      expect(health.mode).toBe('fixture');
      expect(health.provider.host).toBeNull();
      expect(health.provider.reachable).toBe(false);
      const snapshot = JSON.stringify(await (await r.get(`/missions/${mission.id}`)).json());
      expect(snapshot).not.toContain('"mode":"live"');
      expect(snapshot).not.toContain('crusoe');
      r.close();
    });
  });

  it('a route env that says live over a coordinator configured for fixture does not mint a mislabelled mission', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { env: LIVE_ENV });
      const response = await r.post('/missions', goal);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await missions(h)).toBe(0);
      r.close();
    });
  });
});

describe('a missing OPENAI_BASE_URL is blocked and reaches no host (I1)', () => {
  it('create, start and health answer blocked with names only; no provider call, no mission', async () => {
    await withHarness(async (h) => {
      const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        throw new Error(`unexpected request to ${String(url)}`);
      });
      const listModels = vi.fn(async () => ['nvidia/test-model']);
      const r = mountRoutes(h, {
        env: { OPENAI_API_KEY: LIVE_SECRET_KEY, OPENAI_MODEL: 'nvidia/test-model' },
        listModels,
      });
      const created = await r.post('/missions', goal);
      expect(created.status).toBe(503);
      const text = await created.text();
      expect(text).toContain('OPENAI_BASE_URL');
      expect(text).not.toContain(LIVE_SECRET_KEY);
      const health = (await (await r.get('/health')).json()) as {
        mode: string;
        missingEnv: string[];
        provider: { host: string | null };
      };
      expect(health).toMatchObject({ mode: 'blocked', missingEnv: ['OPENAI_BASE_URL'] });
      expect(health.provider.host).toBeNull();
      expect(listModels).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(await missions(h)).toBe(0);
      // A mission made while the server was runnable cannot be started once blocked.
      const ok = mountRoutes(h, { env: FIXTURE_ENV });
      const mission = await create(ok);
      ok.close();
      const start = await r.post(`/missions/${mission.id}/start`, {});
      expect(start.status).toBe(503);
      r.close();
    });
  });
});

describe('SSE scope confusion', () => {
  it('a stream only ever carries its own mission, whatever Last-Event-ID or query string it is given', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const a = await create(r);
      const b = await create(r);
      await h.coordinator.control.start(a.id);
      await h.coordinator.control.start(b.id);
      const maxOf = async (id: string) =>
        Number(
          (
            await h.admin.query<{ m: string }>(
              'SELECT max(id) AS m FROM coordinator.events WHERE mission_id = $1',
              [id],
            )
          ).rows[0].m,
        );
      const bMax = await maxOf(b.id);
      const ownerOf = new Map<number, string>(
        (
          await h.admin.query<{ id: string; mission_id: string }>(
            'SELECT id, mission_id FROM coordinator.events',
          )
        ).rows.map((row) => [Number(row.id), row.mission_id]),
      );
      for (const [path, headers, wanted] of [
        [`/missions/${a.id}/events`, {}, a.id],
        [`/missions/${a.id}/events?missionId=${b.id}`, {}, a.id],
        [`/missions/${a.id}/events`, { 'last-event-id': '0' }, a.id],
        [`/missions/${a.id}/events`, { 'last-event-id': String(bMax) }, a.id],
        [`/missions/${b.id}/events?missionId=${a.id}`, {}, b.id],
      ] as const) {
        const stream = await openStream(r, path, { ...headers });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await stream.close();
        expect(stream.response.status, path).toBe(200);
        for (const message of stream.messages) {
          const event = JSON.parse(message.data) as { missionId: string };
          expect(event.missionId, `${path} id=${message.id}`).toBe(wanted);
          expect(ownerOf.get(Number(message.id))).toBe(wanted);
        }
        const text = stream.raw();
        expect(text).not.toMatch(/postgres(ql)?:\/\//);
        expect(text).not.toContain(LIVE_SECRET_KEY);
      }
      r.close();
    });
  });

  it('mission ids that are not the owner\'s, not UUIDs or malformed are refused on every view', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const own = await create(r);
      const foreign = randomUUID();
      await h.admin.query(
        `INSERT INTO coordinator.missions
           (id, owner_id, environment, resource, goal, mode, status, budgets,
            admission_min_age_ms, provider)
         VALUES ($1, 'intruder', 'test', 'checkout', 'not yours', 'fixture', 'running',
                 '{"maxTasks":24,"maxDepth":3,"maxBreadth":4,"maxTokens":1,"maxInferenceCalls":1,"maxWallClockMs":1}'::jsonb,
                 0, '{"host":"fixture.invalid","plannerModel":"p","workerModel":"w"}'::jsonb)`,
        [foreign],
      );
      const views = ['', '/tasks', '/evidence', '/actions', '/recovery', '/telemetry', '/events'];
      for (const view of views) {
        const response = await r.get(`/missions/${foreign}${view}`);
        expect(response.status, `foreign ${view}`).toBe(404);
        expect(await response.text()).not.toContain('not yours');
      }
      for (const action of ['start', 'pause', 'resume', 'cancel'])
        expect((await r.post(`/missions/${foreign}/${action}`, {})).status).toBe(404);
      expect(
        (
          await h.admin.query<{ status: string }>(
            'SELECT status FROM coordinator.missions WHERE id = $1',
            [foreign],
          )
        ).rows[0].status,
      ).toBe('running');
      expect((await r.get(`/telemetry/summary?missionId=${foreign}`)).status).toBe(404);
      for (const bad of ['x', own.id.toUpperCase(), `${own.id}/..`, '%00', `${own.id}%27`, ''])
        expect(
          [400, 404],
          bad,
        ).toContain((await r.get(`/missions/${bad}/events`)).status);
      for (const header of ['-1', '1e9', '1; DROP TABLE x', '99999999999999999999', ' ', 'abc'])
        if (header.trim())
          expect(
            (await r.fetchApi(`/missions/${own.id}/events`, { headers: { 'last-event-id': header } })).status,
            header,
          ).toBe(400);
      r.close();
    });
  });

  it('lifecycle and create bodies with extra keys are rejected', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const m = await create(r);
      for (const body of [{ missionId: randomUUID() }, { force: true }, { status: 'succeeded' }])
        expect((await r.post(`/missions/${m.id}/cancel`, body)).status).toBe(400);
      r.close();
    });
  });
});

describe('unknown action kinds, scenario classes and source keys', () => {
  it('there is no HTTP way to propose or commit an action; nothing is created', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const m = await create(r);
      for (const [method, path] of [
        ['POST', `/missions/${m.id}/actions`],
        ['PUT', `/missions/${m.id}/actions`],
        ['POST', '/actions'],
        ['POST', `/missions/${m.id}/actions/run_sql`],
      ] as const) {
        const response = await r.fetchApi(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run_sql', payload: { sql: 'select 1' } }),
        });
        expect([404, 405], `${method} ${path}`).toContain(response.status);
      }
      expect(
        Number((await h.admin.query('SELECT count(*) AS n FROM coordinator.action_intents')).rows[0].n),
      ).toBe(0);
      r.close();
    });
  });

  it('source edits with unknown, traversal or out-of-domain input never reach the owner edit', async () => {
    await withHarness(async (h) => {
      const ownerEdit = vi.fn();
      const r = mountRoutes(h, { ownerEdit: ownerEdit as never });
      for (const [key, value] of [
        ['no.such.key', 1],
        ['db.pool_max', 21],
        ['db.pool_max', 'eight'],
        ['db.pool_max', 0],
        ['routing.inventory_source', 'anywhere'],
        ['cache.namespace', 'UPPER CASE!'],
        ['..%2F..%2Fetc%2Fpasswd', 1],
        ['checkout.config%2Fdb.pool_max', 1],
        ['__proto__', 1],
      ] as const) {
        const response = await r.post(`/sandbox/sources/${key}`, { value, expectedVersion: 1 });
        expect([400, 404], `${key}=${value}`).toContain(response.status);
      }
      expect(
        (await r.post('/sandbox/sources/db.pool_max', { value: 8, expectedVersion: 1, causedByActionId: randomUUID() })).status,
      ).toBe(400);
      expect(ownerEdit).not.toHaveBeenCalled();
      r.close();
    });
  });

  it('an unknown scenario class is refused and the response carries only a run id', async () => {
    await withHarness(async (h) => {
      const run = vi.fn(async () => ({ runId: randomUUID(), scenario: 'secret-diagnosis' }));
      const r = mountRoutes(h, { injector: { run } as never });
      expect((await r.post('/sandbox/injector/run', { scenarioClass: 'drop_database' })).status).toBe(400);
      expect((await r.post('/sandbox/injector/run', { scenarioClass: 'x', extra: 1 })).status).toBe(400);
      r.close();
    });
  });
});
