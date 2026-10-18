// dag-restart: a conventional task DAG. The tasks that directly read the
// changed source restart together with everything scheduled after them
// (children and dependents, transitively), whether or not that work rests on
// the changed evidence. It does not use the ledger's evidence closure.
import type { NamedRule } from './types.js';
import { inTaskOrder, schedulingDescendants } from './types.js';

export const dagRestart: NamedRule = {
  name: 'dag-restart',
  select({ directReaderTaskIds, tasks }) {
    return {
      restartTaskIds: inTaskOrder(
        schedulingDescendants(directReaderTaskIds, tasks),
        tasks,
      ),
    };
  },
};
