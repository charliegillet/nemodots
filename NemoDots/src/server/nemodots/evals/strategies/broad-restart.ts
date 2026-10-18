// broad-restart: a strong baseline that reruns all affected work broadly on any
// change. Every non-planner task that is not failed or cancelled restarts
// (non-terminal and succeeded alike), so preserved work is zero by design.
import type { NamedRule } from './types.js';
import { LIVE_TASK_STATUSES } from './types.js';

export const broadRestart: NamedRule = {
  name: 'broad-restart',
  select({ tasks }) {
    return {
      restartTaskIds: tasks
        .filter(
          (task) =>
            task.role !== 'planner' && LIVE_TASK_STATUSES.has(task.status),
        )
        .map((task) => task.id),
    };
  },
};
