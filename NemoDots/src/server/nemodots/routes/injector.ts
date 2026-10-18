import {
  defaultScenarioDir,
  listScenarios,
  loadScenario,
  type ScenarioManifest,
} from '../sandbox/manifest.js';
import { UnknownScenarioError } from './errors.js';

// Injector trigger for POST /sandbox/injector/run. The route only ever returns
// {runId}; the manifest, its oracle and the injected values stay inside the
// injector (role nemodots_injector) and never reach the response.

export interface InjectorStarter {
  start(manifest: ScenarioManifest, seed: number): Promise<{ runId: string }>;
}

export interface InjectorTrigger {
  run(scenarioClass: string): Promise<{ runId: string }>;
}

export interface InjectorTriggerOptions {
  injector: InjectorStarter;
  /** Defaults to evals/nemodots/scenarios (the development set). */
  scenarioDir?: string;
  seed?: () => number;
}

export function createInjectorTrigger(
  options: InjectorTriggerOptions,
): InjectorTrigger {
  const dir = options.scenarioDir ?? defaultScenarioDir();
  const seed = options.seed ?? (() => Math.floor(Date.now() % 1_000_000));
  return {
    async run(scenarioClass) {
      if (!listScenarios(dir).includes(scenarioClass))
        throw new UnknownScenarioError(scenarioClass);
      const run = await options.injector.start(
        loadScenario(scenarioClass, dir),
        seed(),
      );
      return { runId: run.runId };
    },
  };
}
