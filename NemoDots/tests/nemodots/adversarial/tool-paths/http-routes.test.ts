// W5.3: the /api/nemodots surface as the deployed app serves it: createApp
// (upstream /api/* middleware: owner token, host, origin, JSON) with the
// composed router from createNemoDots on a fresh database. Two NemoDots
// routers over one database stand in for two owners. The provider is a local
// stub (labelled; mission control never calls it here).
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import { stubProvider, STUB_MODEL } from './composed-harness.js';

const TOKEN = 'adversary-owner-token-0123456789';
const ORIGIN = 'http://localhost:4310';
const PROBE_SECRET = 'probe-secret-for-adversary-tests-0123';

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function envFor(
  db: TestDatabase,
  redis: { url: string; prefix: string },
  baseUrl: string | undefined,
) {
  return {
    NEMODOTS_INSTANCE: 'dev',
    NEMODOTS_PG_URL_APP: db.urls.app,
    NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
    NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
    NEMODOTS_PROBE_SECRET: PROBE_SECRET,
    NEMODOTS_REDIS_URL: redis.url,
    NEMODOTS_REDIS_PREFIX: redis.prefix,
    NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:9',
    NEMODOTS_WATCH_INTERVAL_MS: '60000',
    NEMODOTS_WORKERS: '0',
    OPENAI_API_KEY: 'adversary-stub-key-0123456789',
    OPENAI_MODEL: STUB_MODEL,
    OPENAI_BASE_URL: baseUrl,
  } as Record<string, string | undefined>;
}

interface Surface {
  db: TestDatabase;
  app: ReturnType<typeof createApp>;
  mine: NemoDots;
  other: NemoDots;
  call(
    path: string,
    init?: RequestInit & { token?: string | null },
  ): Promise<Response>;
}

async function withSurface<T>(
  fn: (s: Surface) => Promise<T>,
  options: {
    baseUrl?: 'stub' | 'missing';
    ownerToken?: boolean;
    /** Extra environment for the owner's router only. */
    env?: Record<string, string>;
  } = {},
): Promise<T> {
  return withTestDatabase((db) =>
    withTestRedis(async (redis) => {
      const provider = await stubProvider(() => ({ content: '{"tasks":[]}' }));
      closers.push(() => provider.close());
      const baseUrl =
        options.baseUrl === 'missing' ? undefined : provider.baseUrl;
      const mine = createNemoDots(
        { ...envFor(db, redis, baseUrl), ...options.env },
        { workspace: { ownerId: 'owner' } },
      );
      const other = createNemoDots(envFor(db, redis, baseUrl), {
        workspace: { ownerId: 'owner-b' },
      });
      closers.push(
        () => mine.stop(),
        () => other.stop(),
      );
      const store = new Store(':memory:');
      closers.push(() => store.close());
      const config = {
        mode: 'live' as const,
        baseUrl: 'https://unused.invalid',
      };
      const app = createApp({
        store,
        runner: new Runner(store, config),
        config,
        nemodots: mine,
        ownerToken: options.ownerToken === false ? undefined : TOKEN,
        origin: ORIGIN,
      });
      const call = (
        path: string,
        init: RequestInit & { token?: string | null } = {},
      ) => {
        const headers = new Headers(init.headers);
        const token = init.token === undefined ? TOKEN : init.token;
        if (token !== null) headers.set('authorization', `Bearer ${token}`);
        if (init.body !== undefined && !headers.has('content-type'))
          headers.set('content-type', 'application/json');
        return Promise.resolve(
          app.request(
            path.startsWith('http') ? path : `http://localhost${path}`,
            { ...init, headers },
          ),
        );
      };
      return fn({ db, app, mine, other, call });
    }),
  );
}

const json = (body: unknown) => JSON.stringify(body);

async function createMission(s: Surface) {
  const response = await s.call('/api/nemodots/missions', {
    method: 'POST',
    body: json({ goal: 'restore checkout availability' }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function otherOwnersMission(s: Surface) {
  const response = await Promise.resolve(
    s.other.router.request('/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ goal: 'another owner mission' }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe('owner token, host and origin (upstream middleware applies to /api/nemodots)', () => {
  it('TP-40 every NemoDots route needs the owner token', async () => {
    await withSurface(async (s) => {
      const id = await createMission(s);
      const routes: [string, string][] = [
        ['GET', '/api/nemodots/health'],
        ['GET', '/api/nemodots/missions'],
        ['POST', '/api/nemodots/missions'],
        ['GET', `/api/nemodots/missions/${id}`],
        ['GET', `/api/nemodots/missions/${id}/events`],
        ['POST', `/api/nemodots/missions/${id}/start`],
        ['POST', '/api/nemodots/sandbox/sources/checkout.config%2Fdb.pool_max'],
        ['POST', '/api/nemodots/sandbox/injector/run'],
        ['GET', '/api/nemodots/telemetry/summary'],
      ];
      for (const token of [
        null,
        'wrong-token',
        `${TOKEN}x`,
        TOKEN.slice(1),
        TOKEN.toUpperCase(),
      ])
        for (const [method, path] of routes) {
          const response = await s.call(path, {
            method,
            token,
            body: method === 'POST' ? json({}) : undefined,
          });
          expect(response.status, `${method} ${path} token=${token}`).toBe(401);
        }
    });
  });

  it('TP-41 a wrong Origin, Origin null or a cross-site fetch is refused even with the token', async () => {
    await withSurface(async (s) => {
      const cases: Record<string, string>[] = [
        { origin: 'http://evil.example' },
        { origin: 'null' },
        { origin: 'http://localhost:4311' },
        { 'sec-fetch-site': 'cross-site' },
      ];
      for (const headers of cases) {
        const response = await s.call('/api/nemodots/missions', {
          method: 'POST',
          headers,
          body: json({ goal: 'restore checkout availability' }),
        });
        expect(response.status, JSON.stringify(headers)).toBe(403);
      }
    });
  });

  it('TP-41b without an owner token only loopback Host names are served (DNS rebinding)', async () => {
    await withSurface(
      async (s) => {
        const response = await s.call(
          'http://evil.example/api/nemodots/missions',
          {
            token: null,
          },
        );
        expect(response.status).toBe(403);
      },
      { ownerToken: false },
    );
  });

  it('TP-42 mutations need application/json; a JSON-looking text/plain from another origin is refused by origin', async () => {
    await withSurface(async (s) => {
      const plain = await s.call('/api/nemodots/missions', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: json({ goal: 'restore checkout availability' }),
      });
      expect(plain.status).toBe(415);
      // The JSON check is a substring test (app.ts:96), so this CORS
      // "simple" content type passes it; the Origin check still refuses it.
      const sneaky = await s.call('/api/nemodots/missions', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; x=application/json',
          origin: 'http://evil.example',
        },
        body: json({ goal: 'restore checkout availability' }),
      });
      expect(sneaky.status).toBe(403);
    });
  });
});

describe("mode is the server's (I11, I1)", () => {
  it('TP-43 a body mode that disagrees with the server is 400; equal or omitted is accepted', async () => {
    await withSurface(async (s) => {
      const post = (body: unknown) =>
        s.call('/api/nemodots/missions', { method: 'POST', body: json(body) });
      const goal = 'restore checkout availability';
      expect((await post({ goal, mode: 'fixture' })).status).toBe(400);
      expect((await post({ goal, mode: 'blocked' })).status).toBe(400);
      expect((await post({ goal, mode: 'LIVE' })).status).toBe(400);
      const ok = await post({ goal, mode: 'live' });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { mode: string }).mode).toBe('live');
    });
  });

  it('TP-43b with OPENAI_BASE_URL missing: health names it, creation is 503, no value leaks', async () => {
    await withSurface(
      async (s) => {
        const health = (await (
          await s.call('/api/nemodots/health')
        ).json()) as {
          mode: string;
          missingEnv: string[];
          provider: { host: string | null };
        };
        expect(health.mode).toBe('blocked');
        expect(health.missingEnv).toEqual(['OPENAI_BASE_URL']);
        expect(health.provider.host).toBeNull();
        const create = await s.call('/api/nemodots/missions', {
          method: 'POST',
          body: json({ goal: 'restore checkout availability', mode: 'live' }),
        });
        expect(create.status).toBe(503);
        const text = await create.text();
        expect(text).toContain('OPENAI_BASE_URL');
        expect(text).not.toContain('adversary-stub-key');
      },
      { baseUrl: 'missing' },
    );
  });
});

describe('owner and mission scope (I10)', () => {
  it("TP-44 another owner's mission is invisible on every route", async () => {
    await withSurface(async (s) => {
      await createMission(s);
      const foreign = await otherOwnersMission(s);
      for (const path of [
        `/api/nemodots/missions/${foreign}`,
        `/api/nemodots/missions/${foreign}/events`,
        `/api/nemodots/missions/${foreign}/tasks`,
        `/api/nemodots/missions/${foreign}/evidence`,
        `/api/nemodots/missions/${foreign}/actions`,
        `/api/nemodots/telemetry/summary?missionId=${foreign}`,
      ])
        expect((await s.call(path)).status, path).toBe(404);
      for (const action of ['start', 'pause', 'resume', 'cancel'])
        expect(
          (
            await s.call(`/api/nemodots/missions/${foreign}/${action}`, {
              method: 'POST',
              body: json({}),
            })
          ).status,
          action,
        ).toBe(404);
      const list = (await (await s.call('/api/nemodots/missions')).json()) as {
        id: string;
      }[];
      expect(list.map((m) => m.id)).not.toContain(foreign);
    });
  });

  it("TP-45 the SSE stream of one mission carries only that mission's events, whatever Last-Event-ID says", async () => {
    await withSurface(async (s) => {
      const mine = await createMission(s);
      const foreign = await otherOwnersMission(s);
      const other = await createMission(s); // same owner, another mission
      const { rows } = await (async () => {
        const pg = (await import('pg')).default;
        const pool = new pg.Pool({ connectionString: s.db.urls.admin, max: 1 });
        pool.on('error', () => undefined);
        try {
          return await pool.query<{ id: string; mission_id: string }>(
            'SELECT id, mission_id FROM coordinator.events ORDER BY id',
          );
        } finally {
          await pool.end();
        }
      })();
      const foreignIds = rows
        .filter((r) => r.mission_id !== mine)
        .map((r) => String(r.id));
      expect(foreignIds.length).toBeGreaterThan(0);
      for (const last of ['', '0', String(Number(rows.at(-1)!.id) + 100)]) {
        const controller = new AbortController();
        const response = await s.call(`/api/nemodots/missions/${mine}/events`, {
          headers: last ? { 'last-event-id': last } : {},
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        let text = '';
        const deadline = Date.now() + 1500;
        while (
          Date.now() < deadline &&
          !text.includes('mission.created') &&
          last !== String(Number(rows.at(-1)!.id) + 100)
        ) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 300),
            ),
          ]);
          if (chunk.value) text += new TextDecoder().decode(chunk.value);
          if (chunk.done) break;
        }
        controller.abort();
        await reader.cancel().catch(() => undefined);
        const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
        // Not vacuous: a replay from the start does carry this mission's events.
        if (last === '' || last === '0') expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(foreignIds).not.toContain(id);
        expect(text).not.toContain(foreign);
        expect(text).not.toContain(other);
      }
    });
  });

  it('TP-46 a lifecycle body naming another mission is rejected and changes nothing', async () => {
    await withSurface(async (s) => {
      const mine = await createMission(s);
      const foreign = await otherOwnersMission(s);
      const response = await s.call(`/api/nemodots/missions/${mine}/cancel`, {
        method: 'POST',
        body: json({ missionId: foreign }),
      });
      expect(response.status).toBe(400);
      const theirs = await Promise.resolve(
        s.other.router.request(`/missions/${foreign}`),
      );
      expect(
        ((await theirs.json()) as { mission: { status: string } }).mission
          .status,
      ).toBe('created');
    });
  });
});

describe('sandbox routes and response hygiene', () => {
  it.each([
    'checkout.health',
    'checkout.config',
    'checkout.acceptance',
    'runbook%2Facceptance',
    'opendots.page%2Fx',
    'checkout.config%2F..%2Fdb.pool_max',
    'checkout.config%2FDB.POOL_MAX',
  ])(
    'TP-47 owner edit of %j (not a controlled config member) is 400',
    async (key) => {
      await withSurface(async (s) => {
        const response = await s.call(`/api/nemodots/sandbox/sources/${key}`, {
          method: 'POST',
          body: json({ value: 1, expectedVersion: 1 }),
        });
        expect(response.status).toBe(400);
      });
    },
  );

  it('TP-48 a mission snapshot carries no role URL, probe secret or provider key', async () => {
    await withSurface(async (s) => {
      const id = await createMission(s);
      const text = await (await s.call(`/api/nemodots/missions/${id}`)).text();
      for (const secret of [
        'postgres://',
        PROBE_SECRET,
        'adversary-stub-key',
        s.db.urls.app,
      ])
        expect(text).not.toContain(secret);
    });
  });
});

describe('the composed page-revision feed (bootstrap installInterception)', () => {
  it('TP-70 with NEMODOTS_INCIDENT_DOT_IDS empty, an ordinary page write leaves the NemoDots ledger untouched', async () => {
    // TOOL_COVERAGE (intro, I4): with the list empty every defence-in-depth
    // row is inactive. bootstrap.ts installs a module-level pageRevision hook
    // that registers EVERY page write, in any Space, as an opendots.page/<id>
    // receipt in whichever mission was created last, with the mission's scope
    // (spaceId null) instead of the page's Space.
    await withSurface(async (s) => {
      const mission = await createMission(s);
      const { WorkspaceStore } =
        await import('../../../../src/server/workspace.js');
      const workspace = new WorkspaceStore(':memory:', 'owner');
      closers.push(() => workspace.close());
      const space = workspace.createSpace(
        'Unrelated',
        'not a projection Space',
      );
      // start() installs the interception hooks (module level).
      await startMine(s);
      const page = workspace.pages.create(space.id, {
        title: 'Team lunch',
        content: 'nothing to do with any incident',
        parentId: null,
      });
      const pg = (await import('pg')).default;
      const pool = new pg.Pool({ connectionString: s.db.urls.admin, max: 1 });
      pool.on('error', () => undefined);
      closers.push(() => pool.end());
      const key = `opendots.page/${page.id}`;
      let rows: { key: string; space_id: string | null }[] = [];
      for (let i = 0; i < 20 && rows.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        rows = (
          await pool.query<{ key: string; space_id: string | null }>(
            'SELECT key, space_id FROM ledger.sources WHERE key = $1',
            [key],
          )
        ).rows;
      }
      const events = await pool.query(
        `SELECT kind FROM coordinator.events WHERE mission_id = $1 AND payload::text LIKE $2`,
        [mission, `%${page.id}%`],
      );
      expect({ sources: rows, missionEvents: events.rows.length }).toEqual({
        sources: [],
        missionEvents: 0,
      });
    });
  });
});

async function startMine(s: Surface) {
  await s.mine.start();
}

describe('the page-revision feed after the TP-70 fix: positive case', () => {
  it('TP-70b an incident Dot turn registers exactly its page read and create as authority-free page_snapshot receipts in the projection Space; an ordinary Dot and an owner edit register nothing', async () => {
    // Not vacuous: the fix must still register incident pages (R8/M1
    // instrumentation), with the page's Space in the source identity.
    const { WorkspaceStore } =
      await import('../../../../src/server/workspace.js');
    const { Store } = await import('../../../../src/server/store.js');
    const { DotAgent } = await import('../../../../src/server/dot-agent.js');
    const { lastValueFrom, toArray } = await import('rxjs');
    const { baseConfig, input, toolCall, say, MODEL_HOST } =
      await import('./support.js');
    const { vi } = await import('vitest');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const store = new Store(':memory:');
    closers.push(
      () => workspace.close(),
      () => store.close(),
    );
    const projection = workspace.spaces()[0].id;
    const incidentDot = workspace.createDot(
      projection,
      'Incident',
      'Investigate.',
      false,
      false,
    );
    const ordinaryDot = workspace.createDot(
      projection,
      'Ordinary',
      'Help.',
      false,
      false,
    );
    workspace.bindThread('t-incident', incidentDot.id, 'Incident');
    workspace.bindThread('t-ordinary', ordinaryDot.id, 'Ordinary');
    const evidence = workspace.pages.create(projection, {
      title: 'Evidence',
      content: 'x',
      parentId: null,
    });
    await withSurface(
      async (s) => {
        await createMission(s);
        await startMine(s);
        const real = globalThis.fetch.bind(globalThis);
        const script = [
          () => toolCall('r1', 'read_space_page', { id: evidence.id }),
          () =>
            toolCall('c1', 'create_space_page', {
              title: 'Incident note',
              content: 'y',
              spaceId: projection,
            }),
          () => say('done'),
          () =>
            toolCall('c2', 'create_space_page', {
              title: 'Ordinary note',
              content: 'z',
              spaceId: projection,
            }),
          () => say('done'),
        ];
        let n = 0;
        // Only the scripted provider host is stubbed; NemoDots' own loopback
        // traffic goes to the real fetch.
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          async (resource, init) => {
            const url =
              typeof resource === 'string'
                ? resource
                : resource instanceof URL
                  ? resource.toString()
                  : resource.url;
            if (new URL(url).host !== MODEL_HOST) return real(resource, init);
            const next = script[n++];
            return next ? next() : say('done');
          },
        );
        try {
          for (const [dot, thread] of [
            [incidentDot.id, 't-incident'],
            [ordinaryDot.id, 't-ordinary'],
          ] as const) {
            const agent = new DotAgent(store, workspace, baseConfig(), dot);
            await lastValueFrom(
              agent.run(input({ threadId: thread }, 'Work.')).pipe(toArray()),
            );
          }
        } finally {
          vi.restoreAllMocks();
        }
        const incidentNote = workspace.pages
          .list(projection)
          .find((p) => p.title === 'Incident note');
        const ordinaryNote = workspace.pages
          .list(projection)
          .find((p) => p.title === 'Ordinary note');
        expect(incidentNote).toBeDefined();
        expect(ordinaryNote).toBeDefined();
        const pg = (await import('pg')).default;
        const pool = new pg.Pool({ connectionString: s.db.urls.admin, max: 1 });
        pool.on('error', () => undefined);
        closers.push(() => pool.end());
        const sourcesOf = async (pageId: string) =>
          (
            await pool.query<{ space_id: string | null }>(
              'SELECT space_id FROM ledger.sources WHERE key = $1',
              [`opendots.page/${pageId}`],
            )
          ).rows;
        let read: { space_id: string | null }[] = [];
        let created: { space_id: string | null }[] = [];
        for (
          let i = 0;
          i < 30 && (read.length === 0 || created.length === 0);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          read = await sourcesOf(evidence.id);
          created = await sourcesOf(incidentNote!.id);
        }
        expect({
          read,
          created,
          ordinary: await sourcesOf(ordinaryNote!.id),
        }).toEqual({
          read: [{ space_id: projection }],
          created: [{ space_id: projection }],
          ordinary: [],
        });
        // Authority-free: page_snapshot trust and source type, one receipt
        // per page, never controlled authority. (TP-70e proves such a receipt
        // cannot support a commit.)
        const receipts = async () =>
          (
            await pool.query<{
              key: string;
              trust: string;
              source_type: string;
              authority: string;
              n: string;
            }>(
              `SELECT s.key, r.trust, s.source_type, s.authority, count(*) OVER (PARTITION BY s.id) AS n
                 FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
                WHERE s.key LIKE 'opendots.page/%' ORDER BY s.key`,
            )
          ).rows;
        const registered = await receipts();
        expect(registered.map((r) => r.key).sort()).toEqual(
          [
            `opendots.page/${evidence.id}`,
            `opendots.page/${incidentNote!.id}`,
          ].sort(),
        );
        for (const row of registered)
          expect(row).toMatchObject({
            trust: 'page_snapshot',
            source_type: 'page_snapshot',
            authority: 'observed',
            n: '1',
          });
        // An owner edit of the incident's own page, outside any Dot turn,
        // registers nothing (no new revision).
        workspace.pages.update(projection, incidentNote!.id, {
          content: 'owner edit',
          expectedRevision: incidentNote!.revision,
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(await receipts()).toEqual(registered);
      },
      {
        env: {
          NEMODOTS_PROJECTION_SPACE_ID: projection,
          NEMODOTS_INCIDENT_DOT_IDS: incidentDot.id,
        },
      },
    );
  });
});

// Final lead ruling (2026-10-18, hybrid): Dot chat turns are outside the
// controlled scope. Their model calls and snapshots are NOT recorded; the only
// Dot-turn data that reaches the ledger is an incident Dot's authority-free
// page_snapshot receipts in the projection Space (TP-70b). Provider-host and
// timing instrumentation stays installed.

/** Row counts of every table in the controlled and evidence schemas. */
async function stateCounts(adminUrl: string) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  pool.on('error', () => undefined);
  try {
    const { rows: tables } = await pool.query<{ s: string; t: string }>(
      `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
        WHERE table_schema IN ('ledger', 'coordinator', 'checkout', 'control')
          AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
    );
    const counts: Record<string, number> = {};
    for (const { s, t } of tables)
      counts[`${s}.${t}`] = Number(
        (await pool.query(`SELECT count(*) AS n FROM "${s}"."${t}"`)).rows[0].n,
      );
    const versions = await pool.query<{ v: string | null }>(
      'SELECT sum(version) AS v FROM checkout.config_entries',
    );
    counts['checkout.config_entries.sum(version)'] = Number(
      versions.rows[0].v ?? 0,
    );
    const pages = await pool.query<{ key: string; space_id: string | null }>(
      "SELECT key, space_id FROM ledger.sources WHERE key LIKE 'opendots.page/%' ORDER BY key",
    );
    return { counts, pageSources: pages.rows };
  } finally {
    await pool.end();
  }
}

interface TurnWorld {
  workspace: import('../../../../src/server/workspace.js').WorkspaceStore;
  store: import('../../../../src/server/store.js').Store;
  projection: string;
  incidentDot: string;
  ordinaryDot: string;
  evidence: { id: string; revision: number };
}

async function turnWorld(): Promise<TurnWorld> {
  const { WorkspaceStore } =
    await import('../../../../src/server/workspace.js');
  const { Store } = await import('../../../../src/server/store.js');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const store = new Store(':memory:');
  closers.push(
    () => workspace.close(),
    () => store.close(),
  );
  const projection = workspace.spaces()[0].id;
  const incident = workspace.createDot(
    projection,
    'Incident',
    'Investigate.',
    false,
    false,
  );
  const ordinary = workspace.createDot(
    projection,
    'Ordinary',
    'Help.',
    false,
    false,
  );
  workspace.bindThread('t-incident', incident.id, 'Incident');
  workspace.bindThread('t-ordinary', ordinary.id, 'Ordinary');
  // An approval-gated MCP tool on both Dots (owner action); its URL is a
  // closed local port, so an executed call could not succeed silently.
  for (const dot of [incident.id, ordinary.id])
    workspace.connections.create(
      dot,
      { name: 'Mail', url: 'http://127.0.0.1:9/mcp' },
      [
        {
          name: 'send_mail',
          title: 'Send mail',
          description: 'Send an email.',
          inputSchema: { type: 'object', properties: {} },
          readOnly: false,
          enabled: true,
          requiresApproval: true,
        },
      ],
    );
  const evidence = workspace.pages.create(projection, {
    title: 'Evidence',
    content: 'original',
    parentId: null,
  });
  return {
    workspace,
    store,
    projection,
    incidentDot: incident.id,
    ordinaryDot: ordinary.id,
    evidence,
  };
}

/**
 * Runs the scripted turns of each Dot (incident first); only the provider host
 * is stubbed. A turn allows at most 5 model iterations (dot-agent.ts
 * maxIterations), so each turn script is at most 4 tool calls and an answer.
 */
async function runTurns(
  w: TurnWorld,
  scripts: Record<'incident' | 'ordinary', (() => Response)[][]>,
) {
  const { DotAgent } = await import('../../../../src/server/dot-agent.js');
  const { lastValueFrom, toArray } = await import('rxjs');
  const { baseConfig, input, say, MODEL_HOST } = await import('./support.js');
  const { connectionActionTool } =
    await import('../../../../src/shared/connection-types.js');
  const { vi } = await import('vitest');
  const real = globalThis.fetch.bind(globalThis);
  const modelHosts: string[] = [];
  const perTurn: number[] = [];
  const turns = (['incident', 'ordinary'] as const).flatMap((kind) =>
    scripts[kind].map(
      (script) =>
        [
          kind === 'incident' ? w.incidentDot : w.ordinaryDot,
          kind === 'incident' ? 't-incident' : 't-ordinary',
          script,
        ] as const,
    ),
  );
  for (const [dot, thread, turnScript] of turns) {
    if (turnScript.length > 5)
      throw new Error('a Dot turn runs at most 5 model iterations');
    const script = [...turnScript];
    const startCount = modelHosts.length;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, init) => {
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.toString()
            : resource.url;
      const host = new URL(url).host;
      if (host !== MODEL_HOST) return real(resource, init);
      modelHosts.push(host);
      const next = script.shift();
      return next ? next() : say('done');
    });
    try {
      const agent = new DotAgent(w.store, w.workspace, baseConfig(), dot);
      await lastValueFrom(
        agent
          .run(
            input({ threadId: thread }, 'Work.', [
              connectionActionTool,
            ] as never),
          )
          .pipe(toArray()),
      );
    } finally {
      vi.restoreAllMocks();
    }
    perTurn.push(modelHosts.length - startCount);
  }
  return Object.assign(modelHosts, { perTurn });
}

describe('the final scope ruling (TP-71): Dot-turn model calls and snapshots are not recorded', () => {
  it('TP-71 the only ledger delta of any Dot turn is the incident Dot page receipts (+N for N pages); no model call, snapshot, coordinator or config change; an ordinary Dot changes nothing', async () => {
    const w = await turnWorld();
    const { toolCall, say } = await import('./support.js');
    await withSurface(
      async (s) => {
        await createMission(s);
        await startMine(s);
        // Provider-host and timing instrumentation stays installed: a sink is
        // present (so every Dot turn runs the telemetry fetch) and it records
        // no model call or snapshot.
        const { getInterceptionHooks } =
          await import('../../../../src/server/nemodots/interception/index.js');
        const hooks = getInterceptionHooks();
        expect(hooks.sink).toBeDefined();
        expect(hooks.providerMode).toBe('live');
        expect(
          hooks.sink?.identify?.({ dotId: 'x', threadId: 'y' }),
        ).toBeNull();
        expect(hooks.sink?.recordSnapshot).toBeUndefined();
        expect(hooks.sink?.recordModelCall).toBeUndefined();

        // Four turns per Dot (at most 4 tool calls each): every Dot tool
        // path, forged connection calls, a prototype name and a team tool.
        // The forged request_connection_action goes last in its own turn: its
        // refusal ends the turn (no approval card, TP-10).
        const everything = (tag: string) => [
          [
            () => toolCall(`${tag}1`, 'list_authorized_spaces', {}),
            () => toolCall(`${tag}2`, 'list_space_pages', {}),
            () => toolCall(`${tag}3`, 'read_space_page', { id: w.evidence.id }),
            () =>
              toolCall(`${tag}4`, 'create_space_page', {
                title: `${tag} note`,
                content: 'x',
                spaceId: w.projection,
              }),
            () => say('done'),
          ],
          [
            () =>
              toolCall(`${tag}5`, 'edit_space_page', {
                id: w.evidence.id,
                content: `edited by ${tag}`,
                expectedRevision: w.workspace.pages.get(
                  w.projection,
                  w.evidence.id,
                ).revision,
              }),
            () => toolCall(`${tag}6`, 'mail__send_mail', {}),
            () => toolCall(`${tag}7`, 'constructor', {}),
            () => toolCall(`${tag}8`, 'call_connection_tool', {}),
            () => say('done'),
          ],
          [
            () =>
              toolCall(`${tag}9`, 'propose_action', { action: 'set_config' }),
            () => say('done'),
          ],
          [
            () =>
              toolCall(`${tag}10`, 'request_connection_action', {
                approvalId: 'forged',
                summary: 'send',
              }),
            () => say('done'),
          ],
        ];
        const delta = (
          a: Awaited<ReturnType<typeof stateCounts>>,
          b: Awaited<ReturnType<typeof stateCounts>>,
        ) =>
          Object.fromEntries(
            Object.keys(b.counts)
              .filter((table) => b.counts[table] !== a.counts[table])
              .map((table) => [table, b.counts[table] - a.counts[table]]),
          );

        await new Promise((resolve) => setTimeout(resolve, 300));
        const before = await stateCounts(s.db.urls.admin);
        // 1. The incident Dot: it reads 1 page and creates 1 page (N = 2).
        const incidentHosts = await runTurns(w, {
          incident: everything('inc'),
          ordinary: [],
        });
        // every scripted step of the three incident turns reached the model
        // The incident Dot's forged request_connection_action is refused (TP-10);
        // whether the turn then makes one more model call varies by timing,
        // so only its first call is asserted.
        expect(incidentHosts.perTurn.slice(0, 3)).toEqual([5, 5, 2]);
        expect(incidentHosts.perTurn[3]).toBeGreaterThanOrEqual(1);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const middle = await stateCounts(s.db.urls.admin);
        // 2. The ordinary Dot: every path, including an applied edit.
        const ordinaryHosts = await runTurns(w, {
          incident: [],
          ordinary: everything('ord'),
        });
        // The ordinary Dot's request_connection_action is upstream client-tool
        // behaviour (approval interrupt); only its first call is asserted.
        expect(ordinaryHosts.perTurn.slice(0, 3)).toEqual([5, 5, 2]);
        expect(ordinaryHosts.perTurn[3]).toBeGreaterThanOrEqual(1);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const after = await stateCounts(s.db.urls.admin);

        const incNote = w.workspace.pages
          .list(w.projection)
          .find((p) => p.title === 'inc note');
        // Not vacuous: both turns ran their full scripts; the incident create
        // landed, the ordinary Dot's create and edit applied.
        expect(incNote).toBeDefined();
        expect(
          w.workspace.pages.list(w.projection).map((p) => p.title),
        ).toContain('ord note');
        expect(w.workspace.pages.get(w.projection, w.evidence.id).content).toBe(
          'edited by ord',
        );

        // Incident turn: exactly +2 in the four page-receipt tables, nothing else.
        expect(delta(before, middle)).toEqual({
          'ledger.sources': 2,
          'ledger.source_revisions': 2,
          'ledger.observation_receipts': 2,
          'ledger.dependency_nodes': 2,
        });
        expect(middle.pageSources).toEqual(
          [
            { key: `opendots.page/${w.evidence.id}`, space_id: w.projection },
            { key: `opendots.page/${incNote!.id}`, space_id: w.projection },
          ].sort((x, y) => (x.key < y.key ? -1 : 1)),
        );
        // Ordinary turn: zero delta in every table, config versions included.
        expect(delta(middle, after)).toEqual({});
        expect(after.pageSources).toEqual(middle.pageSources);
      },
      {
        env: {
          NEMODOTS_PROJECTION_SPACE_ID: w.projection,
          NEMODOTS_INCIDENT_DOT_IDS: w.incidentDot,
        },
      },
    );
  });

  it('TP-70c page receipts need exactly one active mission in the page Space: two missions register nothing', async () => {
    const w = await turnWorld();
    const { toolCall, say } = await import('./support.js');
    await withSurface(
      async (s) => {
        await createMission(s);
        await createMission(s); // a second active mission in the same Space
        await startMine(s);
        await runTurns(w, {
          incident: [
            [
              () => toolCall('r1', 'read_space_page', { id: w.evidence.id }),
              () => say('done'),
            ],
          ],
          ordinary: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect((await stateCounts(s.db.urls.admin)).pageSources).toEqual([]);
      },
      {
        env: {
          NEMODOTS_PROJECTION_SPACE_ID: w.projection,
          NEMODOTS_INCIDENT_DOT_IDS: w.incidentDot,
        },
      },
    );
  });

  it('TP-70d with NEMODOTS_PROJECTION_SPACE_ID unset, an incident read registers nothing', async () => {
    const w = await turnWorld();
    const { toolCall, say } = await import('./support.js');
    await withSurface(
      async (s) => {
        await createMission(s);
        await startMine(s);
        await runTurns(w, {
          incident: [
            [
              () => toolCall('r1', 'read_space_page', { id: w.evidence.id }),
              () => say('done'),
            ],
          ],
          ordinary: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect((await stateCounts(s.db.urls.admin)).pageSources).toEqual([]);
      },
      { env: { NEMODOTS_INCIDENT_DOT_IDS: w.incidentDot } },
    );
  });
});

describe('TP-02 through the composed product', () => {
  it('TP-02d with NEMODOTS_PROJECTION_SPACE_ID set, an incident create without spaceId stays in the projection Space', async () => {
    // bootstrap.ts now installs projectionSpaceId from the environment, so
    // the M1 allowance (and the TP-02 check/write mismatch) is reachable.
    const { WorkspaceStore } =
      await import('../../../../src/server/workspace.js');
    const { Store } = await import('../../../../src/server/store.js');
    const { DotAgent } = await import('../../../../src/server/dot-agent.js');
    const { lastValueFrom, toArray } = await import('rxjs');
    const { baseConfig, input, toolCall, say, MODEL_HOST } =
      await import('./support.js');
    const { vi } = await import('vitest');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const store = new Store(':memory:');
    closers.push(
      () => workspace.close(),
      () => store.close(),
    );
    const projection = workspace.spaces()[0].id;
    const foreign = workspace.createSpace('Foreign', 'not the projection').id;
    const dot = workspace.createDot(
      projection,
      'Incident',
      'Investigate.',
      false,
      false,
      [projection, foreign],
    );
    workspace.bindThread('t', dot.id, 'Incident');
    const linked = workspace.pages.create(foreign, {
      title: 'Thread page',
      content: 'x',
      parentId: null,
    });
    workspace.pages.reserveThread(linked.id, dot.id, 't');
    workspace.pages.finishThread(linked.id, dot.id);
    await withSurface(
      async (s) => {
        await startMine(s);
        const real = globalThis.fetch.bind(globalThis);
        const script = [
          () =>
            toolCall('c1', 'create_space_page', {
              title: 'Smuggled',
              content: 'y',
            }),
          () => say('done'),
        ];
        let n = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          async (resource, init) => {
            const url =
              typeof resource === 'string'
                ? resource
                : resource instanceof URL
                  ? resource.toString()
                  : resource.url;
            if (new URL(url).host !== MODEL_HOST) return real(resource, init);
            const next = script[n++];
            return next ? next() : say('done');
          },
        );
        try {
          const agent = new DotAgent(store, workspace, baseConfig(), dot.id);
          await lastValueFrom(
            agent.run(input({ threadId: 't' }, 'Write it.')).pipe(toArray()),
          );
        } finally {
          vi.restoreAllMocks();
        }
        expect(
          workspace.pages.list(foreign).filter((p) => p.title === 'Smuggled'),
        ).toEqual([]);
      },
      {
        env: {
          NEMODOTS_PROJECTION_SPACE_ID: projection,
          NEMODOTS_INCIDENT_DOT_IDS: dot.id,
        },
      },
    );
  });
});
