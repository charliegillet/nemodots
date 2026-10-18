// MissionDriver over the product's composition root (bootstrap.ts). The
// product runs unchanged: the planner, workers, watcher, outbox and recovery
// are the ones the app uses. The harness adds only what an evaluation arm needs
// and a client must never be able to choose, through the options bootstrap
// exposes for it:
//   - `recoveryScopeRules`: the arms' scope rules, registered by name; the rule
//     of a mission is fixed at creation by the server
//     (`control.create(request, { recoveryScopeRule })`);
//   - `teamLayout`: the context layout, read when the team is built, so the
//     system is rebuilt whenever the next trial needs another layout.
// The arm is NOT trusted from these calls: the runner verifies from the
// database which scope rule and which layouts a mission actually used
// (runner.ts armMismatch) and discards a trial that ran as another arm.
import { createNemoDots, type NemoDots } from '../bootstrap.js';
import type { MissionId, RecoveryScopeRule } from '../contracts/index.js';
import { HostBlockedError } from './host.js';
import type { MissionDriver } from './live-host.js';
import { STRATEGY_RULES } from './strategies/index.js';
import type { LayoutName } from './types.js';

export interface BootstrapDriverOptions {
  env: Record<string, string | undefined>;
  ownerId?: string;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** test seam */
  create?: typeof createNemoDots;
}

export function createBootstrapDriver(
  options: BootstrapDriverOptions,
): MissionDriver {
  const create = options.create ?? createNemoDots;
  let system: NemoDots | null = null;
  let layout: LayoutName | null = null;

  async function running(wanted: LayoutName): Promise<NemoDots> {
    if (system && layout !== wanted) {
      await system.stop().catch(() => undefined);
      system = null;
    }
    if (!system) {
      layout = wanted;
      system = create(options.env, {
        workspace: { ownerId: options.ownerId ?? 'evals' },
        autoWorkers: true,
        log: options.log,
        recoveryScopeRules: STRATEGY_RULES as unknown as Record<
          string,
          RecoveryScopeRule
        >,
        teamLayout: () => wanted,
      });
    }
    if (system.state() !== 'running') {
      await system.start();
      if (system.state() !== 'running') {
        const health = await system.health();
        throw new HostBlockedError(
          health.missingEnv ?? [],
          `BLOCKED: NemoDots did not start (${system.state()})`,
        );
      }
    }
    if (!system.coordinator)
      throw new HostBlockedError(
        [],
        'BLOCKED: NemoDots has no coordinator (unconfigured)',
      );
    return system;
  }

  return {
    async createAndStart(spec, goal) {
      const nemodots = await running(spec.layout);
      const coordinator = nemodots.coordinator!;
      const mission = await coordinator.control.create(
        { goal },
        { recoveryScopeRule: spec.strategy },
      );
      await coordinator.control.start(mission.id);
      return { missionId: mission.id };
    },
    async cancel(missionId) {
      await system?.coordinator?.control
        .cancel(missionId as MissionId)
        .catch(() => undefined);
    },
    async close() {
      await system?.stop().catch(() => undefined);
      system = null;
    },
  };
}
