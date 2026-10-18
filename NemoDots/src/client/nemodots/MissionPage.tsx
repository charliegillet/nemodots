import { useEffect, useState } from 'react';
import type {
  HealthStatus,
  MissionLifecycleAction,
} from '../../server/nemodots/contracts/index.js';
import type { Space } from '../../shared/types';
import { ActionInspector, ActionList } from './components/ActionInspector';
import { DependencyView } from './components/DependencyView';
import { EvidenceLedger } from './components/EvidenceLedger';
import { FindingList } from './components/FindingList';
import { ModeBadge } from './components/ModeBadge';
import { RecoveryTimeline } from './components/RecoveryTimeline';
import { TaskTree } from './components/TaskTree';
import { TelemetryPanel } from './components/TelemetryPanel';
import { runMissionLifecycle } from './mission-api';
import { selectDependencyEdges } from './mission-events';
import { MissionCreateForm } from './MissionCreateForm';
import { deriveModeBadge } from './status';
import {
  useMission,
  useMissionList,
  useNemoDotsHealth,
  type UseNemoDotsHealthResult,
} from './use-mission';
import { AcceptanceConsole } from './views/AcceptanceConsole';
import { DemoBar, Fold, RunDemoButton } from './views/DemoBar';
import { MissionHeader } from './views/MissionHeader';
import { MissionList } from './views/MissionList';
import { SaveEvidencePage } from './views/SaveEvidencePage';

const NOW_TICK_MS = 5000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function MissionDetail({
  missionId,
  spaces,
  healthState,
  onBack,
}: {
  missionId: string;
  spaces: readonly Pick<Space, 'id' | 'name'>[];
  healthState: UseNemoDotsHealthResult;
  onBack: () => void;
}) {
  const { state, loaded, error, missing, stream, streamDetail, refresh } =
    useMission(missionId);
  const now = useNow();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<MissionLifecycleAction | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const runLifecycle = async (action: MissionLifecycleAction) => {
    setBusyAction(action);
    setActionError(null);
    try {
      await runMissionLifecycle(missionId, action);
      await refresh();
    } catch (failure) {
      setActionError(
        failure instanceof Error && failure.message
          ? failure.message
          : `Could not ${action} the mission.`,
      );
    } finally {
      setBusyAction(null);
    }
  };

  if (missing)
    return (
      <div className="nd-mission">
        <section className="nd-panel" aria-label="Mission not available">
          <h3 className="nd-panel-title">Mission not available</h3>
          <p className="nd-error" role="alert">
            {error ?? 'This mission could not be found.'}
          </p>
          <button type="button" onClick={onBack}>
            Back to missions
          </button>
        </section>
      </div>
    );

  const pending = !loaded && !error;
  const panelError = !loaded ? error : null;
  const selectedAction =
    state.actions.find((action) => action.id === selectedActionId) ??
    state.actions[state.actions.length - 1] ??
    null;
  const findings = selectedTaskId
    ? state.findings.filter((finding) => finding.taskId === selectedTaskId)
    : state.findings;

  return (
    <div className="nd-mission">
      <button type="button" className="nd-back" onClick={onBack}>
        All missions
      </button>
      <MissionHeader
        mission={state.mission}
        health={healthState.health}
        stream={stream}
        streamDetail={streamDetail}
        busyAction={busyAction}
        actionError={actionError}
        onAction={(action) => void runLifecycle(action)}
      />
      {loaded && error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
      {state.mission &&
        ['created', 'running', 'blocked_provider'].includes(
          state.mission.status,
        ) && (
          <DemoBar mission={state.mission} onChanged={() => void refresh()} />
        )}
      <div className="nd-mission-grid">
        <TaskTree
          tasks={state.tasks}
          attempts={state.attempts}
          selectedTaskId={selectedTaskId}
          onSelectTask={(taskId) =>
            setSelectedTaskId((current) =>
              current === taskId ? null : taskId,
            )
          }
          loading={pending}
          error={panelError}
        />
        <div className="nd-col">
          <ActionList
            actions={state.actions}
            selectedActionId={selectedAction?.id ?? null}
            onSelectAction={setSelectedActionId}
            loading={pending}
            error={panelError}
          />
          <ActionInspector
            action={selectedAction}
            nowMs={now}
            loading={pending}
            error={panelError}
          />
        </div>
      </div>
      <RecoveryTimeline
        events={state.events}
        invalidations={state.invalidations}
        recoveries={state.recoveries}
        loading={pending}
        error={panelError}
      />
      <Fold
        title="Evidence ledger"
        meta={`${state.receipts.length} receipts`}
      >
        <EvidenceLedger
          receipts={state.receipts}
          nowMs={now}
          loading={pending}
          error={panelError}
        />
        {loaded && (
          <SaveEvidencePage
            missionId={missionId}
            goal={state.mission?.goal ?? ''}
            receipts={state.receipts}
            spaces={spaces}
          />
        )}
      </Fold>
      <Fold title="Findings" meta={`${findings.length}`}>
        <FindingList findings={findings} />
      </Fold>
      <Fold title="Dependencies">
        <DependencyView
          edges={selectDependencyEdges(state)}
          loading={pending}
          error={panelError}
        />
      </Fold>
      <Fold
        title="Acceptance & sandbox"
        meta={
          state.probe
            ? `probe ${state.probe.verdict ?? 'running'}`
            : undefined
        }
      >
        <AcceptanceConsole
          health={healthState.health}
          checkout={healthState.checkout}
          healthError={healthState.error}
          healthLoading={healthState.loading}
          receipts={state.receipts}
          probe={state.probe}
          acceptanceReceiptId={state.mission?.acceptanceReceiptId ?? null}
          onChanged={() => void refresh()}
        />
      </Fold>
      <Fold
        title="Telemetry"
        meta={state.telemetry ? `${state.telemetry.calls} model calls` : undefined}
      >
        <TelemetryPanel
          telemetry={state.telemetry}
          loading={pending}
          error={panelError}
        />
      </Fold>
    </div>
  );
}

function ListView({
  health,
  healthError,
  onOpen,
}: {
  health: HealthStatus | null;
  healthError: string | null;
  onOpen: (missionId: string) => void;
}) {
  const list = useMissionList();
  return (
    <div className="nd-mission">
      <div className="page-heading nd-heading">
        <div>
          <span className="eyebrow">NEMODOTS</span>
          <h1>Missions</h1>
        </div>
      </div>
      <p className="nd-badges">
        <ModeBadge badge={deriveModeBadge(health)} />
      </p>
      {healthError && (
        <p className="nd-error" role="alert">
          {healthError}
        </p>
      )}
      <RunDemoButton
        onOpen={(id) => {
          void list.reload();
          onOpen(id);
        }}
      />
      <MissionList
        missions={list.missions
          .filter((mission) => mission.status !== 'cancelled')
          .slice(0, 6)}
        loading={list.loading}
        error={list.error}
        onOpen={onOpen}
      />
      <Fold title="Custom mission">
        <MissionCreateForm
          health={health}
          onCreated={(mission) => {
            void list.reload();
            onOpen(mission.id);
          }}
        />
      </Fold>
    </div>
  );
}

/**
 * Mission control. `missionId` comes from the `#/missions/:id` hash; without
 * one the page lists missions and offers the create form. No CopilotKit hooks:
 * the page works whether or not Intelligence is configured.
 */
export function MissionPage({
  missionId,
  spaces,
  onOpenMission,
  onBack,
}: {
  missionId?: string;
  spaces: readonly Pick<Space, 'id' | 'name'>[];
  onOpenMission: (missionId: string) => void;
  onBack: () => void;
}) {
  const healthState = useNemoDotsHealth();
  return missionId ? (
    <MissionDetail
      key={missionId}
      missionId={missionId}
      spaces={spaces}
      healthState={healthState}
      onBack={onBack}
    />
  ) : (
    <ListView
      health={healthState.health}
      healthError={healthState.error}
      onOpen={onOpenMission}
    />
  );
}
