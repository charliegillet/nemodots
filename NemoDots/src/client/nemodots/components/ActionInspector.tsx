import type {
  ActionNode,
  CheckedVectorRow,
  DecisionNode,
} from '../mission-events';
import {
  formatAge,
  formatCount,
  formatTimestamp,
  humanize,
  shortId,
} from '../format';
import { Panel, type PanelState } from './Panel';
import { StatusPill } from './StatusPill';
import { UntrustedText } from './UntrustedText';

const STAGES = ['admission', 'commit', 'dispatch'] as const;

function CheckedVector({
  rows,
  nowMs,
}: {
  rows: readonly CheckedVectorRow[];
  nowMs?: number;
}) {
  if (rows.length === 0)
    return <p className="nd-empty">No sources were checked at this stage.</p>;
  return (
    <div className="nd-table-wrap">
      <table className="nd-table" aria-label="Checked dependency vector">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Recorded</th>
            <th scope="col">Live</th>
            <th scope="col">Receipt</th>
            <th scope="col">Last confirmed</th>
            <th scope="col">Freshness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceKey}>
              <th scope="row">
                <code>{row.sourceKey}</code>
              </th>
              <td>rev {row.recordedRevision}</td>
              <td>
                rev {row.liveRevision}
                {row.liveRevision !== row.recordedRevision && (
                  <span className="nd-flag"> (changed)</span>
                )}
              </td>
              <td>
                <StatusPill status={row.receiptStatus} />
              </td>
              <td>
                <time dateTime={row.lastConfirmedAt}>
                  {formatTimestamp(row.lastConfirmedAt)}
                  {nowMs !== undefined &&
                    ` (${formatAge(row.lastConfirmedAt, nowMs)})`}
                </time>
              </td>
              <td>
                <StatusPill
                  status={row.freshnessOk ? 'fresh' : 'stale'}
                  label={row.freshnessOk ? 'Fresh' : 'Stale'}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Decision({
  decision,
  nowMs,
}: {
  decision: DecisionNode;
  nowMs?: number;
}) {
  const versionMatches =
    decision.targetVersion.expected === decision.targetVersion.live;
  return (
    <section
      className="nd-stage"
      aria-label={`${humanize(decision.stage)} stage`}
    >
      <h4>
        {humanize(decision.stage)} stage{' '}
        <StatusPill status={decision.decision} />
      </h4>
      {decision.blockReason && (
        <p className="nd-block">
          <strong>Block reason:</strong> {humanize(decision.blockReason)}{' '}
          <code>{decision.blockReason}</code>
        </p>
      )}
      {decision.blockDetail && <UntrustedText text={decision.blockDetail} />}
      <p>
        Target version: expected {decision.targetVersion.expected}, live{' '}
        {decision.targetVersion.live}
        {versionMatches ? ' (match)' : ' (mismatch)'}
      </p>
      {decision.dispatchFence && (
        <p>
          Dispatch fence: token {decision.dispatchFence.token},{' '}
          <strong>{decision.dispatchFence.valid ? 'valid' : 'invalid'}</strong>
        </p>
      )}
      <CheckedVector rows={decision.checkedVector} nowMs={nowMs} />
    </section>
  );
}

export function ActionInspector({
  action,
  nowMs,
  loading,
  error,
}: PanelState & {
  action: ActionNode | null;
  nowMs?: number;
}) {
  return (
    <Panel
      title="Action inspector"
      className="nd-action"
      loading={loading}
      error={error}
      empty={action === null}
      emptyText="No action selected. Actions appear here once a specialist proposes one."
    >
      {action && (
        <div>
          <p className="nd-action-head">
            <strong>{humanize(action.action)}</strong>{' '}
            <code>{shortId(action.id)}</code>{' '}
            <StatusPill status={action.status} />
          </p>
          <dl className="nd-dl">
            <dt>Target source</dt>
            <dd>
              <code>{action.targetSourceKey ?? 'unknown'}</code>
            </dd>
            <dt>Expected target version</dt>
            <dd>{action.expectedTargetVersion ?? 'unknown'}</dd>
            {action.configValue !== null && (
              <>
                <dt>Proposed value</dt>
                <dd>
                  <code>{String(action.configValue)}</code>
                </dd>
              </>
            )}
            <dt>Payload hash</dt>
            <dd>
              <code>{shortId(action.payloadHash, 12)}</code>
            </dd>
            <dt>Required sources</dt>
            <dd>
              {action.requiredSources.length
                ? action.requiredSources.join(', ')
                : 'none'}
            </dd>
            <dt>Admission not before</dt>
            <dd>{formatTimestamp(action.admissionNotBefore)}</dd>
          </dl>
          {STAGES.map((stage) => {
            const decision = action.decisions[stage];
            return decision ? (
              <Decision key={stage} decision={decision} nowMs={nowMs} />
            ) : (
              <p key={stage} className="nd-stage-empty">
                {humanize(stage)} stage: not decided yet
              </p>
            );
          })}
          {action.committed && (
            <p>
              Committed: target version {action.committed.targetVersionBefore}{' '}
              to {action.committed.targetVersionAfter ?? 'unknown'}
            </p>
          )}
          {action.dispatched && (
            <p>
              Script result:{' '}
              <strong>
                {action.dispatched.scriptResult
                  ? humanize(action.dispatched.scriptResult)
                  : 'not reported'}
              </strong>
              {action.dispatched.deletedCount !== null &&
                `, ${formatCount(action.dispatched.deletedCount)} keys deleted`}
            </p>
          )}
          {action.verified && (
            <p>
              Verified by {action.verified.kind} postcondition
              {action.verified.configVersion !== null &&
                ` at config version ${action.verified.configVersion}`}
            </p>
          )}
          {action.failure && (
            <p className="nd-block">
              <strong>Failed:</strong> {humanize(action.failure.reason)}
            </p>
          )}
          {action.failure?.detail && (
            <UntrustedText text={action.failure.detail} />
          )}
          {action.status === 'outcome_unknown' && (
            <div className="nd-block">
              <p>
                <strong>Outcome unknown:</strong> the effect may or may not have
                been applied.
              </p>
              {action.unknownDetail && (
                <UntrustedText text={action.unknownDetail} />
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

export function ActionList({
  actions,
  selectedActionId,
  onSelectAction,
  loading,
  error,
}: PanelState & {
  actions: readonly ActionNode[];
  selectedActionId?: string | null;
  onSelectAction?: (actionId: string) => void;
}) {
  return (
    <Panel
      title="Actions"
      className="nd-action-list"
      loading={loading}
      error={error}
      empty={actions.length === 0}
      emptyText="No actions proposed yet."
    >
      <ul aria-label="Proposed actions">
        {actions.map((action) => {
          const body = (
            <>
              <span>{humanize(action.action)}</span>
              <code>{action.targetSourceKey ?? shortId(action.id)}</code>
              <StatusPill status={action.status} />
            </>
          );
          return (
            <li key={action.id}>
              {onSelectAction ? (
                <button
                  type="button"
                  className="nd-task-row"
                  aria-current={
                    selectedActionId === action.id ? 'true' : undefined
                  }
                  onClick={() => onSelectAction(action.id)}
                >
                  {body}
                </button>
              ) : (
                <div className="nd-task-row">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
