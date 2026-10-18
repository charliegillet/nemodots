import type { MissionEvent } from '../../../server/nemodots/contracts/index.js';
import type { InvalidationNode, RecoveryNode } from '../mission-events';
import { formatTimestamp, humanize, plural, shortId } from '../format';
import { Panel, type PanelState } from './Panel';
import { UntrustedText } from './UntrustedText';

export type TimelineStep =
  'evidence' | 'decision' | 'repair' | 'invalidation' | 'recovery' | 'resolved';

export interface TimelineEntry {
  /** null for an entry rebuilt from a snapshot node (no durable event retained) */
  eventId: number | null;
  at: string;
  step: TimelineStep;
  stepLabel: string;
  title: string;
  detail: string | null;
  /** free text from the server; rendered as untrusted */
  note: string | null;
  invalidationEventId: string | null;
}

const STEP_LABEL: Record<TimelineStep, string> = {
  evidence: 'Evidence',
  decision: 'Decision',
  repair: 'Repair',
  invalidation: 'Invalidation',
  recovery: 'Recovery',
  resolved: 'Resolved',
};

const SELF_WRITE: Record<string, string> = {
  none: 'external change',
  verified: 'own write, verified',
  mismatch: 'own write, mismatch',
};

/** The causal sequence of a changed-evidence recovery, ascending by event id. */
export function buildTimelineEntries(
  events: readonly MissionEvent[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    const p = event.payload;
    const base = { eventId: event.id, at: event.at, note: null };
    switch (p.kind) {
      case 'receipt.registered':
        entries.push({
          ...base,
          step: 'evidence',
          stepLabel: STEP_LABEL.evidence,
          title: `Evidence registered: ${p.sourceKey} revision ${p.sourceRevision}`,
          detail: `${SELF_WRITE[p.selfWrite] ?? p.selfWrite}; ${
            p.supersedes
              ? `supersedes receipt ${shortId(p.supersedes)}`
              : 'first receipt in its chain'
          }; trust ${humanize(p.trust).toLowerCase()}`,
          invalidationEventId: null,
        });
        break;
      case 'invalidation.recorded':
        entries.push({
          ...base,
          step: 'invalidation',
          stepLabel: STEP_LABEL.invalidation,
          title: `Invalidation recorded: ${humanize(p.reason).toLowerCase()} on ${p.sourceKey}`,
          detail: `Affects ${plural(p.affected.taskIds.length, 'task')}, ${plural(
            p.affected.attemptIds.length,
            'attempt',
          )}, ${plural(p.affected.actionIds.length, 'action')}; preserves ${plural(
            p.preserved.taskIds.length,
            'task',
          )}; closure depth ${p.closure.depth}, ${plural(p.closure.nodes, 'node')}${
            p.closure.capped ? ' (capped)' : ''
          }`,
          invalidationEventId: p.invalidationEventId,
        });
        break;
      case 'action.decided':
        entries.push({
          ...base,
          step: 'decision',
          stepLabel: STEP_LABEL.decision,
          title: `Action ${shortId(p.actionId)}: ${p.stage} ${
            p.decision === 'blocked' ? 'blocked' : p.decision
          }`,
          detail: p.blockReason
            ? `Block reason: ${humanize(p.blockReason).toLowerCase()}`
            : null,
          note: p.blockDetail,
          invalidationEventId: null,
        });
        break;
      case 'attempt.started':
        if (p.repairOf)
          entries.push({
            ...base,
            step: 'repair',
            stepLabel: STEP_LABEL.repair,
            title: `Repair attempt ${p.n} started`,
            detail: `Repairs attempt ${shortId(p.repairOf.attemptId)} after invalidation ${shortId(
              p.repairOf.invalidationEventId,
            )}; inherits ${plural(p.inheritedVectorSize, 'dependency', 'dependencies')}`,
            invalidationEventId: p.repairOf.invalidationEventId,
          });
        break;
      case 'recovery.recorded':
        entries.push({
          ...base,
          step: 'recovery',
          stepLabel: STEP_LABEL.recovery,
          title: `Recovery: ${humanize(p.recovery.kind).toLowerCase()}`,
          detail: null,
          note: p.recovery.detail || null,
          invalidationEventId: p.recovery.invalidationEventId,
        });
        break;
      case 'invalidation.resolved':
        entries.push({
          ...base,
          step: 'resolved',
          stepLabel: STEP_LABEL.resolved,
          title: `Invalidation ${shortId(p.invalidationEventId)} resolved`,
          detail: `Resolved at ${formatTimestamp(p.resolvedAt)}`,
          invalidationEventId: p.invalidationEventId,
        });
        break;
      default:
        break;
    }
  }
  return entries.sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0));
}

const STEP_ORDER: Record<TimelineStep, number> = {
  evidence: 0,
  invalidation: 1,
  decision: 2,
  recovery: 3,
  repair: 4,
  resolved: 5,
};

/**
 * Entries for invalidations and recoveries that a merged snapshot holds but the
 * retained event list does not cover (the page was loaded after they happened).
 * Limit: a snapshot does not carry the evidence-registered, decision or repair
 * attempt.started events, nor per-attempt start times, so only the invalidation,
 * recovery and resolution steps can be rebuilt; the repair attempt is named in
 * the recovery entry's detail.
 */
export function buildSnapshotFallbackEntries(
  events: readonly MissionEvent[],
  invalidations: readonly InvalidationNode[],
  recoveries: readonly RecoveryNode[],
): TimelineEntry[] {
  const recordedIds = new Set<string>();
  const resolvedIds = new Set<string>();
  const recoveryIds = new Set<string>();
  for (const event of events) {
    const p = event.payload;
    if (p.kind === 'invalidation.recorded')
      recordedIds.add(p.invalidationEventId);
    else if (p.kind === 'invalidation.resolved')
      resolvedIds.add(p.invalidationEventId);
    else if (p.kind === 'recovery.recorded') recoveryIds.add(p.recovery.id);
  }
  const entries: TimelineEntry[] = [];
  for (const node of invalidations) {
    if (!node.known) continue;
    if (!recordedIds.has(node.id) && node.createdAt)
      entries.push({
        eventId: null,
        at: node.createdAt,
        step: 'invalidation',
        stepLabel: STEP_LABEL.invalidation,
        title: `Invalidation recorded: ${humanize(node.reason ?? 'unknown').toLowerCase()} on ${node.sourceKey}`,
        detail: `Affects ${plural(node.affected.taskIds.length, 'task')}, ${plural(
          node.affected.attemptIds.length,
          'attempt',
        )}, ${plural(node.affected.actionIds.length, 'action')}; preserves ${plural(
          node.preservedTaskIds.length,
          'task',
        )}${
          node.closure
            ? `; closure depth ${node.closure.depth}, ${plural(node.closure.nodes, 'node')}${
                node.closure.capped ? ' (capped)' : ''
              }`
            : ''
        } (from snapshot)`,
        note: null,
        invalidationEventId: node.id,
      });
    if (node.resolvedAt && !resolvedIds.has(node.id))
      entries.push({
        eventId: null,
        at: node.resolvedAt,
        step: 'resolved',
        stepLabel: STEP_LABEL.resolved,
        title: `Invalidation ${shortId(node.id)} resolved`,
        detail: `Resolved at ${formatTimestamp(node.resolvedAt)} (from snapshot)`,
        note: null,
        invalidationEventId: node.id,
      });
  }
  for (const node of recoveries) {
    if (recoveryIds.has(node.id)) continue;
    entries.push({
      eventId: null,
      at: node.createdAt,
      step: 'recovery',
      stepLabel: STEP_LABEL.recovery,
      title: `Recovery: ${humanize(node.kind).toLowerCase()}`,
      detail: `${
        node.newAttemptId
          ? `Repair attempt ${shortId(node.newAttemptId)} scheduled; `
          : ''
      }from snapshot`,
      note: node.detail || null,
      invalidationEventId: node.invalidationEventId,
    });
  }
  return entries;
}

/** Event entries plus snapshot fallback entries, merged chronologically. */
export function buildTimeline(
  events: readonly MissionEvent[],
  invalidations: readonly InvalidationNode[] = [],
  recoveries: readonly RecoveryNode[] = [],
): TimelineEntry[] {
  const fromEvents = buildTimelineEntries(events);
  const fallback = buildSnapshotFallbackEntries(
    events,
    invalidations,
    recoveries,
  );
  if (fallback.length === 0) return fromEvents;
  const time = (entry: TimelineEntry) => {
    const t = Date.parse(entry.at);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...fromEvents, ...fallback].sort(
    (a, b) =>
      time(a) - time(b) ||
      (a.eventId ?? 0) - (b.eventId ?? 0) ||
      STEP_ORDER[a.step] - STEP_ORDER[b.step],
  );
}

export function RecoveryTimeline({
  events,
  invalidations,
  recoveries,
  loading,
  error,
}: PanelState & {
  events: readonly MissionEvent[];
  /** MissionState.invalidations/recoveries: fallback after a snapshot merge */
  invalidations?: readonly InvalidationNode[];
  recoveries?: readonly RecoveryNode[];
}) {
  const entries = buildTimeline(events, invalidations, recoveries);
  return (
    <Panel
      title="Recovery timeline"
      className="nd-timeline"
      loading={loading}
      error={error}
      empty={entries.length === 0}
      emptyText="No evidence changes or recoveries yet."
    >
      <ol className="nd-timeline-list" aria-label="Recovery events in order">
        {entries.map((entry) => (
          <li
            key={
              entry.eventId ??
              `${entry.step}-${entry.invalidationEventId}-${entry.at}`
            }
            className={`nd-timeline-item nd-step-${entry.step}`}
          >
            <span className="nd-step">{entry.stepLabel}</span>
            <div>
              <p className="nd-timeline-title">{entry.title}</p>
              {entry.detail && (
                <p className="nd-timeline-detail">{entry.detail}</p>
              )}
              {entry.note && <UntrustedText text={entry.note} />}
              <p className="nd-id">
                {entry.eventId === null ? 'snapshot' : `event ${entry.eventId}`}{' '}
                · <time dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
