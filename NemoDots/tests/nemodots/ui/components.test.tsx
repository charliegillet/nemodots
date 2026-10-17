import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  HealthStatusSchema,
  TelemetrySummarySchema,
} from '../../../src/server/nemodots/contracts/index.js';
import { darkTheme } from '../../../src/build/dark-theme';
import { ActionInspector } from '../../../src/client/nemodots/components/ActionInspector';
import { DependencyView } from '../../../src/client/nemodots/components/DependencyView';
import { EvidenceLedger } from '../../../src/client/nemodots/components/EvidenceLedger';
import { FindingList } from '../../../src/client/nemodots/components/FindingList';
import { HealthPanel } from '../../../src/client/nemodots/components/HealthPanel';
import {
  IntelligenceBadge,
  ModeBadge,
} from '../../../src/client/nemodots/components/ModeBadge';
import {
  RecoveryTimeline,
  buildTimelineEntries,
} from '../../../src/client/nemodots/components/RecoveryTimeline';
import { StatusPill } from '../../../src/client/nemodots/components/StatusPill';
import { TaskTree } from '../../../src/client/nemodots/components/TaskTree';
import { TelemetryPanel } from '../../../src/client/nemodots/components/TelemetryPanel';
import {
  applyMissionEvent,
  createMissionState,
  selectDependencyEdges,
  type MissionState,
} from '../../../src/client/nemodots/mission-events';
import {
  deriveIntelligenceBadge,
  deriveModeBadge,
} from '../../../src/client/nemodots/status';
import {
  eventPayloads,
  health,
  invalidationId,
  telemetry,
} from '../contracts/fixtures.js';
import { ev, ids, payload, T0, T1 } from './helpers';

const html = (node: React.ReactElement) =>
  renderToStaticMarkup(node).replace(/<!-- -->/g, '');

const stateFrom = (...events: ReturnType<typeof ev>[]): MissionState =>
  events.reduce(
    (s, e) => applyMissionEvent(s, e).state,
    createMissionState(ids.mission),
  );

const taskPayload = (patch: Record<string, unknown>) => ({
  kind: 'task.created',
  task: { ...(eventPayloads()['task.created'].task as object), ...patch },
});

/** The changed-evidence sequence of a recovery, with deliberately shuffled arrival. */
const recoveryEvents = () => [
  ev(
    1,
    payload('attempt.started', {
      repairOf: null,
      attemptKind: 'initial',
      n: 1,
      attemptId: ids.attempt,
    }),
  ),
  ev(2, payload('receipt.registered'), { at: '2026-10-17T18:01:00.000Z' }),
  ev(3, payload('invalidation.recorded')),
  ev(4, payload('action.decided')),
  ev(5, payload('attempt.aborted')),
  ev(6, payload('recovery.recorded')),
  ev(7, payload('attempt.started')),
  ev(8, payload('invalidation.resolved')),
];

describe('StatusPill and badges', () => {
  it('renders text for every status, not colour alone', () => {
    const markup = html(<StatusPill status="outcome_unknown" />);
    expect(markup).toContain('Outcome unknown');
    expect(markup).toContain('aria-hidden="true"');
    expect(html(<StatusPill status="x" label="Custom" tone="bad" />)).toContain(
      'nd-tone-bad',
    );
  });

  it('labels Live, Fixture and Blocked in words with the missing env names', () => {
    const live = html(
      <ModeBadge badge={deriveModeBadge(HealthStatusSchema.parse(health()))} />,
    );
    expect(live).toContain('>Live<');
    expect(live).toContain('aria-label="Run mode: Live.');
    const fixture = html(
      <ModeBadge
        badge={deriveModeBadge(
          HealthStatusSchema.parse({ ...health(), mode: 'fixture' }),
        )}
      />,
    );
    expect(fixture).toContain('>Fixture<');
    expect(fixture).not.toContain('>Live<');
    const blocked = html(
      <ModeBadge
        badge={deriveModeBadge(
          HealthStatusSchema.parse({
            ...health(),
            mode: 'blocked',
            missingEnv: ['OPENAI_API_KEY'],
          }),
        )}
      />,
    );
    expect(blocked).toContain('>Blocked<');
    expect(blocked).toContain('Missing OPENAI_API_KEY');
  });

  it('renders the Intelligence badge separately', () => {
    const markup = html(
      <IntelligenceBadge
        badge={deriveIntelligenceBadge(
          HealthStatusSchema.parse({ ...health(), intelligence: 'blocked' }),
        )}
      />,
    );
    expect(markup).toContain('Intelligence blocked');
  });
});

describe('TaskTree', () => {
  it('renders empty, loading and error states', () => {
    expect(html(<TaskTree tasks={[]} />)).toContain('No tasks yet');
    const loading = html(<TaskTree tasks={[]} loading />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');
    const error = html(<TaskTree tasks={[]} error="Could not load tasks." />);
    expect(error).toContain('role="alert"');
    expect(error).toContain('Could not load tasks.');
    expect(error).not.toContain('No tasks yet');
  });

  it('nests children, shows status text, attempts and repairs', () => {
    const state = stateFrom(
      ev(1, taskPayload({})),
      ev(
        2,
        taskPayload({
          id: ids.task2,
          parentId: ids.task,
          depth: 1,
          title: 'Verify fix',
          role: 'verifier',
          justification: 'check',
        }),
      ),
      ev(3, payload('task.status', { to: 'repairing' })),
      ev(4, payload('attempt.started')),
    );
    const markup = html(
      <TaskTree
        tasks={state.tasks}
        attempts={state.attempts}
        selectedTaskId={ids.task}
        onSelectTask={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Tasks"');
    expect(markup).toContain('Subtasks of Investigate');
    expect(markup).toContain('Repairing');
    expect(markup).toContain('1 attempt, 1 repair');
    expect(markup).toContain('aria-current="true"');
    expect(markup.indexOf('Investigate')).toBeLessThan(
      markup.indexOf('Verify fix'),
    );
  });

  it('promotes orphans and cycle members instead of dropping them', () => {
    const state = stateFrom(
      ev(
        1,
        taskPayload({
          id: ids.task,
          parentId: ids.task2,
          depth: 1,
          justification: 'x',
        }),
      ),
      ev(
        2,
        taskPayload({
          id: ids.task2,
          parentId: ids.task,
          depth: 1,
          title: 'Other',
          justification: 'x',
        }),
      ),
    );
    const markup = html(<TaskTree tasks={state.tasks} />);
    expect(markup).toContain('Investigate');
    expect(markup).toContain('Other');
  });

  it('escapes untrusted titles', () => {
    const state = stateFrom(
      ev(1, taskPayload({ title: '<script>alert(1)</script>' })),
    );
    const markup = html(<TaskTree tasks={state.tasks} />);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('EvidenceLedger', () => {
  const receiptState = () =>
    stateFrom(
      ev(1, payload('receipt.registered'), { at: T0 }),
      ev(2, payload('receipt.confirmed'), { at: T1 }),
    );

  it('renders states', () => {
    expect(html(<EvidenceLedger receipts={[]} />)).toContain(
      'No evidence recorded yet',
    );
    expect(html(<EvidenceLedger receipts={[]} loading />)).toContain(
      'role="status"',
    );
    expect(html(<EvidenceLedger receipts={[]} error="nope" />)).toContain(
      'role="alert"',
    );
  });

  it('shows lastConfirmedAt, status text and origin', () => {
    const state = receiptState();
    const markup = html(
      <EvidenceLedger
        receipts={state.receipts}
        nowMs={Date.parse(T1) + 120000}
      />,
    );
    expect(markup).toContain('aria-label="Evidence receipts"');
    expect(markup).toContain('Last confirmed');
    expect(markup).toContain('2026-10-17 18:00:05 UTC');
    expect(markup).toContain('2m ago');
    expect(markup).toContain('Supported');
    expect(markup).toContain('External observation');
    expect(markup).toContain('checkout.health');
  });

  it('says when a receipt was never confirmed', () => {
    const markup = html(
      <EvidenceLedger
        receipts={[{ ...receiptState().receipts[0], lastConfirmedAt: null }]}
      />,
    );
    expect(markup).toContain('Never confirmed');
  });
});

describe('DependencyView', () => {
  const edges = () =>
    selectDependencyEdges(
      stateFrom(
        ev(1, taskPayload({})),
        ev(
          2,
          taskPayload({
            id: ids.task2,
            parentId: null,
            depth: 0,
            title: 'Verify',
            prerequisites: [ids.task],
          }),
        ),
        ev(3, payload('attempt.finished')),
        ev(4, payload('action.proposed')),
      ),
    );

  it('renders states', () => {
    expect(html(<DependencyView edges={[]} />)).toContain(
      'No dependencies recorded yet',
    );
    expect(html(<DependencyView edges={[]} loading />)).toContain(
      'role="status"',
    );
    expect(html(<DependencyView edges={[]} error="x" />)).toContain(
      'role="alert"',
    );
  });

  it('distinguishes scheduling and evidence by text and by line pattern', () => {
    const markup = html(<DependencyView edges={edges()} />);
    expect(markup).toContain('Scheduling edges (1)');
    expect(markup).toContain('Evidence edges (3)');
    expect(markup).toContain('must finish before');
    expect(markup).toContain('is relied on by');
    expect(markup).toContain('Solid line: scheduling');
    expect(markup).toContain('Dashed line: evidence');
    expect(markup).toContain('<svg');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('nd-edge-scheduling');
    expect(markup).toContain('nd-edge-evidence');
  });

  it('caps the drawn graph but keeps the list complete', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i}`,
      kind: 'evidence' as const,
      from: { kind: 'receipt' as const, id: `r${i}`, label: `receipt ${i}` },
      to: { kind: 'task' as const, id: 't', label: 'task' },
    }));
    const markup = html(<DependencyView edges={many} />);
    expect(markup).toContain('first 60 of 70 edges');
    expect((markup.match(/nd-edge-item/g) ?? []).length).toBe(70);
  });
});

describe('ActionInspector', () => {
  const decided = () =>
    stateFrom(
      ev(1, payload('action.proposed')),
      ev(2, payload('action.decided')),
      ev(
        3,
        payload('action.decided', {
          stage: 'dispatch',
          decision: 'blocked',
          blockReason: 'dispatch_fence_invalid',
          blockDetail: 'fence 5 is older than 6',
          dispatchFence: { token: 5, valid: false },
        }),
      ),
    ).actions[0];

  it('renders states', () => {
    expect(html(<ActionInspector action={null} />)).toContain(
      'No action selected',
    );
    expect(html(<ActionInspector action={null} loading />)).toContain(
      'role="status"',
    );
    expect(html(<ActionInspector action={null} error="boom" />)).toContain(
      'role="alert"',
    );
  });

  it('shows stage, decision, block reason, checked vector freshness, fence and versions', () => {
    const markup = html(
      <ActionInspector action={decided()} nowMs={Date.parse(T1) + 5000} />,
    );
    expect(markup).toContain('Commit stage');
    expect(markup).toContain('Dispatch stage');
    expect(markup).toContain('Admission stage: not decided yet');
    expect(markup).toContain('Blocked');
    expect(markup).toContain('Stale version');
    expect(markup).toContain('stale_version');
    expect(markup).toContain('expected 3, live 4');
    expect(markup).toContain('(mismatch)');
    expect(markup).toContain('Dispatch fence: token 5');
    expect(markup).toContain('invalid');
    expect(markup).toContain('Checked dependency vector');
    expect(markup).toContain('Fresh');
    expect(markup).toContain('cache.namespace advanced 3 -&gt; 4');
  });

  it('shows stale freshness, script result and unknown outcome in words', () => {
    const base = decided();
    const row = {
      ...base.decisions.commit!.checkedVector[0],
      freshnessOk: false,
    };
    const action = {
      ...base,
      status: 'outcome_unknown' as const,
      unknownDetail: 'redis timeout after effect',
      dispatched: { scriptResult: 'fence_newer' as const, deletedCount: 12 },
      decisions: {
        commit: { ...base.decisions.commit!, checkedVector: [row] },
      },
    };
    const markup = html(<ActionInspector action={action} />);
    expect(markup).toContain('Stale');
    expect(markup).toContain('Fence newer');
    expect(markup).toContain('12 keys deleted');
    expect(markup).toContain('the effect may or may not have been applied');
    expect(markup).toContain('redis timeout after effect');
  });

  it('never renders control fields or prompts present on the node or the event', () => {
    const dirtyEvent = ev(2, payload('action.decided'));
    (dirtyEvent.payload as Record<string, unknown>).control = {
      probeSecret: 'SECRET-VALUE',
    };
    (dirtyEvent.payload as Record<string, unknown>).prompt =
      'SYSTEM PROMPT TEXT';
    const state = stateFrom(ev(1, payload('action.proposed')), dirtyEvent);
    const action = {
      ...state.actions[0],
      control: { probeSecret: 'SECRET-VALUE' },
      rawBody: 'RAW BODY',
    } as (typeof state.actions)[0];
    const markup = html(<ActionInspector action={action} />);
    expect(markup).not.toContain('SECRET-VALUE');
    expect(markup).not.toContain('SYSTEM PROMPT TEXT');
    expect(markup).not.toContain('RAW BODY');
    expect(html(<RecoveryTimeline events={[dirtyEvent]} />)).not.toContain(
      'SECRET-VALUE',
    );
  });

  it('escapes untrusted block detail', () => {
    const state = stateFrom(
      ev(1, payload('action.proposed')),
      ev(
        2,
        payload('action.decided', {
          blockDetail: '<img src=x onerror=alert(1)><script>alert(2)</script>',
        }),
      ),
    );
    const markup = html(<ActionInspector action={state.actions[0]} />);
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('onerror=alert(1)>');
  });
});

describe('RecoveryTimeline', () => {
  it('renders states', () => {
    expect(html(<RecoveryTimeline events={[]} />)).toContain(
      'No evidence changes or recoveries yet',
    );
    expect(html(<RecoveryTimeline events={[]} loading />)).toContain(
      'role="status"',
    );
    expect(
      html(<RecoveryTimeline events={[]} error="stream lost" />),
    ).toContain('role="alert"');
  });

  it('renders the full changed-evidence sequence in causal order', () => {
    const events = recoveryEvents();
    const entries = buildTimelineEntries(events);
    expect(entries.map((e) => e.step)).toEqual([
      'evidence',
      'invalidation',
      'decision',
      'recovery',
      'repair',
      'resolved',
    ]);
    // the initial (non-repair) attempt.started and the attempt.aborted are not part of it
    expect(entries.map((e) => e.eventId)).toEqual([2, 3, 4, 6, 7, 8]);
    const markup = html(<RecoveryTimeline events={[...events].reverse()} />);
    const order = [
      'Evidence registered: checkout.health revision 8',
      'Invalidation recorded: newer observation on checkout.config/cache.namespace',
      'Action a7b8c9d0: commit blocked',
      'Recovery: repair scheduled',
      'Repair attempt 2 started',
      'Invalidation ' + invalidationId.slice(0, 8) + ' resolved',
    ].map((text) => markup.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain('supersedes receipt c1d2e3f4');
    expect(markup).toContain(
      'Repairs attempt 9a8b7c6d after invalidation ' +
        invalidationId.slice(0, 8),
    );
    expect(markup).toContain('Block reason: stale version');
    expect(markup).toContain('repair with fresh reads');
    expect(markup).toContain('aria-label="Recovery events in order"');
  });

  it('escapes recovery notes', () => {
    const events = [
      ev(1, {
        kind: 'recovery.recorded',
        recovery: {
          ...(eventPayloads()['recovery.recorded'].recovery as object),
          detail: '<script>x()</script> **bold**',
        },
      }),
    ];
    const markup = html(<RecoveryTimeline events={events} />);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('HealthPanel', () => {
  it('renders states and the mode and Intelligence badges', () => {
    expect(html(<HealthPanel health={null} />)).toContain(
      'Health is unavailable',
    );
    expect(html(<HealthPanel health={null} loading />)).toContain(
      'role="status"',
    );
    expect(html(<HealthPanel health={null} error="x" />)).toContain(
      'role="alert"',
    );
    const markup = html(
      <HealthPanel
        health={HealthStatusSchema.parse({
          ...health(),
          mode: 'blocked',
          intelligence: 'blocked',
          missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
        })}
      />,
    );
    expect(markup).toContain('>Blocked<');
    expect(markup).toContain('Intelligence blocked');
    expect(markup).toContain('<code>OPENAI_API_KEY</code>');
    expect(markup).toContain('names only');
    expect(markup).toContain('nd-console');
  });

  it('shows provider and service state as text', () => {
    const markup = html(
      <HealthPanel
        health={HealthStatusSchema.parse({
          ...health(),
          postgres: 'down',
          checkout: { reachable: false, status: null },
        })}
      />,
    );
    expect(markup).toContain('api.inference.crusoecloud.com');
    expect(markup).toContain('Down');
    expect(markup).toContain('Unreachable');
  });
});

describe('TelemetryPanel', () => {
  it('renders "unavailable" for null telemetry', () => {
    expect(html(<TelemetryPanel telemetry={null} />)).toContain(
      'Telemetry unavailable',
    );
    expect(html(<TelemetryPanel telemetry={null} loading />)).toContain(
      'role="status"',
    );
    expect(html(<TelemetryPanel telemetry={null} error="x" />)).toContain(
      'role="alert"',
    );
  });

  it('never renders unavailable cached tokens as zero and shows orphaned calls', () => {
    const summary = TelemetrySummarySchema.parse({
      ...telemetry(),
      orphanedCalls: 2,
      ttftMs: null,
    });
    const markup = html(<TelemetryPanel telemetry={summary} />);
    expect(markup).toContain('Cached tokens</dt><dd>unavailable');
    expect(markup).toContain('Time to first token</dt><dd>unavailable');
    expect(markup).toContain('Orphaned calls</dt><dd>2');
    expect(markup).toContain('lost its lease fence');
    expect(markup).toContain('NVIDIA-Nemotron-3-Super-120B-A12B');
    expect(markup).toContain('aria-label="Usage by model"');
  });

  it('shows cached totals and latency when available', () => {
    const summary = TelemetrySummarySchema.parse({
      ...telemetry(),
      tokens: {
        prompt: 3000,
        completion: 200,
        cached: { available: true, total: 1500 },
      },
    });
    const markup = html(<TelemetryPanel telemetry={summary} />);
    expect(markup).toContain('Cached tokens</dt><dd>1,500');
    expect(markup).toContain('p50 420 ms, p95 900 ms');
  });
});

describe('FindingList', () => {
  const findings = () =>
    stateFrom(ev(1, payload('finding.published'))).findings;

  it('renders states', () => {
    expect(html(<FindingList findings={[]} />)).toContain(
      'No findings published yet',
    );
    expect(html(<FindingList findings={[]} loading />)).toContain(
      'role="status"',
    );
    expect(html(<FindingList findings={[]} error="x" />)).toContain(
      'role="alert"',
    );
  });

  it('labels every finding as a claim and not as evidence', () => {
    const markup = html(<FindingList findings={findings()} />);
    expect(markup).toContain('>claim<');
    expect(markup).toContain('High confidence');
    expect(markup).toContain('stale namespace');
    expect(markup).toContain('Cites 1 receipt');
    expect(markup).toContain('not evidence');
  });

  it('escapes markup and neutralises links and images in claims', () => {
    const claim = [
      '<script>alert(1)</script>',
      '[click](javascript:alert(2)) ![x](http://evil/p.png) <img src=x onerror=alert(3)>',
    ].join('\n\n');
    const state = stateFrom(ev(1, payload('finding.published', { claim })));
    const markup = html(<FindingList findings={state.findings} />);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('href=');
    expect(markup).toContain('click');
  });
});

describe('conventions', () => {
  const root = join(__dirname, '../../../src/client');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );

  it('imports server code type-only and uses no CopilotKit hooks', () => {
    const imports = /^import\s[^;]*?from\s+'([^']+)';/gms;
    for (const file of files(join(root, 'nemodots'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(imports))
        if (/\/server\//.test(match[1]))
          expect(match[0], file).toMatch(/^import type\s/);
      expect(source, file).not.toMatch(/@copilotkit/);
      expect(source, file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('keeps nemodots.css to hex colours with a balanced fixed-theme block', () => {
    const css = readFileSync(join(root, 'nemodots.css'), 'utf8');
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab)\(/);
    expect((css.match(/theme: fixed /g) ?? []).length).toBe(1);
    expect((css.match(/theme: end/g) ?? []).length).toBe(1);
    const out = postcss([darkTheme()]).process(css, { from: undefined }).css;
    expect(out).toContain(":root[data-theme='dark'] .nd-tone-ok");
    expect(out).not.toMatch(/:root\[data-theme='dark'\] \.nd-console/);
  });
});
