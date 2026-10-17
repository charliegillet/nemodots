import type { MissionEvent } from '../../../server/nemodots/contracts/index.js';
import { formatTimestamp, humanize, plural, shortId } from '../format';
import { Panel, type PanelState } from './Panel';
import { UntrustedText } from './UntrustedText';

export type TimelineStep =
  'evidence' | 'decision' | 'repair' | 'invalidation' | 'recovery' | 'resolved';

export interface TimelineEntry {
  eventId: number;
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
  return entries.sort((a, b) => a.eventId - b.eventId);
}

export function RecoveryTimeline({
  events,
  loading,
  error,
}: PanelState & { events: readonly MissionEvent[] }) {
  const entries = buildTimelineEntries(events);
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
            key={entry.eventId}
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
                event {entry.eventId} ·{' '}
                <time dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
