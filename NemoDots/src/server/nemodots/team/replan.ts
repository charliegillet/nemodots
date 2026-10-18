import type {
  DependencyEntry,
  InvalidationEvent,
  MissionId,
  SourceKey,
} from '../contracts/index.js';
import type { InvalidationInput } from '../context/compile.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import { ToolError } from './errors.js';
import type {
  ObservationPort,
  ObservedReceipt,
  PlanOverviewTask,
  TeamCoordinator,
  TeamReader,
} from './types.js';

// Evidence-triggered recovery contexts (ARCHITECTURE.md section 11). A repair
// or replan attempt never replays the old transcript. It receives (a) a short
// summary of the InvalidationEvent that made the earlier work obsolete, with
// ids and counts only and no values, and (b) fresh, scoped reads of the
// sources the earlier attempt rested on, taken now and recorded as ordinary
// observations of this attempt.

/** Upper bound on the sources re-read for a repair. */
export const MAX_FRESH_READS = 8;

const OBSERVABLE = /^(?:checkout\.|redis\.stats$)/;

export function invalidationSummary(event: InvalidationEvent): string {
  const { affected } = event;
  return [
    `Evidence source ${event.sourceKey} changed (${event.reason}; self-write: ${event.selfWrite}).`,
    `Receipt ${event.oldReceiptId} was superseded${event.newReceiptId ? ` by receipt ${event.newReceiptId}` : ' and has no replacement'}.`,
    `In this mission ${affected.attemptIds.length} attempt(s), ${affected.outputIds.length} output(s), ${affected.actionIds.length} action(s) and ${affected.taskIds.length} task(s) rested on it.`,
    event.perMission[0]?.preserved.taskIds.length
      ? `${event.perMission[0].preserved.taskIds.length} independent task(s) were left untouched.`
      : 'No independent task needed to be preserved.',
    'Your earlier conversation is not available. The observations in your evidence were taken after the change; trust them over anything remembered.',
  ].join('\n');
}

export interface RepairContext {
  invalidations: InvalidationInput[];
  fresh: ObservedReceipt[];
}

export interface RepairDeps {
  reader: Pick<TeamReader, 'invalidation' | 'readSetOf'>;
  observer: ObservationPort;
  coordinator: Pick<TeamCoordinator, 'addReadSet'>;
}

export async function prepareRepairContext(
  claimed: ClaimedAttempt,
  deps: RepairDeps,
): Promise<RepairContext> {
  const repairOf = claimed.attempt.repairOf;
  if (!repairOf) return { invalidations: [], fresh: [] };
  const { context } = claimed;
  const missionId = context.missionId as MissionId;

  const event = await deps.reader.invalidation(
    repairOf.invalidationEventId,
    missionId,
  );
  const previous = await deps.reader.readSetOf(repairOf.attemptId, missionId);

  const keys: SourceKey[] = [];
  const add = (key: string | undefined) => {
    if (key && OBSERVABLE.test(key) && !keys.includes(key as SourceKey))
      keys.push(key as SourceKey);
  };
  add(event?.sourceKey);
  for (const entry of previous ?? []) add(entry.sourceKey);

  const fresh: ObservedReceipt[] = [];
  for (const sourceKey of keys.slice(0, MAX_FRESH_READS)) {
    try {
      fresh.push(
        await deps.observer.observe({
          context,
          sourceKey,
          toolCallId: `repair-read:${context.attemptId}:${sourceKey}`,
          modelCallId: null,
        }),
      );
    } catch (error) {
      // A source that cannot be read right now is simply absent from the fresh
      // evidence; the worker can still try observe_source itself.
      if (!(error instanceof ToolError)) throw error;
    }
  }
  if (fresh.length > 0) {
    const entries: DependencyEntry[] = fresh.map((receipt) => ({
      sourceKey: receipt.sourceKey,
      sourceRevision: receipt.sourceRevision,
      receiptId: receipt.receiptId,
    }));
    await deps.coordinator.addReadSet(context, entries);
  }
  return {
    invalidations: event
      ? [{ id: event.id, summary: invalidationSummary(event) }]
      : [],
    fresh,
  };
}

/** Plain-text overview of the mission's tasks for a replan (titles, roles, states; no evidence values). */
export function planOverviewText(tasks: readonly PlanOverviewTask[]): string {
  if (tasks.length === 0) return 'No tasks exist yet.';
  return tasks
    .map((task) => {
      const output =
        task.outputUsable === null
          ? 'no output'
          : task.outputUsable
            ? 'usable output'
            : 'output no longer usable';
      return `${'  '.repeat(task.depth)}- [${task.status}] ${task.role}: ${task.title} (${output}, ${task.attemptCount} attempt(s))`;
    })
    .join('\n');
}
