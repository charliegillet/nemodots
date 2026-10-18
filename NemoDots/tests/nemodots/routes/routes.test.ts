import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OWNER,
  blockedMode,
  build,
  dataOf,
  eventOf,
  idOf,
  json,
  liveMode,
  missionFixture,
  readFrames,
  snapshotOf,
  stubDeps,
  type StubWorld,
} from './support.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

function setup(
  over: Parameters<typeof stubDeps>[1] = {},
  options: Parameters<typeof build>[1] = {},
) {
  const world: StubWorld = { missions: new Map(), events: [], calls: [] };
  const mission = missionFixture();
  world.missions.set(mission.id, mission);
  const built = build(stubDeps(world, over), options);
  closers.push(built.close);
  return { ...built, world, mission };
}
const P = '/api/nemodots';

describe('health and mission creation', () => {
  it('health reports names only and the provider host from the server mode', async () => {
    const { app } = setup({ mode: () => liveMode });
    const body = await (await app.request(`${P}/health`)).json();
    expect(body).toMatchObject({
      mode: 'live',
      provider: {
        host: 'api.inference.crusoecloud.com',
        model: liveMode.mode === 'live' ? liveMode.model : null,
      },
      missingEnv: [],
      postgres: 'ok',
    });
  });

  it('blocked mode: POST /missions is 503 with variable names only', async () => {
    const { app, world } = setup({ mode: () => blockedMode });
    const response = await app.request(
      `${P}/missions`,
      json({ goal: 'fix it' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Setup required: inference is blocked.',
      missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    });
    expect(world.calls).toEqual([]);
    const health = await (await app.request(`${P}/health`)).json();
    expect(health).toMatchObject({
      mode: 'blocked',
      missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    });
  });

  it('a body mode that disagrees with the server mode is 400 (I11); equal or omitted is accepted and the server mode is used', async () => {
    const { app, world } = setup();
    const bad = await app.request(
      `${P}/missions`,
      json({ goal: 'fix it', mode: 'live' }),
    );
    expect(bad.status).toBe(400);
    expect(world.calls).toEqual([]);
    for (const body of [{ goal: 'a' }, { goal: 'a', mode: 'fixture' }]) {
      const ok = await app.request(`${P}/missions`, json(body));
      expect(ok.status).toBe(201);
    }
    expect(world.calls.every((c) => c.includes('"mode":"fixture"'))).toBe(true);
  });

  it('rejects admission.minAgeMs outside 0..60000, unknown keys and an owner id in the body', async () => {
    const { app, world } = setup();
    for (const body of [
      { goal: 'a', admission: { minAgeMs: 60001 } },
      { goal: 'a', admission: { minAgeMs: -1 } },
      { goal: 'a', ownerId: 'someone-else' },
      { goal: 'a', scope: { ownerId: 'x' } },
      { goal: '' },
    ])
      expect((await app.request(`${P}/missions`, json(body))).status).toBe(400);
    expect(world.calls).toEqual([]);
  });
});

describe('scope', () => {
  it('another owner’s mission, a malformed id and a missing mission are all 404 for every mission route', async () => {
    const { app, world } = setup();
    const other = missionFixture();
    const stranger = {
      ...other,
      scope: { ...other.scope, ownerId: 'someone-else' },
    };
    world.missions.set(stranger.id, stranger);
    const ids = [stranger.id, 'not-a-uuid', randomUUID()];
    for (const id of ids) {
      for (const suffix of [
        '',
        '/tasks',
        '/evidence',
        '/actions',
        '/recovery',
        '/telemetry',
        '/events',
      ])
        expect(
          (await app.request(`${P}/missions/${id}${suffix}`)).status,
          `${id}${suffix}`,
        ).toBe(404);
      for (const action of ['start', 'pause', 'resume', 'cancel'])
        expect(
          (await app.request(`${P}/missions/${id}/${action}`, json({}))).status,
        ).toBe(404);
    }
    expect(world.calls.filter((c) => !c.startsWith('create'))).toEqual([]);
    expect(
      (await app.request(`${P}/telemetry/summary?missionId=${stranger.id}`))
        .status,
    ).toBe(404);
  });

  it('GET /missions lists only through the owner-scoped query', async () => {
    const seen: unknown[][] = [];
    const { app } = setup({
      pool: {
        query: async (text: string, values?: unknown[]) => {
          if (text.includes('coordinator.missions')) seen.push(values ?? []);
          return { rows: [], rowCount: 0 };
        },
      },
    });
    expect(await (await app.request(`${P}/missions`)).json()).toEqual([]);
    expect(seen).toEqual([[OWNER]]);
  });
});

describe('lifecycle and views', () => {
  it('illegal transitions are 409 and require an empty JSON object', async () => {
    const { app, mission } = setup();
    expect(
      (await app.request(`${P}/missions/${mission.id}/resume`, json({})))
        .status,
    ).toBe(409);
    expect(
      (await app.request(`${P}/missions/${mission.id}/pause`, json({}))).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${P}/missions/${mission.id}/pause`,
          json({ force: true }),
        )
      ).status,
    ).toBe(400);
  });

  it('snapshot and sub-views are typed arrays from the snapshot; a snapshot with control keys fails closed', async () => {
    const { app, mission, world } = setup();
    const snapshot = await (
      await app.request(`${P}/missions/${mission.id}`)
    ).json();
    expect(Object.keys(snapshot).sort()).toEqual(
      Object.keys(snapshotOf(mission)).sort(),
    );
    for (const [route, expected] of [
      ['tasks', []],
      ['evidence', []],
      ['actions', []],
      ['recovery', []],
    ] as const)
      expect(
        await (
          await app.request(`${P}/missions/${mission.id}/${route}`)
        ).json(),
      ).toEqual(expected);
    expect(
      await (await app.request(`${P}/missions/${mission.id}/telemetry`)).json(),
    ).toMatchObject({ calls: 0 });
    // control data leaking into a snapshot is refused, not forwarded
    const deps = stubDeps(world);
    deps.control.snapshot = async () =>
      ({
        ...snapshotOf(mission),
        control: { scenario: 'secret' },
        roleUrl: 'postgres://u:p@h/db',
      }) as never;
    const leaky = build(deps);
    closers.push(leaky.close);
    const response = await leaky.app.request(`${P}/missions/${mission.id}`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('postgres://');
  });
});

describe('sandbox, telemetry and evals routes', () => {
  it('manual edit validates the key family and maps a stale version to 409', async () => {
    const { app, world } = setup();
    const key = encodeURIComponent('checkout.config/db.pool_max');
    const ok = await app.request(
      `${P}/sandbox/sources/${key}`,
      json({ value: 3, expectedVersion: 1 }),
    );
    expect(await ok.json()).toEqual({
      key: 'checkout.config/db.pool_max',
      version: 2,
    });
    expect(world.calls).toContain('edit:db.pool_max:1');
    for (const bad of [
      'checkout.health',
      'checkout.config',
      'runbook/x',
      '../etc',
    ])
      expect(
        (
          await app.request(
            `${P}/sandbox/sources/${encodeURIComponent(bad)}`,
            json({ value: 3, expectedVersion: 1 }),
          )
        ).status,
      ).toBe(400);
    const { ConfigVersionError } =
      await import('../../../src/server/nemodots/sandbox/version-authority.js');
    const stale = setup({
      ownerEdit: async () => {
        throw new ConfigVersionError('stale_version', 'db.pool_max', 'x', 1, 5);
      },
    });
    const response = await stale.app.request(
      `${P}/sandbox/sources/${key}`,
      json({ value: 3, expectedVersion: 1 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ currentVersion: 5 });
  });

  it('injector run returns only the run id', async () => {
    const { app } = setup();
    const response = await app.request(
      `${P}/sandbox/injector/run`,
      json({ scenarioClass: 'cache-stampede' }),
    );
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ runId: 'run-1' });
    expect(text).not.toContain('manifest');
    expect(text).not.toContain('42');
    expect(
      (
        await app.request(
          `${P}/sandbox/injector/run`,
          json({ scenarioClass: '../x' }),
        )
      ).status,
    ).toBe(400);
  });

  it('checkout health is validated; garbage or failure is 502 and never forwarded', async () => {
    const good = setup();
    expect(
      await (await good.app.request(`${P}/sandbox/checkout/health`)).json(),
    ).toMatchObject({ status: 'ok' });
    for (const checkoutHealth of [
      async () => ({ status: 'ok', roleUrl: 'postgres://u:p@h/db' }),
      async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4510');
      },
    ]) {
      const bad = setup({ checkoutHealth });
      const response = await bad.app.request(`${P}/sandbox/checkout/health`);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain('postgres://');
      expect(text).not.toContain('ECONNREFUSED');
    }
  });

  it('evals/report is NOT_RUN unless a valid report exists', async () => {
    expect(
      await (await setup().app.request(`${P}/evals/report`)).json(),
    ).toEqual({ status: 'NOT_RUN' });
    const withReport = setup({
      evalsReport: async () => ({
        status: 'PASS',
        generatedAt: '2026-10-18T10:00:00.000Z',
        summary: { n: 1 },
      }),
    });
    expect(
      await (await withReport.app.request(`${P}/evals/report`)).json(),
    ).toMatchObject({ status: 'PASS' });
    const malformed = setup({ evalsReport: async () => ({ status: 'PASS' }) });
    expect(
      await (await malformed.app.request(`${P}/evals/report`)).json(),
    ).toEqual({ status: 'NOT_RUN' });
  });

  it('telemetry/summary scopes to an owned mission', async () => {
    const asked: unknown[] = [];
    const { app, mission } = setup({
      telemetry: async (id) => {
        asked.push(id);
        return stubDeps({ missions: new Map(), events: [], calls: [] })
          .telemetry!(id);
      },
    });
    expect(
      (await app.request(`${P}/telemetry/summary?missionId=${mission.id}`))
        .status,
    ).toBe(200);
    expect((await app.request(`${P}/telemetry/summary`)).status).toBe(200);
    expect(asked).toEqual([mission.id, undefined]);
  });
});

describe('request protection (upstream /api middleware)', () => {
  it('enforces the owner token, same-origin and JSON content type', async () => {
    const { app, mission } = setup({}, { ownerToken: 'owner-secret-token' });
    const auth = { Authorization: 'Bearer owner-secret-token' };
    expect((await app.request(`${P}/missions`)).status).toBe(401);
    expect(
      (
        await app.request(`${P}/missions`, {
          headers: { Authorization: 'Bearer wrong-token-value' },
        })
      ).status,
    ).toBe(401);
    expect((await app.request(`${P}/missions`, { headers: auth })).status).toBe(
      200,
    );
    expect(
      (
        await app.request(`${P}/missions/${mission.id}/events`, {
          headers: { ...auth, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${P}/missions/${mission.id}/pause`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request(`${P}/missions/${mission.id}/pause`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(200);
  });
});

describe('events (SSE)', () => {
  const heartbeat = { kind: 'heartbeat' };

  it('replays exactly the missing ids after Last-Event-ID, then live events, with a heartbeat', async () => {
    const { app, world, mission } = setup();
    for (const id of [1, 2, 3, 4, 5])
      world.events.push(eventOf(mission.id, id, heartbeat));
    const response = await app.request(`${P}/missions/${mission.id}/events`, {
      headers: { 'Last-Event-ID': '3' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    setTimeout(() => world.events.push(eventOf(mission.id, 6, heartbeat)), 100);
    const frames = await readFrames(
      response,
      (f) =>
        f.some((x) => idOf(x) === '6') &&
        f.some((x) => x.startsWith(': heartbeat')),
    );
    expect(frames.map(idOf).filter(Boolean)).toEqual(['4', '5', '6']);
    expect(frames.some((f) => f.startsWith(': heartbeat'))).toBe(true);
    for (const frame of frames.filter(idOf)) {
      const event = dataOf(frame)!;
      expect(String(event.id)).toBe(idOf(frame));
      expect(event.missionId).toBe(mission.id);
    }
  });

  it('a malformed Last-Event-ID is 400', async () => {
    const { app, mission } = setup();
    for (const value of ['abc', '-1', '1.5', '99999999999999999'])
      expect(
        (
          await app.request(`${P}/missions/${mission.id}/events`, {
            headers: { 'Last-Event-ID': value },
          })
        ).status,
      ).toBe(400);
  });

  it('a payload that fails EventPayloadSchema is never written, and neither is another mission’s event', async () => {
    const invalid: number[] = [];
    const { app, world, mission } = setup({
      onInvalidEvent: (i) => void invalid.push(i.id),
    });
    const other = missionFixture();
    world.events.push(
      eventOf(mission.id, 1, heartbeat),
      eventOf(mission.id, 2, {
        kind: 'mission.status',
        unexpected: 'prompt text',
      }),
      { ...eventOf(other.id, 3, heartbeat), missionId: other.id },
      { ...eventOf(mission.id, 4, heartbeat), kind: 'task.created' },
      eventOf(mission.id, 5, heartbeat),
    );
    const response = await app.request(`${P}/missions/${mission.id}/events`);
    const frames = await readFrames(response, (f) =>
      f.some((x) => idOf(x) === '5'),
    );
    expect(frames.map(idOf).filter(Boolean)).toEqual(['1', '5']);
    expect(JSON.stringify(frames)).not.toContain('prompt text');
    expect(invalid.sort()).toEqual([2, 4]);
  });

  it('wakes on a notification without waiting for the poll', async () => {
    let notify: ((m: { missionId: string; id: number }) => void) | undefined;
    const { app, world, mission } = setup({
      notifier: {
        subscribe: async (handler) => {
          notify = handler;
          return () => {
            notify = undefined;
          };
        },
      },
      sse: { pollMs: 60_000, heartbeatMs: 60_000 },
    });
    const response = await app.request(`${P}/missions/${mission.id}/events`);
    setTimeout(() => {
      world.events.push(eventOf(mission.id, 1, heartbeat));
      notify?.({ missionId: mission.id, id: 1 });
    }, 100);
    const started = Date.now();
    const frames = await readFrames(
      response,
      (f) => f.some((x) => idOf(x) === '1'),
      2500,
    );
    expect(frames.map(idOf).filter(Boolean)).toEqual(['1']);
    expect(Date.now() - started).toBeLessThan(2000);
    // a notification for another mission does not wake this stream's read of it
    expect(notify).toBeUndefined(); // unsubscribed on close
  });
});
