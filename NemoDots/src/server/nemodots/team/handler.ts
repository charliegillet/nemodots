// The AttemptHandler the worker host runs (W4.1). Roles are routed here and
// nowhere else: the planner plans or replans, every other role runs the
// worker loop. The handler holds no state between attempts.
import type { AttemptHandler } from '../coordinator/index.js';
import { runPlanner } from './planner.js';
import { runReplan } from './replan.js';
import type { TeamDeps } from './types.js';
import { runWorker } from './worker-loop.js';

export function createTeamHandler(deps: TeamDeps): AttemptHandler {
  return (claimed, helpers) => {
    if (claimed.context.role === 'planner')
      return claimed.attempt.kind === 'replan'
        ? runReplan(deps, claimed, helpers)
        : runPlanner(deps, claimed, helpers);
    return runWorker(deps, claimed, helpers);
  };
}
