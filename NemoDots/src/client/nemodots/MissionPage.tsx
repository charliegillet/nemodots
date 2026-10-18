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
import { IntelligenceBadge, ModeBadge } from './components/ModeBadge';
import { RecoveryTimeline } from './components/RecoveryTimeline';
import { TaskTree } from './components/TaskTree';
import { TelemetryPanel } from './components/TelemetryPanel';
import { runMissionLifecycle } from './mission-api';
import { selectDependencyEdges } from './mission-events';
import { MissionCreateForm } from './MissionCreateForm';
import { deriveIntelligenceBadge, deriveModeBadge } from './status';
import {
  useMission,
  useMissionList,
  useNemoDotsHealth,
  type UseNemoDotsHealthResult,
} from './use-mission';
import { AcceptanceConsole } from './views/AcceptanceConsole';
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
      <div className="nd-mission-grid">
        <div className="nd-col">
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
          <FindingList findings={findings} />
        </div>
        <div className="nd-col">
          <DependencyView
            edges={selectDependencyEdges(state)}
            loading={pending}
            error={panelError}
          />
        </div>
      </div>
      <div className="nd-block-row">
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
      </div>
      <div className="nd-mission-grid">
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
      <RecoveryTimeline
        events={state.events}
        invalidations={state.invalidations}
        recoveries={state.recoveries}
        loading={pending}
        error={panelError}
      />
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
      <TelemetryPanel
        telemetry={state.telemetry}
        loading={pending}
        error={panelError}
      />
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
          <p>
            A team of Nemotron agents restores the checkout app and keeps its
            evidence current.
          </p>
        </div>
      </div>
      <p className="nd-badges">
        <ModeBadge badge={deriveModeBadge(health)} />
        <IntelligenceBadge badge={deriveIntelligenceBadge(health)} />
      </p>
      {healthError && (
        <p className="nd-error" role="alert">
          {healthError}
        </p>
      )}
      <div className="nd-mission-grid">
        <MissionCreateForm
          health={health}
          onCreated={(mission) => {
            void list.reload();
            onOpen(mission.id);
          }}
        />
        <MissionList
          missions={list.missions}
          loading={list.loading}
          error={list.error}
          onOpen={onOpen}
        />
      </div>
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
