import { randomUUID } from 'node:crypto';
import { Store } from '../../../src/server/store.js';
import { Runner } from '../../../src/server/runner.js';
import { createApp } from '../../../src/server/app.js';
import {
  MissionSchema,
  type Mission,
  type MissionEvent,
  type MissionId,
} from '../../../src/server/nemodots/contracts/index.js';
import { MissionStateError } from '../../../src/server/nemodots/coordinator/errors.js';
import {
  nemodotsRoutes,
  type NemodotsRouteDeps,
} from '../../../src/server/nemodots/routes/index.js';
import type { ModeResolution } from '../../../src/server/nemodots/inference/mode.js';

export const OWNER = 'owner';

export function missionFixture(over: Record<string, unknown> = {}): Mission {
  const id = randomUUID();
  return MissionSchema.parse({
    id,
    scope: {
      ownerId: OWNER,
      missionId: id,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    goal: 'restore the checkout',
    constraints: [],
    mode: 'fixture',
    status: 'running',
    transitionVersion: 1,
    generation: 0,
    budgets: {
      maxTasks: 24,
      maxDepth: 3,
      maxBreadth: 4,
      maxTokens: 200000,
      maxInferenceCalls: 200,
      maxWallClockMs: 600000,
    },
    admission: { minAgeMs: 0 },
    provider: { host: 'fixture.invalid', plannerModel: 'p', workerModel: 'w' },
    acceptanceReceiptId: null,
    failureReason: null,
    cancellation: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  });
}

export const fixtureMode: ModeResolution = {
  mode: 'fixture',
  missingEnv: [],
  invalidEnv: [],
  fixturePath: 'fixtures/x.json',
};
export const liveMode: ModeResolution = {
  mode: 'live',
  missingEnv: [],
  invalidEnv: [],
  host: 'api.inference.crusoecloud.com',
  model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
};
export const blockedMode: ModeResolution = {
  mode: 'blocked',
  missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  invalidEnv: [],
  reason: 'missing_env',
};

export const emptyTelemetry = {
  calls: 0,
  orphanedCalls: 0,
  tokens: {
    prompt: 0,
    completion: 0,
    cached: { available: false, total: null },
  },
  byModel: [],
  byRole: [],
  retries: 0,
  errors: 0,
  ttftMs: null,
  prefixGroups: [],
};

export function snapshotOf(
  mission: Mission,
  extra: Record<string, unknown> = {},
) {
  return {
    mission,
    tasks: [],
    attempts: [],
    outputs: [],
    findings: [],
    receipts: [],
    confirmations: [],
    actions: [],
    authorizations: [],
    results: [],
    invalidations: [],
    recoveries: [],
    probe: null,
    telemetry: emptyTelemetry,
    lastEventId: 0,
    ...extra,
  };
}

export function eventOf(
  missionId: string,
  id: number,
  payload: Record<string, unknown> = { kind: 'heartbeat' },
): MissionEvent {
  return {
    id,
    missionId: missionId as MissionId,
    kind: payload.kind as MissionEvent['kind'],
    at: '2026-10-18T10:00:00.000Z',
    payload: payload as never,
  };
}

export interface StubWorld {
  missions: Map<string, Mission>;
  events: MissionEvent[];
  calls: string[];
}

export function stubDeps(
  world: StubWorld,
  over: Partial<NemodotsRouteDeps> = {},
): NemodotsRouteDeps {
  const get = async (id: MissionId) => {
    const found = world.missions.get(id);
    if (!found) {
      const { MissionNotFoundError } =
        await import('../../../src/server/nemodots/coordinator/errors.js');
      throw new MissionNotFoundError(id);
    }
    return found;
  };
  const lifecycle =
    (name: string, allowed: string[]) => async (id: MissionId) => {
      world.calls.push(`${name}:${id}`);
      const mission = await get(id);
      if (!allowed.includes(mission.status))
        throw new MissionStateError(id, mission.status, name);
      return mission;
    };
  return {
    ownerId: OWNER,
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
    },
    control: {
      get,
      create: async (request) => {
        world.calls.push(`create:${JSON.stringify(request)}`);
        const created = missionFixture({ status: 'created' });
        world.missions.set(created.id, created);
        return created;
      },
      start: lifecycle('start', ['created', 'paused']),
      pause: lifecycle('pause', ['running']),
      resume: lifecycle('resume', ['paused']),
      cancel: lifecycle('cancel', ['running', 'paused', 'created']),
      snapshot: async (id) => snapshotOf(await get(id)) as never,
    },
    events: {
      replay: async (missionId, afterId, limit = 500) =>
        world.events
          .filter((e) => e.missionId === missionId && e.id > afterId)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit),
    },
    mode: () => fixtureMode,
    ownerEdit: async (edit) => {
      world.calls.push(`edit:${edit.key}:${edit.expectedVersion}`);
      return {
        change: { key: edit.key, versionAfter: edit.expectedVersion + 1 },
      };
    },
    startInjector: async (scenarioClass) => {
      world.calls.push(`inject:${scenarioClass}`);
      return {
        runId: 'run-1',
        seed: 42,
        manifest: { secret: 'manifest-body' },
      } as never;
    },
    checkoutHealth: async () => ({
      status: 'ok',
      postgres: true,
      redis: true,
      config_parse: true,
      writes: true,
      errorClasses: [],
      sampledAt: '2026-10-18T10:00:00.000Z',
    }),
    telemetry: async () => emptyTelemetry,
    sse: { pollMs: 20, heartbeatMs: 60 },
    ...over,
  };
}

export function build(
  deps: NemodotsRouteDeps,
  options: { ownerToken?: string; origin?: string | string[] } = {},
) {
  const store = new Store(':memory:');
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: options.ownerToken,
    origin: options.origin,
  });
  app.route('/api/nemodots', nemodotsRoutes(deps));
  return { app, close: () => store.close() };
}

export const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Reads SSE frames from a streaming response until `stop` says so or the timeout passes. */
export async function readFrames(
  response: Response,
  stop: (frames: string[]) => boolean,
  timeoutMs = 3000,
): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  // One read stays pending across polls: abandoning a read would drop its chunk.
  let pending: ReturnType<typeof reader.read> | null = null;
  try {
    while (Date.now() < deadline && !stop(frames)) {
      pending ??= reader.read();
      const next = await Promise.race([
        pending,
        new Promise<null>((r) => setTimeout(() => r(null), 100)),
      ]);
      if (next === null) continue;
      pending = null;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

export const dataOf = (frame: string) => {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  return line ? (JSON.parse(line.slice(5).trim()) as MissionEvent) : null;
};
export const idOf = (frame: string) =>
  frame
    .split('\n')
    .find((l) => l.startsWith('id:'))
    ?.slice(3)
    .trim();
