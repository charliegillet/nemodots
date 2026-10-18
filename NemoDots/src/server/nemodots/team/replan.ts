// Evidence-triggered replanning (W4.1): the planner is invoked again with fresh
// readings, the summary of what changed and the current task list, and may
// cancel tasks that no longer fit. The model decides; this module validates.
import { z } from 'zod';
import {
  PlanShapeSchema,
  TaskIdSchema,
  type TaskId,
} from '../contracts/index.js';
import type { HandlerHelpers, HandlerOutcome } from '../coordinator/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import { jsonSchemaOf, parsePlanText, runPlanning } from './planner.js';
import type { TeamDeps } from './types.js';

export const ReplanShapeSchema = z
  .object({
    tasks: PlanShapeSchema.shape.tasks,
    cancelTaskIds: z.array(TaskIdSchema).max(24),
  })
  .strict();

export const REPLAN_RESPONSE_FORMAT = Object.freeze({
  name: 'incident_replan',
  schema: jsonSchemaOf(ReplanShapeSchema),
});

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export async function runReplan(
  deps: TeamDeps,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
): Promise<HandlerOutcome> {
  const { context, attempt } = claimed;
  const tasks = await deps.reads.missionTasks(context);
  const cancellable = new Set<string>(
    tasks
      .filter((task) => task.role !== 'planner' && !TERMINAL.has(task.status))
      .map((task) => task.id),
  );
  const invalidations = attempt.repairOf
    ? await deps.reads.invalidationSummaries(
        context,
        attempt.repairOf.invalidationEventId,
      )
    : [];
  const listing = tasks
    .map((task) => `- ${task.id} [${task.role}] ${task.status}: ${task.title}`)
    .join('\n');
  return runPlanning(deps, claimed, helpers, {
    kind: 'replan',
    task: {
      title: 'Replan the incident response',
      question: [
        'Evidence changed since the earlier plan (see the invalidation summary). Using fresh readings, produce the tasks that should run now as strict JSON {tasks, cancelTaskIds}.',
        'cancelTaskIds lists ids of existing unfinished tasks that no longer fit; list none to keep them. Existing tasks:',
        listing === '' ? '(none)' : listing,
      ].join('\n'),
    },
    invalidations,
    responseFormat: REPLAN_RESPONSE_FORMAT,
    parse: (text) =>
      parsePlanText(text, (raw) => {
        const ids = (raw as { cancelTaskIds?: unknown })?.cancelTaskIds;
        const parsed = z
          .array(TaskIdSchema)
          .max(24)
          .safeParse(ids ?? []);
        if (!parsed.success)
          return {
            cancelTaskIds: [],
            issues: ['cancelTaskIds must be task ids'],
          };
        const unknown = parsed.data.filter((id) => !cancellable.has(id));
        return {
          cancelTaskIds: parsed.data.filter((id) =>
            cancellable.has(id),
          ) as TaskId[],
          issues: unknown.length
            ? [
                `cancelTaskIds names tasks that cannot be cancelled: ${unknown.join(', ')}`,
              ]
            : [],
        };
      }),
  });
}
