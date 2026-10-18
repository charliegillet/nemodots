import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// the views import the app's api client, which reads sessionStorage at load
vi.mock('../../../src/client/api', () => ({
  api: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
}));
import {
  AcceptanceConsole,
  explainAcceptance,
} from '../../../src/client/nemodots/views/AcceptanceConsole';
import {
  createMissionState,
  mergeMissionSnapshot,
  type ProbeNode,
} from '../../../src/client/nemodots/mission-events';
import { snapshot, ids } from './helpers';

const html = (node: React.ReactElement) =>
  renderToStaticMarkup(node).replace(/<!-- -->/g, '');

const base = snapshot();
const passProbe: ProbeNode = {
  receiptId: ids.receipt,
  verdict: 'pass',
  invariants: [{ name: 'order_created', ok: true }],
  healthSamples: null,
  healthOk: null,
  eventId: 1,
};

describe('explainAcceptance', () => {
  it('says accepted only for a succeeded mission, naming the receipt', () => {
    const result = explainAcceptance({
      mission: {
        status: 'succeeded',
        acceptanceReceiptId: ids.receipt as never,
      },
      probe: passProbe,
      invalidations: [],
      tasks: [],
    });
    expect(result?.accepted).toBe(true);
    expect(result?.summary).toContain('Mission accepted');
    expect(result?.reasons).toEqual([]);
  });

  it('a passing probe does not make an unfinished mission accepted; it says why', () => {
    const result = explainAcceptance({
      mission: { status: 'awaiting_acceptance', acceptanceReceiptId: null },
      probe: passProbe,
      invalidations: [
        { resolvedAt: null },
        { resolvedAt: '2026-10-17T18:00:00Z' },
      ],
      tasks: [
        { status: 'succeeded' },
        { status: 'runnable' },
        { status: 'runnable' },
        { status: 'running' },
      ],
    });
    expect(result?.accepted).toBe(false);
    expect(result?.summary).toBe(
      'Mission not accepted (status: Awaiting acceptance).',
    );
    expect(result?.reasons.join(' ')).toContain(
      '1 evidence change is still open',
    );
    expect(result?.reasons.join(' ')).toContain(
      '3 tasks are not finished (2 runnable, 1 running)',
    );
  });

  it('names a failed probe, an ended mission, and the plain waiting case', () => {
    expect(
      explainAcceptance({
        mission: { status: 'running', acceptanceReceiptId: null },
        probe: { ...passProbe, verdict: 'fail' },
        invalidations: [],
        tasks: [{ status: 'succeeded' }],
      })?.reasons,
    ).toEqual(['The latest probe failed.']);
    expect(
      explainAcceptance({
        mission: { status: 'cancelled', acceptanceReceiptId: null },
        probe: null,
        invalidations: [],
        tasks: [],
      })?.reasons,
    ).toEqual(['The mission ended cancelled.']);
    expect(
      explainAcceptance({
        mission: { status: 'awaiting_acceptance', acceptanceReceiptId: null },
        probe: null,
        invalidations: [],
        tasks: [{ status: 'succeeded' }],
      })?.reasons,
    ).toEqual(['Waiting for an acceptance probe to pass and be recorded.']);
    expect(
      explainAcceptance({
        mission: null,
        probe: null,
        invalidations: [],
        tasks: [],
      }),
    ).toBeNull();
  });
});

describe('the probe panel', () => {
  const state = mergeMissionSnapshot(
    createMissionState(ids.mission),
    base,
  ).state;
  const render = (
    patch: Partial<Parameters<typeof AcceptanceConsole>[0]> = {},
  ) =>
    html(
      <AcceptanceConsole
        health={null}
        checkout={null}
        healthError={null}
        healthLoading={false}
        receipts={state.receipts}
        probe={passProbe}
        acceptanceReceiptId={null}
        mission={{ ...base.mission, status: 'awaiting_acceptance' }}
        invalidations={[]}
        tasks={[{ ...state.tasks[0], status: 'runnable' }]}
        onChanged={() => undefined}
        {...patch}
      />,
    );

  it('labels the probe as a probe result, apart from the mission acceptance state', () => {
    const markup = render();
    expect(markup).toContain('Probe result:');
    expect(markup).not.toContain('Verdict');
    expect(markup).toContain('Pass');
    expect(markup).toContain('aria-label="Mission acceptance"');
    expect(markup).toContain('Not accepted');
    expect(markup).toContain(
      'Mission not accepted (status: Awaiting acceptance).',
    );
    expect(markup).toContain('1 task is not finished (1 runnable)');
    expect(markup).toContain(
      'A probe result is not the mission&#x27;s acceptance',
    );
  });

  it('shows the acceptance state even before any probe has run', () => {
    const markup = render({ probe: null });
    expect(markup).toContain('The acceptance probe has not run yet.');
    expect(markup).toContain('Mission not accepted');
  });

  it('says Accepted, with the receipt, only for a succeeded mission', () => {
    const markup = render({
      mission: {
        ...base.mission,
        status: 'succeeded',
        acceptanceReceiptId: ids.receipt as never,
      },
      tasks: [],
    });
    expect(markup).toContain('Mission accepted');
    expect(markup).not.toContain('Mission not accepted');
  });
});
