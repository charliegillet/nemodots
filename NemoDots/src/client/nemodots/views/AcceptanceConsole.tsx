import { useState } from 'react';
import type {
  CheckoutHealthResponse,
  ConfigValue,
  HealthStatus,
} from '../../../server/nemodots/contracts/index.js';
import { HealthPanel } from '../components/HealthPanel';
import { Panel } from '../components/Panel';
import { StatusPill } from '../components/StatusPill';
import { shortId } from '../format';
import { editSource, runInjector } from '../mission-api';
import type { ProbeNode, ReceiptNode } from '../mission-events';

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

function ProbePanel({
  probe,
  acceptanceReceiptId,
}: {
  probe: ProbeNode | null;
  acceptanceReceiptId: string | null;
}) {
  return (
    <Panel
      title="Acceptance probe"
      className="nd-probe"
      empty={probe === null && acceptanceReceiptId === null}
      emptyText="The acceptance probe has not run yet."
    >
      {probe && (
        <div>
          <p>
            Verdict:{' '}
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
            <ul aria-label="Acceptance invariants">
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
      )}
      {!probe && acceptanceReceiptId && (
        <p>
          Acceptance receipt <code>{shortId(acceptanceReceiptId)}</code> is
          recorded for this mission.
        </p>
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
  onChanged,
}: {
  health: HealthStatus | null;
  checkout: CheckoutHealthResponse | null;
  healthError: string | null;
  healthLoading: boolean;
  receipts: readonly ReceiptNode[];
  probe: ProbeNode | null;
  acceptanceReceiptId: string | null;
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
      <ProbePanel probe={probe} acceptanceReceiptId={acceptanceReceiptId} />
      <section className="nd-panel nd-controls" aria-label="Scenario controls">
        <h3 className="nd-panel-title">Scenario controls</h3>
        <ManualEdit receipts={receipts} onChanged={onChanged} />
        <InjectorRun onStarted={onChanged} />
      </section>
    </div>
  );
}
