// /api/nemodots routes against a real migrated database, the real coordinator
// and the real watcher, mounted on the upstream app so its /api/* middleware
// (owner token, origin, JSON) is the one in front of them. Ports that belong
// to later waves (checkout proxy, injector) are labelled stubs.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../../../src/server/store.js';
import { Runner } from '../../../../src/server/runner.js';
import { createApp } from '../../../../src/server/app.js';
import {
  createPgEventNotifier,
  nemodotsRoutes,
} from '../../../../src/server/nemodots/routes/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { ownerEdit } from '../../../../src/server/nemodots/watcher/index.js';
import { telemetrySummary } from '../../../../src/server/nemodots/telemetry/index.js';
import type { MissionEvent } from '../../../../src/server/nemodots/contracts/index.js';
import {
  withWatcherEnv,
  plannedMission,
  claimStart,
} from '../watcher/harness.js';
import { dataOf, idOf, json, readFrames } from '../../routes/support.js';

const TOKEN = 'owner-token-for-routes-test';
const auth = { Authorization: `Bearer ${TOKEN}` };
const P = '/api/nemodots';
const KEY = 'cache.schema_version';
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function withApp<T>(
  fn: (ctx: {
    app: ReturnType<typeof createApp>;
    env: Parameters<Parameters<typeof withWatcherEnv>[0]>[0];
    get: (path: string, init?: RequestInit) => Promise<Response> | Response;
    post: (path: string, body: unknown) => Promise<Response> | Response;
    seen: { invalid: number[] };
  }) => Promise<T>,
): Promise<T> {
  return withWatcherEnv(async (env) => {
    const { h } = env;
    const store = new Store(':memory:');
    const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      ownerToken: TOKEN,
    });
    const notifier = createPgEventNotifier(h.db.urls.app);
    const watcher = env.make({ ledger: { events: createEventSink() } });
    const seen = { invalid: [] as number[] };
    app.route(
      P,
      nemodotsRoutes({
        ownerId: h.config.ownerId,
        pool: h.pool,
        control: h.coordinator.control,
        events: h.coordinator.events,
        notifier,
        mode: () => ({
          mode: 'fixture',
          missingEnv: [],
          invalidEnv: [],
          fixturePath: 'fixtures/x.json',
        }),
        ownerEdit: (edit) => ownerEdit({ pool: h.pool, watcher }, edit),
        // labelled stubs: both belong to the sandbox wave's composition
        startInjector: async () => ({ runId: randomUUID() }),
        checkoutHealth: async () => ({
          status: 'ok',
          postgres: true,
          redis: true,
          config_parse: true,
          writes: true,
          errorClasses: [],
          sampledAt: new Date().toISOString(),
        }),
        telemetry: (missionId) => telemetrySummary(h.pool, missionId),
        sse: { pollMs: 5_000, heartbeatMs: 300 },
        onInvalidEvent: (info) => void seen.invalid.push(info.id),
      }),
    );
    closers.push(async () => {
      await notifier.close();
      store.close();
    });
    return fn({
      app,
      env,
      seen,
      get: (path, init) =>
        app.request(`${P}${path}`, {
          ...init,
          headers: { ...auth, ...(init?.headers ?? {}) },
        }),
      post: (path, body) => {
        const request = json(body);
        return app.request(`${P}${path}`, {
          ...request,
          headers: { ...request.headers, ...auth },
        });
      },
    });
  });
}

describe('routes over the real coordinator', () => {
  it('creates, starts, pauses, resumes and cancels a mission; illegal steps are 409', async () => {
    await withApp(async ({ post, get }) => {
      const created = await post('/missions', { goal: 'restore the checkout' });
      expect(created.status).toBe(201);
      const mission = (await created.json()) as { id: string; status: string };
      expect(mission.status).toBe('created');
      expect((await post(`/missions/${mission.id}/pause`, {})).status).toBe(
        409,
      );
      expect((await post(`/missions/${mission.id}/start`, {})).status).toBe(
        200,
      );
      expect((await post(`/missions/${mission.id}/start`, {})).status).toBe(
        409,
      );
      expect((await post(`/missions/${mission.id}/pause`, {})).status).toBe(
        200,
      );
      expect((await post(`/missions/${mission.id}/resume`, {})).status).toBe(
        200,
      );
      expect((await post(`/missions/${mission.id}/cancel`, {})).status).toBe(
        200,
      );
      expect((await post(`/missions/${mission.id}/cancel`, {})).status).toBe(
        409,
      );
      const list = (await (await get('/missions')).json()) as { id: string }[];
      expect(list.map((m) => m.id)).toContain(mission.id);
    });
  });

  it('snapshot has no control keys or role URLs and sub-views come from it', async () => {
    await withApp(async ({ post, get }) => {
      const mission = (await (
        await post('/missions', { goal: 'g' })
      ).json()) as { id: string };
      const response = await get(`/missions/${mission.id}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      const snapshot = JSON.parse(text);
      expect(Object.keys(snapshot).sort()).toEqual([
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
      ]);
      expect(snapshot.lastEventId).toBeGreaterThan(0);
      expect(text).not.toMatch(/postgres(ql)?:\/\//i);
      expect(text).not.toMatch(
        /"control"|scenario_runs|fault_schedules|NEMODOTS_PG_URL/,
      );
      expect(await (await get(`/missions/${mission.id}/tasks`)).json()).toEqual(
        snapshot.tasks,
      );
      expect(
        await (await get(`/missions/${mission.id}/telemetry`)).json(),
      ).toEqual(snapshot.telemetry);
    });
  });

  it('a mission of another owner is invisible: 404 everywhere and absent from the list', async () => {
    await withApp(async ({ get, env, post }) => {
      const otherId = randomUUID();
      await env.h.admin.query(
        `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
         VALUES ($1, 'someone-else', 'test', 'checkout', 'not yours', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
        [otherId],
      );
      for (const suffix of ['', '/tasks', '/events', '/telemetry'])
        expect((await get(`/missions/${otherId}${suffix}`)).status).toBe(404);
      expect((await post(`/missions/${otherId}/cancel`, {})).status).toBe(404);
      const list = (await (await get('/missions')).json()) as { id: string }[];
      expect(list.map((m) => m.id)).not.toContain(otherId);
      expect(
        (await get(`/telemetry/summary?missionId=${otherId}`)).status,
      ).toBe(404);
    });
  });

  it('enforces the owner token and rejects cross-origin and non-JSON mutations', async () => {
    await withApp(async ({ app }) => {
      expect((await app.request(`${P}/missions`)).status).toBe(401);
      expect(
        (
          await app.request(`${P}/missions`, {
            headers: { ...auth, Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`${P}/missions`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'text/plain' },
            body: '{"goal":"x"}',
          })
        ).status,
      ).toBe(415);
    });
  });
});

describe('events over the real event table', () => {
  it('replays exactly the missing ids from Last-Event-ID, then delivers live events promptly', async () => {
    await withApp(async ({ post, get, env }) => {
      const mission = (await (
        await post('/missions', { goal: 'g' })
      ).json()) as { id: string };
      await post(`/missions/${mission.id}/start`, {});
      await post(`/missions/${mission.id}/pause`, {});
      const { rows } = await env.h.admin.query<{ id: string }>(
        `SELECT id FROM coordinator.events WHERE mission_id = $1 ORDER BY id`,
        [mission.id],
      );
      const ids = rows.map((r) => Number(r.id));
      expect(ids.length).toBeGreaterThanOrEqual(3);
      const after = ids[0];
      const response = await get(`/missions/${mission.id}/events`, {
        headers: { 'Last-Event-ID': String(after) },
      });
      expect(response.headers.get('content-type')).toMatch(
        /text\/event-stream/,
      );
      // a live event, produced after the stream opened
      setTimeout(() => void post(`/missions/${mission.id}/resume`, {}), 200);
      const frames = await readFrames(
        response,
        (f) =>
          f.filter(idOf).length >= ids.length &&
          f.some((x) => x.startsWith(': heartbeat')),
        6000,
      );
      const got = frames.map(idOf).filter(Boolean).map(Number);
      expect(got.slice(0, ids.length - 1)).toEqual(ids.slice(1));
      const live = got.slice(ids.length - 1);
      expect(live.length).toBeGreaterThanOrEqual(1);
      expect(live.every((id) => id > ids.at(-1)!)).toBe(true);
      expect(got).toEqual([...got].sort((a, b) => a - b));
      for (const frame of frames.filter(idOf)) {
        const event = dataOf(frame) as MissionEvent;
        expect(event.missionId).toBe(mission.id);
        expect(String(event.id)).toBe(idOf(frame));
      }
      expect(frames.some((f) => f.startsWith(': heartbeat'))).toBe(true);
    });
  });

  it('a stored row whose payload fails EventPayloadSchema is never written, and later events still flow', async () => {
    await withApp(async ({ post, get, env, seen }) => {
      const mission = (await (
        await post('/missions', { goal: 'g' })
      ).json()) as { id: string };
      const bad = await env.h.admin.query<{ id: string }>(
        `INSERT INTO coordinator.events (mission_id, kind, payload)
         VALUES ($1, 'task.created', '{"kind":"task.created","prompt":"SECRET PROMPT"}'::jsonb) RETURNING id`,
        [mission.id],
      );
      await post(`/missions/${mission.id}/start`, {});
      const response = await get(`/missions/${mission.id}/events`);
      const frames = await readFrames(response, (f) =>
        f.some((x) => dataOf(x)?.kind === 'mission.status'),
      );
      const ids = frames.map(idOf).filter(Boolean);
      expect(ids).not.toContain(bad.rows[0].id);
      expect(JSON.stringify(frames)).not.toContain('SECRET PROMPT');
      expect(frames.some((x) => dataOf(x)?.kind === 'mission.status')).toBe(
        true,
      );
      expect(seen.invalid).toContain(Number(bad.rows[0].id));
    });
  });

  it('an invalidation touching two missions reaches each stream with only that mission’s subset, and a manual edit advances the version and registers a receipt', async () => {
    await withApp(async ({ post, get, env }) => {
      const { h } = env;
      const make = async () => {
        const planned = await plannedMission(h, [
          { role: 'investigator' },
          { role: 'investigator' },
        ]);
        const claimed = await claimStart(h, { taskId: planned.taskIds[0] });
        const receipt = await env.observeMember(planned.missionId, KEY);
        await env.link(receipt.receipt.id, {
          attemptId: claimed.context.attemptId,
          taskId: planned.taskIds[0],
          missionId: planned.missionId,
        });
        return {
          missionId: planned.missionId,
          attemptId: claimed.context.attemptId,
        };
      };
      const a = await make();
      const b = await make();

      const key = encodeURIComponent(`checkout.config/${KEY}`);
      const edited = await post(`/sandbox/sources/${key}`, {
        value: 7,
        expectedVersion: 1,
      });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toEqual({
        key: `checkout.config/${KEY}`,
        version: 2,
      });
      // a second edit from the same stale version is refused
      expect(
        (
          await post(`/sandbox/sources/${key}`, {
            value: 8,
            expectedVersion: 1,
          })
        ).status,
      ).toBe(409);
      // a non-member key is refused before anything is written
      expect(
        (
          await post(
            `/sandbox/sources/${encodeURIComponent('checkout.health')}`,
            { value: 1, expectedVersion: 1 },
          )
        ).status,
      ).toBe(400);

      const { rows } = await h.admin.query<{ source_revision: number }>(
        `SELECT r.source_revision FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = $1 ORDER BY r.source_revision DESC LIMIT 1`,
        [`checkout.config/${KEY}`],
      );
      expect(rows[0].source_revision).toBe(2);

      const invalidationFor = async (missionId: string) => {
        const response = await get(`/missions/${missionId}/events`);
        const frames = await readFrames(response, (f) =>
          f.some((x) => dataOf(x)?.kind === 'invalidation.recorded'),
        );
        return frames
          .map(dataOf)
          .filter(
            (e): e is MissionEvent => e?.kind === 'invalidation.recorded',
          );
      };
      for (const [mine, theirs] of [
        [a, b],
        [b, a],
      ] as const) {
        const events = await invalidationFor(mine.missionId);
        expect(events.length).toBeGreaterThanOrEqual(1);
        const text = JSON.stringify(events);
        expect(text).toContain(mine.attemptId);
        expect(text).not.toContain(theirs.attemptId);
        expect(text).not.toContain(theirs.missionId);
      }
    });
  });
});
