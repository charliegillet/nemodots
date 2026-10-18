import { useState } from 'react';
import type {
  CheckoutHealthResponse,
  ConfigValue,
  HealthStatus,
  Mission,
} from '../../../server/nemodots/contracts/index.js';
import { HealthPanel } from '../components/HealthPanel';
import { Panel } from '../components/Panel';
import { StatusPill } from '../components/StatusPill';
import { shortId } from '../format';
import { statusLabel } from '../status';
import { editSource, runInjector } from '../mission-api';
import type {
  InvalidationNode,
  ProbeNode,
  ReceiptNode,
  TaskNode,
} from '../mission-events';

// Health and acceptance: system health, the latest acceptance probe, a manual
// source edit (same version authority as the agents) and an injector run.

const CONFIG_PREFIX = 'checkout.config/';
const SCENARIO_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ValueType = 'string' | 'number' | 'boolean';

export type ParsedValue =
  { ok: true; value: ConfigValue } | { ok: false; error: string };

/** Converts the form text to the typed config value. */
export function parseConfigValue(text: string, type: ValueType): ParsedValue {
  if (type === 'boolean') {
    if (text.trim() === 'true') return { ok: true, value: true };
    if (text.trim() === 'false') return { ok: true, value: false };
    return { ok: false, error: 'Enter true or false.' };
  }
  if (type === 'number') {
    const trimmed = text.trim();
    const value = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(value))
      return { ok: false, error: 'Enter a number.' };
    return { ok: true, value };
  }
  if (text === '') return { ok: false, error: 'Enter a value.' };
  return { ok: true, value: text };
}

export interface EditableSource {
  sourceKey: string;
  revision: number;
}

/** Latest known revision per member key; only members can be edited. */
export function editableSources(
  receipts: readonly ReceiptNode[],
): EditableSource[] {
  const latest = new Map<string, number>();
  for (const receipt of receipts) {
    if (
      !receipt.sourceKey.startsWith(CONFIG_PREFIX) ||
      receipt.sourceRevision === null
    )
      continue;
    latest.set(
      receipt.sourceKey,
      Math.max(latest.get(receipt.sourceKey) ?? 0, receipt.sourceRevision),
    );
  }
  return [...latest.entries()]
    .map(([sourceKey, revision]) => ({ sourceKey, revision }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function ManualEdit({
  receipts,
  onChanged,
}: {
  receipts: readonly ReceiptNode[];
  onChanged: () => void;
}) {
  const sources = editableSources(receipts);
  const [chosen, setChosen] = useState('');
  const [type, setType] = useState<ValueType>('string');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const selected = sources.find((source) => source.sourceKey === chosen);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!selected) {
      setError('Choose a source to edit.');
      return;
    }
    const parsed = parseConfigValue(text, type);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await editSource(selected.sourceKey, {
        value: parsed.value,
        expectedVersion: selected.revision,
      });
      setDone(`${result.key} is now at version ${result.version}.`);
      onChanged();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'The edit was not applied.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="nd-scenario-form"
      aria-label="Manual source edit"
      onSubmit={(event) => void submit(event)}
    >
      <h4>Manual source edit</h4>
      <p className="nd-note">
        Writes through the same version authority as the agents. A stale version
        is rejected.
      </p>
      <label className="nd-field">
        <span>Source</span>
        <select
          value={chosen}
          disabled={busy || sources.length === 0}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">
            {sources.length === 0 ? 'No editable sources yet' : 'Choose…'}
          </option>
          {sources.map((source) => (
            <option key={source.sourceKey} value={source.sourceKey}>
              {source.sourceKey} (version {source.revision})
            </option>
          ))}
        </select>
      </label>
      <label className="nd-field">
        <span>Value type</span>
        <select
          value={type}
          disabled={busy}
          onChange={(event) => setType(event.target.value as ValueType)}
        >
          <option value="string">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
        </select>
      </label>
      <label className="nd-field">
        <span>New value</span>
        <input
          type="text"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      <button type="submit" disabled={busy || !selected}>
        {busy ? 'Applying…' : 'Apply edit'}
      </button>
    </form>
  );
}

function InjectorRun({ onStarted }: { onStarted: () => void }) {
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const scenarioClass = scenario.trim();
    if (!SCENARIO_PATTERN.test(scenarioClass)) {
      setError(
        'Use a scenario class name: lowercase letters, digits, "_" or "-".',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setRunId(null);
    try {
      const result = await runInjector({ scenarioClass });
      setRunId(result.runId);
      onStarted();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'The injector run was not started.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="nd-scenario-form"
      aria-label="Injector run"
      onSubmit={(event) => void submit(event)}
    >
      <h4>Injector run</h4>
      <p className="nd-note">
        Starts a scripted scenario through the separate fault injector. Only the
        run id is returned.
      </p>
      <label className="nd-field">
        <span>Scenario class</span>
        <input
          type="text"
          value={scenario}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => setScenario(event.target.value)}
        />
      </label>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
      {runId && <p role="status">Injector run {runId} started.</p>}
      <button type="submit" disabled={busy || scenario.trim() === ''}>
        {busy ? 'Starting…' : 'Run injector'}
      </button>
    </form>
  );
}

const TERMINAL_TASK: readonly string[] = ['succeeded', 'failed', 'cancelled'];

export interface AcceptanceExplanation {
  accepted: boolean;
  /** One line: whether the MISSION is accepted, which a probe result alone never says. */
  summary: string;
  /** Why it is not accepted, from the evidence and the tasks shown on this page. */
  reasons: string[];
}

/**
 * The mission's acceptance state, kept apart from the probe result. A probe can
 * pass while the mission is not accepted (evidence changed after the probe, or
 * work is still scheduled), so this reads the mission, its open invalidations
 * and its unfinished tasks, never the probe verdict alone.
 */
export function explainAcceptance(input: {
  mission: Pick<Mission, 'status' | 'acceptanceReceiptId'> | null;
  probe: ProbeNode | null;
  invalidations: readonly Pick<InvalidationNode, 'resolvedAt'>[];
  tasks: readonly Pick<TaskNode, 'status'>[];
}): AcceptanceExplanation | null {
  const { mission, probe, invalidations, tasks } = input;
  if (!mission) return null;
  if (mission.status === 'succeeded')
    return {
      accepted: true,
      summary: mission.acceptanceReceiptId
        ? `Mission accepted: acceptance receipt ${shortId(mission.acceptanceReceiptId)} was accepted for this mission.`
        : 'Mission accepted.',
      reasons: [],
    };
  const reasons: string[] = [];
  const open = invalidations.filter((item) => !item.resolvedAt).length;
  if (open > 0)
    reasons.push(
      `${open} evidence ${open === 1 ? 'change is' : 'changes are'} still open. The mission cannot be accepted until ${open === 1 ? 'it is' : 'they are'} resolved.`,
    );
  const unfinished = tasks.filter(
    (task) => !TERMINAL_TASK.includes(task.status),
  );
  if (unfinished.length > 0) {
    const counts = new Map<string, number>();
    for (const task of unfinished)
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    reasons.push(
      `${unfinished.length} ${unfinished.length === 1 ? 'task is' : 'tasks are'} not finished (${[
        ...counts,
      ]
        .map(
          ([status, count]) => `${count} ${statusLabel(status).toLowerCase()}`,
        )
        .join(', ')}).`,
    );
  }
  if (mission.status === 'failed' || mission.status === 'cancelled')
    reasons.push(
      `The mission ended ${statusLabel(mission.status).toLowerCase()}.`,
    );
  if (probe?.verdict === 'fail') reasons.push('The latest probe failed.');
  if (reasons.length === 0)
    reasons.push(
      probe?.verdict === 'pass'
        ? 'The latest probe passed, but acceptance has not been recorded for the mission yet.'
        : 'Waiting for an acceptance probe to pass and be recorded.',
    );
  return {
    accepted: false,
    summary: `Mission not accepted (status: ${statusLabel(mission.status)}).`,
    reasons,
  };
}

function ProbePanel({
  probe,
  acceptanceReceiptId,
  mission,
  invalidations,
  tasks,
}: {
  probe: ProbeNode | null;
  acceptanceReceiptId: string | null;
  mission: Mission | null;
  invalidations: readonly InvalidationNode[];
  tasks: readonly TaskNode[];
}) {
  const acceptance = explainAcceptance({
    mission,
    probe,
    invalidations,
    tasks,
  });
  return (
    <Panel
      title="Acceptance probe"
      className="nd-probe"
      empty={
        probe === null && acceptanceReceiptId === null && acceptance === null
      }
      emptyText="The acceptance probe has not run yet."
    >
      {probe ? (
        <div>
          <p>
            Probe result:{' '}
            <StatusPill
              status={probe.verdict ?? 'unknown'}
              label={
                probe.verdict === 'pass'
                  ? 'Pass'
                  : probe.verdict === 'fail'
                    ? 'Fail'
                    : 'Unknown'
              }
            />{' '}
            <span className="nd-id">receipt {shortId(probe.receiptId)}</span>
          </p>
          {probe.invariants.length > 0 && (
            <ul aria-label="Probe invariants">
              {probe.invariants.map((invariant) => (
                <li key={invariant.name}>
                  <StatusPill
                    status={invariant.ok ? 'pass' : 'fail'}
                    label={invariant.ok ? 'Pass' : 'Fail'}
                  />{' '}
                  <code>{invariant.name}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p>The acceptance probe has not run yet.</p>
      )}
      {!probe && acceptanceReceiptId && (
        <p>
          Acceptance receipt <code>{shortId(acceptanceReceiptId)}</code> is
          recorded for this mission.
        </p>
      )}
      {acceptance && (
        <div className="nd-acceptance-state" aria-label="Mission acceptance">
          <p>
            <StatusPill
              status={acceptance.accepted ? 'accepted' : 'not_accepted'}
              label={acceptance.accepted ? 'Accepted' : 'Not accepted'}
              tone={acceptance.accepted ? 'ok' : 'warn'}
            />{' '}
            {acceptance.summary}
          </p>
          {acceptance.reasons.length > 0 && (
            <ul aria-label="Why the mission is not accepted">
              {acceptance.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="nd-note">
            A probe result is not the mission&apos;s acceptance: the probe reads
            the checkout app once, while acceptance also needs every evidence
            change resolved and every task finished.
          </p>
        </div>
      )}
    </Panel>
  );
}

export function AcceptanceConsole({
  health,
  checkout,
  healthError,
  healthLoading,
  receipts,
  probe,
  acceptanceReceiptId,
  mission,
  invalidations,
  tasks,
  onChanged,
}: {
  health: HealthStatus | null;
  checkout: CheckoutHealthResponse | null;
  healthError: string | null;
  healthLoading: boolean;
  receipts: readonly ReceiptNode[];
  probe: ProbeNode | null;
  acceptanceReceiptId: string | null;
  mission: Mission | null;
  invalidations: readonly InvalidationNode[];
  tasks: readonly TaskNode[];
  /** called after an edit or an injector run so the page can refresh */
  onChanged: () => void;
}) {
  return (
    <div className="nd-acceptance">
      <HealthPanel
        health={health}
        checkout={checkout}
        error={healthError}
        loading={healthLoading && health === null}
      />
      <ProbePanel
        probe={probe}
        acceptanceReceiptId={acceptanceReceiptId}
        mission={mission}
        invalidations={invalidations}
        tasks={tasks}
      />
      <section className="nd-panel nd-controls" aria-label="Scenario controls">
        <h3 className="nd-panel-title">Scenario controls</h3>
        <ManualEdit receipts={receipts} onChanged={onChanged} />
        <InjectorRun onStarted={onChanged} />
      </section>
    </div>
  );
}
