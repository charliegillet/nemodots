import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInjectorTrigger,
  UnknownScenarioError,
} from '../../../src/server/nemodots/routes/index.js';
import type { ScenarioManifest } from '../../../src/server/nemodots/sandbox/manifest.js';

const dir = path.resolve(process.cwd(), 'evals', 'nemodots', 'scenarios');

describe('createInjectorTrigger', () => {
  it('loads the named development scenario, starts it with the seed and returns only the run id', async () => {
    const started: { manifest: ScenarioManifest; seed: number }[] = [];
    const trigger = createInjectorTrigger({
      scenarioDir: dir,
      seed: () => 7,
      injector: {
        async start(manifest, seed) {
          started.push({ manifest, seed });
          return { runId: 'run-1', extra: 'leak' } as { runId: string };
        },
      },
    });
    const result = await trigger.run('benign_change');
    expect(result).toEqual({ runId: 'run-1' });
    expect(started).toHaveLength(1);
    expect(started[0].manifest.id).toBe('benign_change');
    expect(started[0].seed).toBe(7);
  });

  it('refuses an unknown scenario without starting anything', async () => {
    let calls = 0;
    const trigger = createInjectorTrigger({
      scenarioDir: dir,
      injector: {
        async start() {
          calls += 1;
          return { runId: 'x' };
        },
      },
    });
    await expect(trigger.run('does_not_exist')).rejects.toBeInstanceOf(
      UnknownScenarioError,
    );
    await expect(trigger.run('../frozen/manifest')).rejects.toBeInstanceOf(
      UnknownScenarioError,
    );
    expect(calls).toBe(0);
  });
});
