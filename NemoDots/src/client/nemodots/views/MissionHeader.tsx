import type {
  HealthStatus,
  Mission,
  MissionLifecycleAction,
  MissionStatus,
} from '../../../server/nemodots/contracts/index.js';
import { IntelligenceBadge, ModeBadge } from '../components/ModeBadge';
import { StatusPill } from '../components/StatusPill';
import { formatCount } from '../format';
import type { StreamStatus } from '../mission-stream';
import {
  deriveIntelligenceBadge,
  deriveModeBadge,
  type ModeBadgeView,
} from '../status';

const LIFECYCLE: {
  action: MissionLifecycleAction;
  label: string;
  from: readonly MissionStatus[];
  hint: string;
}[] = [
  {
    action: 'start',
    label: 'Start',
    from: ['created', 'blocked_provider'],
    hint: 'Start applies to a mission that has not started.',
  },
  {
    action: 'pause',
    label: 'Pause',
    from: ['running'],
    hint: 'Pause applies to a running mission.',
  },
  {
    action: 'resume',
    label: 'Resume',
    from: ['paused'],
    hint: 'Resume applies to a paused mission.',
  },
  {
    action: 'cancel',
    label: 'Cancel',
    from: [
      'created',
      'blocked_provider',
      'running',
      'paused',
      'awaiting_acceptance',
    ],
    hint: 'Cancel applies to a mission that has not finished.',
  },
];

/** Why a lifecycle control is unavailable, or null when it can be used. */
export function lifecycleDisabledReason(
  action: MissionLifecycleAction,
  mission: Mission | null,
  health: HealthStatus | null,
): string | null {
  const entry = LIFECYCLE.find((item) => item.action === action);
  if (!entry || !mission) return 'The mission has not loaded.';
  if (!entry.from.includes(mission.status))
    return `${entry.hint} This mission is ${mission.status.replace(/_/g, ' ')}.`;
  if (
    action === 'start' &&
    mission.mode === 'live' &&
    health !== null &&
    health.mode !== 'live'
  )
    return health.mode === 'blocked'
      ? `Live mode is blocked${
          health.missingEnv.length
            ? `: missing ${health.missingEnv.join(', ')}`
            : ''
        }.`
      : 'The server is in fixture mode, so a live mission cannot start.';
  return null;
}

/**
 * The badge for one mission, driven by mission.mode: where its model calls came
 * from. The server's current mode is separate context (serverModeNote).
 */
export function missionModeBadge(
  mission: Mission | null,
  health: HealthStatus | null,
): ModeBadgeView {
  if (mission?.mode === 'fixture')
    return {
      kind: 'fixture',
      label: 'Fixture',
      description:
        'Fixture mode: model responses are scripted fixtures, not a live model.',
      missingEnv: [],
    };
  if (mission?.mode === 'live')
    return {
      kind: 'live',
      label: 'Live',
      description: `Live mission: Nemotron reasoning on ${mission.provider.plannerModel} via ${mission.provider.host}.`,
      missingEnv: [],
    };
  return deriveModeBadge(health);
}

/** Context line when the server's current mode differs from a live mission's. */
export function serverModeNote(
  mission: Mission | null,
  health: HealthStatus | null,
): string | null {
  if (mission?.mode !== 'live' || !health || health.mode === 'live')
    return null;
  return health.mode === 'fixture'
    ? 'The server is now in fixture mode; this live mission cannot start or continue until live mode returns.'
    : `The server is now blocked${
        health.missingEnv.length
          ? `: missing ${health.missingEnv.join(', ')}`
          : ''
      }; this live mission cannot start or continue until live mode returns.`;
}

const STREAM_TEXT: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  open: 'Open',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
};

export function StreamStatusLine({
  status,
  detail,
}: {
  status: StreamStatus;
  detail?: string | null;
}) {
  return (
    <p
      className={`nd-stream nd-stream-${status}`}
      role="status"
      data-stream={status}
    >
      Live updates: {STREAM_TEXT[status]}
      {status !== 'open' && ' (refreshing from storage every 3 seconds)'}
      {detail ? `. ${detail}` : ''}
    </p>
  );
}

export function MissionHeader({
  mission,
  health,
  stream,
  streamDetail,
  busyAction,
  actionError,
  onAction,
}: {
  mission: Mission | null;
  health: HealthStatus | null;
  stream: StreamStatus;
  streamDetail?: string | null;
  busyAction: MissionLifecycleAction | null;
  actionError: string | null;
  onAction: (action: MissionLifecycleAction) => void;
}) {
  const badge = missionModeBadge(mission, health);
  const serverNote = serverModeNote(mission, health);
  return (
    <header className="nd-mission-head" aria-label="Mission summary">
      <div className="page-heading nd-heading">
        <div>
          <span className="eyebrow">MISSION</span>
          <h1>{mission ? mission.goal : 'Loading mission…'}</h1>
          {mission && mission.constraints.length > 0 && (
            <ul className="nd-constraints" aria-label="Constraints">
              {mission.constraints.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        <div
          className="task-controls nd-lifecycle"
          role="group"
          aria-label="Mission controls"
        >
          {LIFECYCLE.map(({ action, label }) => {
            const reason = lifecycleDisabledReason(action, mission, health);
            return (
              <button
                key={action}
                type="button"
                className={action === 'start' ? 'primary' : undefined}
                disabled={reason !== null || busyAction !== null}
                title={reason ?? `${label} the mission`}
                onClick={() => onAction(action)}
              >
                {busyAction === action ? `${label}…` : label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="nd-badges">
        <ModeBadge badge={badge} />
        {mission && <StatusPill status={mission.status} />}
        {mission && (
          <span className="nd-provider-chip">
            {mission.provider.plannerModel.replace(/^nvidia\//, '')} ·{' '}
            {mission.provider.host}
          </span>
        )}
      </p>
      {serverNote && (
        <p className="nd-note nd-server-mode-note">{serverNote}</p>
      )}
      {mission?.mode === 'fixture' && (
        <p className="nd-note nd-fixture-note">
          FIXTURE mission: model responses are scripted fixtures, not a live
          model.
        </p>
      )}
      {mission?.failureReason && (
        <p className="nd-note">{mission.failureReason}</p>
      )}
      {mission && (
        <details className="nd-fold nd-fold-inline">
          <summary>
            <span>Mission details</span>
          </summary>
        <dl className="nd-dl nd-mission-facts" aria-label="Mission facts">
          <dt>Provider host</dt>
          <dd>{mission.provider.host}</dd>
          <dt>Planner model</dt>
          <dd>{mission.provider.plannerModel}</dd>
          <dt>Worker model</dt>
          <dd>{mission.provider.workerModel}</dd>
          <dt>admission.minAgeMs</dt>
          <dd>{formatCount(mission.admission.minAgeMs)} ms</dd>
        </dl>
        </details>
      )}
      {actionError && (
        <p className="nd-error" role="alert">
          {actionError}
        </p>
      )}
      {stream === 'reconnecting' && (
        <StreamStatusLine status={stream} detail={streamDetail} />
      )}
    </header>
  );
}
