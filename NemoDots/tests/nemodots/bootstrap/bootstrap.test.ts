import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server/app.js';
import { createShutdown } from '../../../src/server/shutdown.js';
import { Runner } from '../../../src/server/runner.js';
import { Store } from '../../../src/server/store.js';
import {
  createNemoDots,
  phaseOfEvent,
  resolveNemoDotsEnv,
} from '../../../src/server/nemodots/bootstrap.js';
import type { MissionEvent } from '../../../src/server/nemodots/contracts/index.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function appRoot(rolesMode = 0o600, withFile = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-boot-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (withFile) {
    const dir = path.join(root, '.local', 'dev', 'stack');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'roles.env');
    writeFileSync(
      file,
      [
        'NEMODOTS_PG_URL_APP=postgres://nemodots_app:pw-app-secret@127.0.0.1:55442/nemodots',
        'NEMODOTS_PROBE_SECRET=probe-secret-value-0123456789',
        'UNRELATED_NAME=ignored',
      ].join('\n'),
    );
    chmodSync(file, rolesMode);
  }
  return root;
}

describe('resolveNemoDotsEnv', () => {
  it('fills role URLs and the probe secret from roles.env into a copy, never the input', () => {
    const env = { NEMODOTS_INSTANCE: 'dev', OTHER: 'x' };
    const merged = resolveNemoDotsEnv(env, appRoot());
    expect(merged.NEMODOTS_PG_URL_APP).toContain('nemodots_app');
    expect(merged.NEMODOTS_PROBE_SECRET).toBeTruthy();
    expect(merged.UNRELATED_NAME).toBeUndefined();
    expect(env).toEqual({ NEMODOTS_INSTANCE: 'dev', OTHER: 'x' });
  });

  it('the process environment wins over the file', () => {
    const merged = resolveNemoDotsEnv(
      { NEMODOTS_PG_URL_APP: 'postgres://override@127.0.0.1:55442/x' },
      appRoot(),
    );
    expect(merged.NEMODOTS_PG_URL_APP).toBe(
      'postgres://override@127.0.0.1:55442/x',
    );
  });

  it('a missing or group-readable file leaves the URLs absent', () => {
    expect(
      resolveNemoDotsEnv({}, appRoot(0o600, false)).NEMODOTS_PG_URL_APP,
    ).toBeUndefined();
    expect(
      resolveNemoDotsEnv({}, appRoot(0o644)).NEMODOTS_PG_URL_APP,
    ).toBeUndefined();
  });
});

describe('an unconfigured NemoDots', () => {
  function unconfigured() {
    return createNemoDots(
      { NEMODOTS_INSTANCE: 'dev' },
      { workspace: { ownerId: 'owner' }, appRoot: appRoot(0o600, false) },
    );
  }

  it('reports blocked health with names only; everything else is 503; start and stop are no-ops', async () => {
    const nemodots = unconfigured();
    expect(nemodots.state()).toBe('unconfigured');
    const health = (await (
      await Promise.resolve(nemodots.router.request('/health'))
    ).json()) as {
      mode: string;
      postgres: string;
      missingEnv: string[];
    };
    expect(health).toMatchObject({ mode: 'blocked', postgres: 'down' });
    expect(
      health.missingEnv.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)),
    ).toBe(true);
    expect(health.missingEnv).toContain('NEMODOTS_PG_URL_APP');
    for (const [method, route] of [
      ['GET', '/missions'],
      ['POST', '/missions'],
      ['GET', '/telemetry/summary'],
    ] as const) {
      const response = await Promise.resolve(
        nemodots.router.request(route, { method }),
      );
      expect(response.status).toBe(503);
    }
    await nemodots.start();
    await nemodots.stop();
    expect(await nemodots.health()).toMatchObject({ mode: 'blocked' });
  });

  it('mounted on the upstream app it sits behind the owner token, and the upstream routes are untouched', async () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
    const build = (nemodots?: ReturnType<typeof unconfigured>) =>
      createApp({
        store,
        runner: new Runner(store, config),
        config,
        ownerToken: 'owner-token-for-bootstrap-test',
        nemodots,
      });
    const withNd = build(unconfigured());
    expect((await withNd.request('/api/nemodots/health')).status).toBe(401);
    const auth = { Authorization: 'Bearer owner-token-for-bootstrap-test' };
    expect(
      (await withNd.request('/api/nemodots/health', { headers: auth })).status,
    ).toBe(200);
    expect((await withNd.request('/api/state', { headers: auth })).status).toBe(
      200,
    );
    // Without the option the route does not exist (upstream behaviour).
    const without = build();
    expect(
      (await without.request('/api/nemodots/health', { headers: auth })).status,
    ).toBe(404);
  });
});

describe('phaseOfEvent', () => {
  const event = (payload: Record<string, unknown>): MissionEvent =>
    ({ id: 1, missionId: 'm', kind: payload.kind, at: 'x', payload }) as never;
  it('maps stored events to timing marks and ignores the rest', () => {
    expect(phaseOfEvent(event({ kind: 'mission.status', to: 'running' }))).toBe(
      'started',
    );
    expect(
      phaseOfEvent(event({ kind: 'mission.status', to: 'succeeded' })),
    ).toBe('completed');
    expect(
      phaseOfEvent(event({ kind: 'mission.status', to: 'paused' })),
    ).toBeNull();
    expect(phaseOfEvent(event({ kind: 'invalidation.recorded' }))).toBe(
      'conflict_detected',
    );
    expect(phaseOfEvent(event({ kind: 'recovery.recorded' }))).toBe(
      'recovery_started',
    );
    expect(phaseOfEvent(event({ kind: 'invalidation.resolved' }))).toBe(
      'recovered',
    );
    expect(phaseOfEvent(event({ kind: 'heartbeat' }))).toBeNull();
  });
});

describe('shutdown', () => {
  it('stops NemoDots alongside the platform and the server, and still exits when it fails', async () => {
    const calls: string[] = [];
    let code = -1;
    const shutdown = createShutdown({
      stopRunner: () => void calls.push('runner'),
      stopPlatform: async () => void calls.push('platform'),
      stopNemoDots: async () => {
        calls.push('nemodots');
        throw new Error('boom');
      },
      closeServer: async () => void calls.push('server'),
      exit: (c) => void (code = c),
      report: () => undefined,
    });
    await shutdown();
    expect(calls.sort()).toEqual(['nemodots', 'platform', 'runner', 'server']);
    expect(code).toBe(1);
  });
});
