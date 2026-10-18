// selective: the ledger closure. Only tasks whose outputs or attempts rest on
// the changed receipt (evidence and inheritance edges) restart; scheduling
// edges do not widen the scope.
import type { NamedRule } from './types.js';
import { inTaskOrder } from './types.js';

export const selective: NamedRule = {
  name: 'selective',
  select({ closureTaskIds, tasks }) {
    return { restartTaskIds: inTaskOrder(new Set(closureTaskIds), tasks) };
  },
};
