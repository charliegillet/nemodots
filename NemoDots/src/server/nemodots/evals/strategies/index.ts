import type { StrategyName } from '../types.js';
import { STRATEGIES } from '../types.js';
import { broadRestart } from './broad-restart.js';
import { dagRestart } from './dag-restart.js';
import { selective } from './selective.js';
import type { NamedRule } from './types.js';

export { broadRestart, dagRestart, selective };
export type { NamedRule };
export {
  LIVE_TASK_STATUSES,
  inTaskOrder,
  schedulingDescendants,
} from './types.js';

export const STRATEGY_RULES: Readonly<Record<StrategyName, NamedRule>> =
  Object.freeze({
    'broad-restart': broadRestart,
    'dag-restart': dagRestart,
    selective,
  });

export const STRATEGY_DESCRIPTIONS: Readonly<Record<StrategyName, string>> =
  Object.freeze({
    'broad-restart':
      'restart every non-planner task that is not failed or cancelled, including succeeded ones',
    'dag-restart':
      'restart the direct readers of the changed source and everything scheduled after them (children and dependents)',
    selective:
      'restart only tasks in the evidence/inheritance closure of the changed receipt',
  });

export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGIES as readonly string[]).includes(value);
}

export function ruleFor(name: StrategyName): NamedRule {
  if (!Object.hasOwn(STRATEGY_RULES, name))
    throw new RangeError(`unknown strategy ${String(name)}`);
  return STRATEGY_RULES[name];
}
