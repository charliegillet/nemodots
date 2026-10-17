import { useState } from 'react';
import type {
  CreateMissionRequest,
  HealthStatus,
  Mission,
} from '../../server/nemodots/contracts/index.js';
import { createMission } from './mission-api';
import { deriveModeBadge } from './status';

// Mission creation: goal, optional constraints (one per line) and the
// admission delay. The form is disabled, with the missing environment variable
// names (never values), whenever the server reports blocked mode.

export const GOAL_MAX = 2000;
export const CONSTRAINT_MAX = 500;
export const CONSTRAINTS_MAX = 20;
export const MIN_AGE_MAX_MS = 60000;

export interface CreateFormInput {
  goal: string;
  constraintsText: string;
  minAgeText: string;
}

/** Validates form text into a request body; returns an error string on failure. */
export function buildCreateRequest(
  input: CreateFormInput,
  mode: HealthStatus['mode'],
): CreateMissionRequest | string {
  const goal = input.goal.trim();
  if (!goal) return 'Enter the goal for the mission.';
  if (goal.length > GOAL_MAX)
    return `The goal is limited to ${GOAL_MAX} characters.`;
  const constraints = input.constraintsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (constraints.length > CONSTRAINTS_MAX)
    return `Use at most ${CONSTRAINTS_MAX} constraints.`;
  if (constraints.some((line) => line.length > CONSTRAINT_MAX))
    return `Each constraint is limited to ${CONSTRAINT_MAX} characters.`;
  const ageText = input.minAgeText.trim();
  const minAgeMs = ageText === '' ? 0 : Number(ageText);
  if (!Number.isInteger(minAgeMs) || minAgeMs < 0 || minAgeMs > MIN_AGE_MAX_MS)
    return `Admission delay must be a whole number of milliseconds from 0 to ${MIN_AGE_MAX_MS}.`;
  return {
    goal,
    ...(constraints.length ? { constraints } : {}),
    ...(mode === 'blocked' ? {} : { mode }),
    admission: { minAgeMs },
  };
}

export function MissionCreateForm({
  health,
  onCreated,
}: {
  health: HealthStatus | null;
  onCreated: (mission: Mission) => void;
}) {
  const [goal, setGoal] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [minAgeText, setMinAgeText] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge = deriveModeBadge(health);
  const blocked = health !== null && health.mode === 'blocked';
  const unknown = health === null;
  const disabled = blocked || unknown || busy;
  const reason = blocked
    ? badge.missingEnv.length > 0
      ? `BLOCKED: mission creation needs ${badge.missingEnv.join(', ')}.`
      : 'BLOCKED: mission creation is not available.'
    : unknown
      ? 'Mission creation is unavailable until NemoDots health has loaded.'
      : null;

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (health === null || health.mode === 'blocked') return;
    const request = buildCreateRequest(
      { goal, constraintsText, minAgeText },
      health.mode,
    );
    if (typeof request === 'string') {
      setError(request);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const mission = await createMission(request);
      setGoal('');
      setConstraintsText('');
      onCreated(mission);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'Could not create the mission.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="nd-create"
      aria-label="Create mission"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="nd-create-title">New mission</h2>
      {reason && (
        <p className="nd-create-blocked" role="status">
          {reason}
        </p>
      )}
      {badge.kind === 'fixture' && (
        <p className="nd-note">
          Fixture mode: this mission uses scripted model responses, not a live
          model.
        </p>
      )}
      <label className="nd-field">
        <span>Goal</span>
        <textarea
          value={goal}
          maxLength={GOAL_MAX}
          rows={3}
          disabled={disabled}
          required
          onChange={(event) => setGoal(event.target.value)}
        />
      </label>
      <label className="nd-field">
        <span>Constraints (one per line, optional)</span>
        <textarea
          value={constraintsText}
          rows={3}
          disabled={disabled}
          onChange={(event) => setConstraintsText(event.target.value)}
        />
      </label>
      <label className="nd-field">
        <span>Admission delay (minAgeMs, 0 to {MIN_AGE_MAX_MS})</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MIN_AGE_MAX_MS}
          step={1}
          value={minAgeText}
          disabled={disabled}
          onChange={(event) => setMinAgeText(event.target.value)}
        />
      </label>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={disabled}>
        {busy ? 'Creating…' : 'Create mission'}
      </button>
    </form>
  );
}
