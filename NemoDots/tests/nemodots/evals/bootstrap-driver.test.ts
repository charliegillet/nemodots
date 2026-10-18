import { describe, expect, it } from 'vitest';
import { createBootstrapDriver } from '../../../src/server/nemodots/evals/bootstrap-driver.js';
import { HostBlockedError } from '../../../src/server/nemodots/evals/host.js';
import {
  STRATEGIES,
  type TrialSpec,
} from '../../../src/server/nemodots/evals/types.js';

const spec = (
  strategy: TrialSpec['strategy'],
  layout: TrialSpec['layout'],
): TrialSpec => ({
  trialId: 't',
  cohortId: 'c',
  scenarioId: 'healthy',
  scenarioVersion: 1,
  seed: 1,
  strategy,
  layout,
  blockIndex: 0,
  runIndex: 0,
});

function fakeSystem(startState: 'running' | 'failed' = 'running') {
  const log: string[] = [];
  type Options = {
    recoveryScopeRules: Record<string, unknown>;
    autoWorkers: boolean;
    teamLayout: () => string;
  };
  const created: { options: Options }[] = [];
  const create = ((_env: unknown, options: Options) => {
    created.push({ options });
    let state: string = 'stopped';
    const id = created.length;
    return {
      state: () => state,
      async start() {
        state = startState;
        log.push(`start:${id}`);
      },
      async stop() {
        state = 'stopped';
        log.push(`stop:${id}`);
      },
      async health() {
        return { missingEnv: ['OPENAI_API_KEY'] };
      },
      coordinator: {
        control: {
          async create(request: unknown, server: unknown) {
            log.push(
              `create:${id}:${JSON.stringify(server)}:${(request as { goal: string }).goal}`,
            );
            return { id: `mission-${id}` };
          },
          async start(missionId: string) {
            log.push(`mission-start:${missionId}`);
          },
          async cancel(missionId: string) {
            log.push(`cancel:${missionId}`);
          },
        },
      },
    };
  }) as never;
  return { create, log, created };
}

describe('bootstrap driver', () => {
  it('registers every strategy by name, fixes the rule at creation and starts the mission', async () => {
    const { create, log, created } = fakeSystem();
    const driver = createBootstrapDriver({ env: {}, create });
    const result = await driver.createAndStart(
      spec('dag-restart', 'cache_aware'),
      'the goal',
    );
    expect(result).toEqual({ missionId: 'mission-1' });
    expect(Object.keys(created[0].options.recoveryScopeRules).sort()).toEqual(
      [...STRATEGIES].sort(),
    );
    expect(created[0].options.autoWorkers).toBe(true);
    expect(created[0].options.teamLayout()).toBe('cache_aware');
    expect(log).toEqual([
      'start:1',
      'create:1:{"recoveryScopeRule":"dag-restart"}:the goal',
      'mission-start:mission-1',
    ]);
  });

  it('reuses the running system for the same layout and rebuilds it when the layout changes', async () => {
    const { create, log, created } = fakeSystem();
    const driver = createBootstrapDriver({ env: {}, create });
    await driver.createAndStart(spec('selective', 'cache_aware'), 'g');
    await driver.createAndStart(spec('broad-restart', 'cache_aware'), 'g');
    expect(created).toHaveLength(1);
    await driver.createAndStart(spec('selective', 'ordinary'), 'g');
    expect(created).toHaveLength(2);
    expect(created[1].options.teamLayout()).toBe('ordinary');
    expect(log.filter((l) => l.startsWith('stop'))).toEqual(['stop:1']);
  });

  it('a system that does not start is BLOCKED, naming what the product reports missing', async () => {
    const { create } = fakeSystem('failed');
    const driver = createBootstrapDriver({ env: {}, create });
    await expect(
      driver.createAndStart(spec('selective', 'cache_aware'), 'g'),
    ).rejects.toMatchObject({
      name: 'HostBlockedError',
      missing: ['OPENAI_API_KEY'],
    });
    await expect(
      driver.createAndStart(spec('selective', 'cache_aware'), 'g'),
    ).rejects.toBeInstanceOf(HostBlockedError);
  });

  it('cancel and close are safe before anything started', async () => {
    const driver = createBootstrapDriver({
      env: {},
      create: fakeSystem().create,
    });
    await driver.cancel('m');
    await driver.close();
  });

  it('cancel reaches the coordinator and close stops the system', async () => {
    const { create, log } = fakeSystem();
    const driver = createBootstrapDriver({ env: {}, create });
    await driver.createAndStart(spec('selective', 'cache_aware'), 'g');
    await driver.cancel('mission-1');
    await driver.close();
    expect(log).toContain('cancel:mission-1');
    expect(log.at(-1)).toBe('stop:1');
  });
});
