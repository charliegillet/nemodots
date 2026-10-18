import type { ActionAdmissionPort } from '../contracts/index.js';
import type { Coordinator } from '../coordinator/index.js';
import type { AttemptHandler, WorkerHost } from '../coordinator/worker-host.js';
import { teamBudgetIssues } from './budget.js';
import { createRunbookLibrary } from './catalogue.js';
import { runPlanner } from './planner.js';
import { createTeamTools, type TeamTools } from './tools.js';
import type {
  ObservationPort,
  RunbookLibrary,
  TeamCoordinator,
  TeamInference,
  TeamReader,
} from './types.js';
import { runWorker } from './worker-loop.js';

// The attempt handler the worker host runs (coordinator/worker-host.ts):
// planner attempts (initial and replan) go to the planner, every other role
// to the tool loop. All inference goes through the injected InferencePort;
// there is no fallback provider.

export interface TeamHandlerDeps {
  inference: TeamInference;
  coordinator: TeamCoordinator;
  reader: TeamReader;
  observer: ObservationPort;
  tools: TeamTools;
  runbooks?: RunbookLibrary;
  clock?: () => Date;
  /** Models used when the mission row names none. */
  models: { planner: string; worker: string };
  onError?: (error: unknown) => void;
}

export function createTeamHandler(deps: TeamHandlerDeps): AttemptHandler {
  const runbooks = deps.runbooks ?? createRunbookLibrary();
  const clock = deps.clock ?? (() => new Date());
  return async (claimed, helpers) => {
    if (claimed.context.role === 'planner')
      return runPlanner(claimed, helpers, {
        inference: deps.inference,
        coordinator: deps.coordinator,
        reader: deps.reader,
        observer: deps.observer,
        runbooks,
        clock,
        plannerModel: deps.models.planner,
      });
    return runWorker(claimed, helpers, {
      inference: deps.inference,
      coordinator: deps.coordinator,
      reader: deps.reader,
      observer: deps.observer,
      tools: deps.tools,
      runbooks,
      clock,
      workerModel: deps.models.worker,
      onError: deps.onError,
    });
  };
}

/**
 * A worker host over a real Coordinator running the team handler. `tools`
 * defaults to createTeamTools over the same ports.
 */
export function createTeamWorkerHost(
  coordinator: Coordinator,
  deps: Omit<TeamHandlerDeps, 'coordinator' | 'tools'> & {
    tools?: TeamTools;
    /** ActionAdmissionPort.propose, used when `tools` is not given. */
    actions?: Pick<ActionAdmissionPort, 'propose'>;
    workerId: string;
    concurrency?: number;
    /**
     * The token budgets the coordinator is configured with (taskDefaults.maxTokens
     * and the mission budget). When given, a configuration too small for the
     * team's tool loop is refused at construction, not discovered as a
     * permanent budget failure mid-incident.
     */
    configuredBudgets?: { taskMaxTokens: number; missionMaxTokens: number };
  },
): WorkerHost {
  if (deps.configuredBudgets) {
    const issues = teamBudgetIssues(deps.configuredBudgets);
    if (issues.length > 0)
      throw new Error(`team budgets are too small: ${issues.join('; ')}`);
  }
  const tools =
    deps.tools ??
    createTeamTools({
      coordinator,
      reader: deps.reader,
      observer: deps.observer,
      actions: deps.actions,
      runbooks: deps.runbooks,
      clock: deps.clock,
    });
  return coordinator.createWorkerHost({
    workerId: deps.workerId,
    concurrency: deps.concurrency,
    handler: createTeamHandler({ ...deps, coordinator, tools }),
  });
}
