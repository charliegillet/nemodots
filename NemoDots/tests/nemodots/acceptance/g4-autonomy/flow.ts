// Shared flows for the gate 4 test files.
import { afterAll } from 'vitest';
import { type EventTail, type NemoApi } from './api.js';
import { NEUTRAL_CONSTRAINTS, NEUTRAL_GOAL } from './config.js';
import { type Provider, type ProviderScript, startProvider } from './provider.js';
import { readConfig, startSystem, type System, type SystemOptions } from './system.js';
import type { MissionSnapshot } from '../../../../src/server/nemodots/contracts/index.js';

/**
 * Lazily starts the system on first use inside a test, so a missing entry
 * point fails every test that needs it with the same explicit message (a
 * failing beforeAll would leave the tests unreported instead of failed).
 */
export function lazySystem(options: {
  model?: string;
  script?: ProviderScript;
  upstream?: { baseUrl: string; apiKey: string };
  system?: Omit<SystemOptions, 'providerUrl' | 'providerModel'>;
  providerPort: number;
}) {
  let starting: Promise<{ system: System; provider: Provider }> | null = null;
  const get = () => {
    starting ??= (async () => {
      const model = options.model ?? 'acc4-scripted-model';
      const provider = await startProvider({
        port: options.providerPort,
        model,
        script: options.script,
        upstream: options.upstream,
      });
      try {
        const system = await startSystem({
          ...(options.system ?? {}),
          providerUrl: provider.url,
          providerModel: model,
        });
        return { system, provider };
      } catch (error) {
        await provider.close();
        throw error;
      }
    })();
    return starting;
  };
  afterAll(async () => {
    if (!starting) return;
    const started = await starting.catch(() => null);
    if (started) {
      await started.system.stop().catch(() => undefined);
      await started.provider.close().catch(() => undefined);
    }
  }, 120_000);
  return get;
}

/** Creates a goal-only mission (the gate-6 neutral goal, no fault named) and starts it. */
export async function launchMission(
  api: NemoApi,
  options: { admissionMinAgeMs?: number; start?: boolean } = {},
) {
  const mission = await api.createMission({
    goal: NEUTRAL_GOAL,
    constraints: NEUTRAL_CONSTRAINTS,
    ...(options.admissionMinAgeMs !== undefined
      ? { admission: { minAgeMs: options.admissionMinAgeMs } }
      : {}),
  });
  const tail = api.tail(mission.id).start();
  if (options.start !== false) await api.lifecycle(mission.id, 'start');
  return { mission, tail };
}

export async function finish(api: NemoApi, missionId: string, tail: EventTail) {
  await api.lifecycle(missionId, 'cancel', [200, 409]).catch(() => undefined);
  await tail.stop();
}

/** A value different from `current` inside the key's documented domain (oracle spec-enums). */
export function alternateValue(key: string, current: unknown): string | number | boolean {
  switch (key) {
    case 'cache.schema_version': {
      const n = Number(current);
      return n >= 9 ? n - 1 : n + 1;
    }
    case 'db.pool_max': {
      const n = Number(current);
      return n >= 20 ? n - 1 : n + 1;
    }
    case 'db.statement_timeout_ms': {
      const n = Number(current);
      return n >= 30000 ? n - 100 : n + 100;
    }
    case 'routing.inventory_source':
      return current === 'primary' ? 'replica_stale' : 'primary';
    case 'orders.write_enabled':
      return !(current === true || current === 'true');
    case 'cache.namespace':
      return current === 'acc4-alt' ? 'acc4-alt2' : 'acc4-alt';
    case 'ui.banner_text':
      return `banner ${Date.now()}`;
    default:
      throw new Error(`no alternate value defined for ${key}`);
  }
}

/** Owner-style manual edit through the documented route, using the live version from the verifier role. */
export async function changeSource(system: System, key: string, value?: string | number | boolean) {
  const before = await readConfig(system, key);
  const next = value ?? alternateValue(key, before.value);
  const result = await system.api.editSource(key, next, before.version);
  return { before, next, result };
}

export function snapshotSummary(snapshot: MissionSnapshot) {
  return {
    status: snapshot.mission.status,
    tasks: snapshot.tasks.map((t) => `${t.title}:${t.status}`),
  };
}
