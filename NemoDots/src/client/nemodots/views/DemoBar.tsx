import { useState } from 'react';
import type { Mission } from '../../../server/nemodots/contracts/index.js';
import {
  createMission,
  runInjector,
  runMissionLifecycle,
} from '../mission-api';

export const DEMO_GOAL =
  'Restore checkout availability while preserving customer data';
export const DEMO_SCENARIO = 'dependent_change_after_proposal';

const message = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback;

/** One click: create the demo mission, break the checkout, start the agents. */
export function RunDemoButton({
  onOpen,
}: {
  onOpen: (missionId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      setBusy('Creating mission…');
      const mission = await createMission({
        goal: DEMO_GOAL,
        admission: { minAgeMs: 0 },
      });
      setBusy('Breaking checkout…');
      await runInjector({ scenarioClass: DEMO_SCENARIO });
      setBusy('Starting agents…');
      await runMissionLifecycle(mission.id, 'start');
      onOpen(mission.id);
    } catch (failure) {
      setError(message(failure, 'Could not start the demo.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="nd-demo-hero">
      <button
        type="button"
        className="nd-demo-button nd-demo-primary"
        disabled={busy !== null}
        onClick={() => void run()}
      >
        {busy ?? '▶  Run demo mission'}
      </button>
      <p className="nd-demo-sub">
        Breaks the checkout, then a Nemotron team restores it live on Crusoe.
      </p>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Step buttons on the mission page: break the checkout, start the agents. */
export function DemoBar({
  mission,
  onChanged,
}: {
  mission: Mission | null;
  onChanged: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState<'break' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = mission?.status ?? null;
  const started = status !== null && status !== 'created';

  const act = async (step: 'break' | 'start') => {
    if (!mission) return;
    setBusy(step);
    setError(null);
    try {
      if (step === 'break') {
        await runInjector({ scenarioClass: DEMO_SCENARIO });
        setBroken(true);
      } else {
        await runMissionLifecycle(mission.id, 'start');
      }
      onChanged();
    } catch (failure) {
      setError(message(failure, 'That step failed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="nd-demo-bar" aria-label="Demo steps">
      <button
        type="button"
        className="nd-demo-button"
        disabled={busy !== null || broken || started}
        onClick={() => void act('break')}
      >
        <span className="nd-demo-step">1</span>
        {busy === 'break'
          ? 'Breaking…'
          : broken || started
            ? 'Checkout broken'
            : 'Break checkout'}
      </button>
      <button
        type="button"
        className="nd-demo-button nd-demo-primary"
        disabled={busy !== null || started || !mission}
        onClick={() => void act('start')}
      >
        <span className="nd-demo-step">2</span>
        {busy === 'start' ? 'Starting…' : started ? 'Agents running' : 'Start agents'}
      </button>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** A collapsed section: a one-line summary that opens to the full panel. */
export function Fold({
  title,
  meta,
  open,
  children,
}: {
  title: string;
  meta?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="nd-fold" open={open}>
      <summary>
        <span>{title}</span>
        {meta && <span className="nd-fold-meta">{meta}</span>}
      </summary>
      <div className="nd-fold-body">{children}</div>
    </details>
  );
}
