// Gate 3 over real HTTP (app on port 4661): owner/auth/origin protections preserved on upstream and
// NemoDots routes, strict request bodies, model/client-supplied ids that grant nothing, mission scoping of
// snapshots and SSE, and no secrets in route responses. Contract: CONTRACTS.md section 9.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_TOKEN,
  PORTS,
  lazyWorld,
  secretsPresentIn,
  visibleSecrets,
  type World,
} from './g3-support.js';

const lazy = lazyWorld({ nemodots: true, serve: true });
let w: World;
beforeEach(async () => {
  w = await lazy.get();
}, 600_000);
afterAll(async () => {
  await lazy.close();
}, 120_000);

const URL_BASE = `http://127.0.0.1:${PORTS.app}`;
const RANDOM_ID = '9b0c1d2e-3f40-4152-8364-758697a8b9ca';

// CONTRACTS.md section 9, the complete route table.
const ROUTES: [method: string, path: string, body?: unknown][] = [
  ['GET', '/api/nemodots/health'],
  ['GET', '/api/nemodots/missions'],
  ['POST', '/api/nemodots/missions', { goal: 'Restore checkout health' }],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}`],
  ['POST', `/api/nemodots/missions/${RANDOM_ID}/start`, {}],
  ['POST', `/api/nemodots/missions/${RANDOM_ID}/pause`, {}],
  ['POST', `/api/nemodots/missions/${RANDOM_ID}/resume`, {}],
  ['POST', `/api/nemodots/missions/${RANDOM_ID}/cancel`, {}],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/events`],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/tasks`],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/evidence`],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/actions`],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/recovery`],
  ['GET', `/api/nemodots/missions/${RANDOM_ID}/telemetry`],
  [
    'POST',
    '/api/nemodots/sandbox/sources/checkout.config%2Fcache.namespace',
    { value: 'b', expectedVersion: 1 },
  ],
  [
    'POST',
    '/api/nemodots/sandbox/injector/run',
    { scenarioClass: 'healthy_control' },
  ],
  ['GET', '/api/nemodots/sandbox/checkout/health'],
  ['GET', '/api/nemodots/telemetry/summary'],
  ['GET', '/api/nemodots/evals/report'],
];

function raw(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  return fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}`, Origin: URL_BASE };

describe('[TP3.2] owner identity, origin and content-type protections apply to every NemoDots route (and upstream routes stay protected)', () => {
  it.each(ROUTES.map(([m, p, b]) => [m, p, b] as const))(
    '[TP3.2][M13] %s %s without the owner token is 401 and reveals nothing',
    async (method, path, body) => {
      const response = await raw(method, path, body, { Origin: URL_BASE });
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).not.toContain(RANDOM_ID);
      response.body?.cancel().catch(() => undefined);
    },
  );

  it.each(ROUTES.slice(0, 4).map(([m, p, b]) => [m, p, b] as const))(
    '[TP3.2][M13] %s %s with a wrong token, a cross-origin Origin, or Sec-Fetch-Site cross-site is refused',
    async (method, path, body) => {
      const wrongToken = await raw(method, path, body, {
        ...owner,
        Authorization: 'Bearer wrong-token',
      });
      expect(wrongToken.status).toBe(401);
      const wrongOrigin = await raw(method, path, body, {
        ...owner,
        Origin: 'https://evil.example',
      });
      expect(wrongOrigin.status).toBe(403);
      const crossSite = await raw(method, path, body, {
        ...owner,
        'Sec-Fetch-Site': 'cross-site',
      });
      expect(crossSite.status).toBe(403);
    },
  );

  it('[TP3.2] a state-changing request that is not application/json is refused (415) on NemoDots and upstream routes', async () => {
    for (const path of [
      '/api/nemodots/missions',
      `/api/nemodots/missions/${RANDOM_ID}/start`,
      '/api/nemodots/sandbox/injector/run',
    ]) {
      const response = await fetch(`${URL_BASE}${path}`, {
        method: 'POST',
        headers: { ...owner, 'Content-Type': 'text/plain' },
        body: '{"goal":"x"}',
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, path).toBe(415);
    }
  });

  it('[TP3.2][M13] upstream owner routes (pages, dots, connections, computer) stay token-protected with the NemoDots composition installed', async () => {
    const dotId = w.incident.id;
    const probes: [string, string, unknown?][] = [
      ['GET', `/api/spaces/${w.spaceA}/pages`],
      [
        'PATCH',
        `/api/spaces/${w.spaceA}/pages/${RANDOM_ID}`,
        { expectedRevision: 1, content: 'x' },
      ],
      ['PUT', `/api/dots/${dotId}`, { name: 'x' }],
      ['GET', `/api/dots/${dotId}/connections`],
      [
        'POST',
        `/api/dots/${dotId}/computer/actions`,
        { action: 'snapshot', input: {} },
      ],
      [
        'POST',
        `/api/conversations/${RANDOM_ID}/connection-actions`,
        { approvalId: 'x', toolCallId: 'y' },
      ],
    ];
    for (const [method, path, body] of probes) {
      const response = await raw(method, path, body, { Origin: URL_BASE });
      expect(response.status, `${method} ${path}`).toBe(401);
      await response.arrayBuffer();
    }
  });
});

describe('[TP3.2] request bodies are strict: ids, roles and authority supplied by the client or model grant nothing', () => {
  it.each([
    'ownerId',
    'spaceId',
    'dotId',
    'missionId',
    'capabilities',
    'role',
    'status',
    'generation',
    'environment',
    'leaseToken',
  ])(
    '[TP3.2] POST /missions with an extra %s field is rejected with 400 and creates nothing',
    async (key) => {
      const before = (await (
        await w.authed('/api/nemodots/missions')
      ).json()) as unknown[];
      const response = await w.authed('/api/nemodots/missions', {
        method: 'POST',
        body: JSON.stringify({
          goal: 'Restore checkout health',
          [key]: 'attacker-chosen',
        }),
      });
      expect(response.status).toBe(400);
      const after = (await (
        await w.authed('/api/nemodots/missions')
      ).json()) as unknown[];
      expect(after).toHaveLength(before.length);
    },
  );

  it('[TP3.2] a mode that disagrees with the server mode is rejected (a fixture run can never be presented as live)', async () => {
    const response = await w.authed('/api/nemodots/missions', {
      method: 'POST',
      body: JSON.stringify({ goal: 'Restore checkout health', mode: 'live' }),
    });
    expect(response.status).toBe(400);
  });

  it('[TP3.2] lifecycle routes take an empty body only; a body-supplied mission id cannot redirect them', async () => {
    const created = await w.authed('/api/nemodots/missions', {
      method: 'POST',
      body: JSON.stringify({ goal: 'Restore checkout health' }),
    });
    expect(created.status, 'mission creation in fixture mode').toBe(201);
    const mission = (await created.json()) as { id: string };
    const response = await w.authed(
      `/api/nemodots/missions/${mission.id}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ missionId: RANDOM_ID }),
      },
    );
    expect(response.status).toBe(400);
    const snapshot = await w.authed(`/api/nemodots/missions/${mission.id}`);
    expect(
      ((await snapshot.json()) as { mission: { status: string } }).mission
        .status,
    ).not.toBe('cancelled');
  });

  it('[TP3.2] the manual source edit and injector routes reject extra keys, unregistered keys and wrong scenario classes', async () => {
    const extra = await w.authed(
      '/api/nemodots/sandbox/sources/checkout.config%2Fcache.namespace',
      {
        method: 'POST',
        body: JSON.stringify({
          value: 'b',
          expectedVersion: 1,
          actor: 'injector',
          environment: 'prod',
        }),
      },
    );
    expect(extra.status).toBe(400);
    for (const key of [
      '../../etc/passwd',
      'checkout.config%2Fnot_a_key',
      'redis.password',
      'postgres%3A%2F%2Fx',
    ]) {
      const response = await w.authed(`/api/nemodots/sandbox/sources/${key}`, {
        method: 'POST',
        body: JSON.stringify({ value: 'b', expectedVersion: 1 }),
      });
      expect([400, 404], key).toContain(response.status);
    }
    const bad = await w.authed('/api/nemodots/sandbox/injector/run', {
      method: 'POST',
      body: JSON.stringify({ scenarioClass: 'delete_everything' }),
    });
    expect(bad.status).toBe(400);
    const leaky = await w.authed('/api/nemodots/sandbox/injector/run', {
      method: 'POST',
      body: JSON.stringify({
        scenarioClass: 'healthy_control',
        manifest: { fault: 'cache.namespace' },
      }),
    });
    expect(
      leaky.status,
      'the injector run takes only a scenario class and returns only a run id',
    ).toBe(400);
  });
});

describe('[TP3.2] missions are scoped: unknown and foreign ids reveal nothing, snapshots and SSE contain one mission', () => {
  it('[TP3.2] unknown mission ids are 404 on every mission route (never an empty 200, a stream, or a 500); malformed ids are 4xx', async () => {
    for (const [method, path, body] of ROUTES.filter(([, p]) =>
      p.includes(`/missions/${RANDOM_ID}`),
    )) {
      const response = await w.authed(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      response.body?.cancel().catch(() => undefined);
    }
    for (const id of [
      '..',
      '%2e%2e',
      'x'.repeat(300),
      'a%00b',
      '1;DROP TABLE missions',
    ]) {
      const response = await w.authed(`/api/nemodots/missions/${id}`);
      expect(response.status, id).toBeGreaterThanOrEqual(400);
      expect(response.status, id).toBeLessThan(500);
      await response.arrayBuffer();
    }
  });

  it('[TP3.2] a mission snapshot contains only its own rows, and the SSE stream of one mission never carries another mission id', async () => {
    const make = async (goal: string) => {
      const response = await w.authed('/api/nemodots/missions', {
        method: 'POST',
        body: JSON.stringify({ goal }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const a = await make('Restore checkout health, mission A');
    const b = await make('Restore checkout health, mission B');
    expect(a).not.toBe(b);
    const snapshotA = JSON.stringify(
      await (await w.authed(`/api/nemodots/missions/${a}`)).json(),
    );
    expect(snapshotA).not.toContain(b);

    const controller = new AbortController();
    const response = await fetch(
      `${URL_BASE}/api/nemodots/missions/${a}/events`,
      {
        headers: { ...owner, 'Last-Event-ID': '0' },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain(
      'text/event-stream',
    );
    const reader = response.body!.getReader();
    let received = '';
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 600),
        ),
      ]);
      if (next.done) break;
      received += new TextDecoder().decode(next.value);
    }
    controller.abort();
    expect(received).not.toContain(b);
  });

  it('[TP3.2] telemetry summary rejects a malformed missionId and never returns another mission data', async () => {
    const malformed = await w.authed(
      '/api/nemodots/telemetry/summary?missionId=..%2F..%2Fetc',
    );
    expect(malformed.status).toBe(400);
    const unknown = await w.authed(
      `/api/nemodots/telemetry/summary?missionId=${RANDOM_ID}`,
    );
    expect([200, 404]).toContain(unknown.status);
    if (unknown.status === 200) {
      const body = (await unknown.json()) as { calls: number };
      expect(body.calls).toBe(0);
    }
  });
});

describe('[TP3.7] route responses never carry secrets', () => {
  it('[TP3.7] health, mission list, telemetry and a mission snapshot contain no credential value, role URL password, or connection string', async () => {
    const secrets = visibleSecrets();
    const paths = [
      '/api/nemodots/health',
      '/api/nemodots/missions',
      '/api/nemodots/telemetry/summary',
      '/api/nemodots/evals/report',
      '/api/nemodots/sandbox/checkout/health',
    ];
    for (const path of paths) {
      const response = await w.authed(path);
      const text = await response.text();
      expect(secretsPresentIn(text, secrets), path).toEqual([]);
      expect(text, path).not.toMatch(/postgres(ql)?:\/\/[^"\s]*:[^"\s@]+@/);
      expect(text, path).not.toMatch(/redis:\/\/[^"\s]*:[^"\s@]+@/);
      expect(text, path).not.toMatch(
        /nvapi-[A-Za-z0-9_-]{12,}|\bsk-[A-Za-z0-9_-]{20,}/,
      );
    }
    const health = (await (await w.authed('/api/nemodots/health')).json()) as {
      missingEnv: string[];
    };
    for (const name of health.missingEnv)
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('[TP3.7] an error response for malformed input does not echo environment values or stack traces', async () => {
    const response = await w.authed('/api/nemodots/missions', {
      method: 'POST',
      body: '{"goal": ',
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toMatch(/\n\s+at\s+\S+\s+\(|node_modules|\/Users\//);
    expect(secretsPresentIn(text, visibleSecrets())).toEqual([]);
  });
});
