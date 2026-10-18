// W6.3 demo adversary: what the RECORDED LIVE runs (Nemotron on Crusoe) show.
// The artifacts are gitignored and machine-local: .local/dev/live/*.json from
// the live mission suites and evals/nemodots/results/*/trials.jsonl from the
// evaluation smoke trials. Each block runs only when its artifact exists; the
// checks re-derive facts from the recorded rows and never call a provider.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, type Json } from './support.js';

const LIVE = path.join(APP_ROOT, '.local/dev/live');
const read = (file: string): Json | null =>
  existsSync(path.join(LIVE, file))
    ? JSON.parse(readFileSync(path.join(LIVE, file), 'utf8'))
    : null;

const changed = read('mission-changed-evidence.json');
const trace = read('team-trace.json');

describe.runIf(changed !== null)(
  'recorded live changed-evidence run (.local/dev/live/mission-changed-evidence.json)',
  () => {
    const check = (name: string) =>
      (changed!.checks as Json[]).find((c) => c.name === name);

    it('was a live Crusoe run (every model call on the configured host)', () => {
      expect(check('provider host and model on every call')).toMatchObject({
        status: 'PASS',
        observed: { host: 'api.inference.crusoecloud.com' },
      });
    });

    it('DA-07: observed either branch of the honest disjunction', () => {
      // recorded 2026-10-18 (live-fcd327): NOT_MET, outcome "neither"; the
      // dependent step was skipped with no_matching_proposal and the mission
      // was still running at 960 s.
      expect(check('honest disjunction')?.observed?.outcome).toMatch(/^[AB]$/);
    });

    it('DA-05 signature: the mission did not end with waiting parents holding the workers while their children were queued', () => {
      const diagnosis = check('mission finished')?.observed?.diagnosis;
      const tasks = (diagnosis?.tasks ?? []) as Json[];
      const waiting = tasks
        .filter((t) => t.status === 'waiting')
        .reduce((n, t) => n + t.n, 0);
      const queuedChildren = tasks
        .filter((t) => t.status === 'runnable' && t.role !== 'investigator')
        .reduce((n, t) => n + t.n, 0);
      const running = ((diagnosis?.attempts ?? []) as Json[])
        .filter((a) => a.status === 'running')
        .reduce((n, a) => n + a.n, 0);
      // recorded: 2 investigators waiting, 2 cache_specialists runnable,
      // 2 attempts running (= NEMODOTS_WORKERS default 2)
      const starved = running > 0 && waiting >= running && queuedChildren > 0;
      expect({ waiting, queuedChildren, running, starved }).toMatchObject({
        starved: false,
      });
    });
  },
);

describe.runIf(trace !== null)(
  'recorded live team trace (.local/dev/live/team-trace.json)',
  () => {
    it('DA-01 is not hypothetical: no model output names the forbidden routing value by citing the runbook riddle', () => {
      const decoded = (trace!.outputs as Json[]).filter((o) =>
        /first in rank/i.test(String(o.summary)),
      );
      expect(
        decoded.map((o) => `${o.role}: ${String(o.summary).slice(0, 160)}`),
      ).toEqual([]);
    });

    it('policy-induced delegation is visible in the trace: a refused proposal precedes the verifier delegation', () => {
      // Recorded: propose_action -> verification_required, then
      // delegate_task (verifier), wait_for_children, propose_action. Reported
      // here as a fact for DEMO_REVIEW (the refusal text scripts the steps).
      const byAttempt = new Map<string, string[]>();
      for (const tool of trace!.tools as Json[])
        byAttempt.set(tool.attemptId, [
          ...(byAttempt.get(tool.attemptId) ?? []),
          tool.ok ? tool.name : `${tool.name}!${tool.error ?? ''}`,
        ]);
      const scripted = [...byAttempt.values()].filter((seq) =>
        seq
          .join(' ')
          .includes('propose_action!verification_required delegate_task'),
      );
      expect(scripted.length).toBeGreaterThan(0);
    });
  },
);

const RESULTS = path.join(APP_ROOT, 'evals/nemodots/results');
const trials: { cohort: string; trial: Json }[] = existsSync(RESULTS)
  ? readdirSync(RESULTS)
      .filter((name) => existsSync(path.join(RESULTS, name, 'trials.jsonl')))
      .flatMap((cohort) =>
        readFileSync(path.join(RESULTS, cohort, 'trials.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => ({ cohort, trial: JSON.parse(line) as Json })),
      )
      .filter(({ trial }) => trial.mode === 'live' && trial.observations)
  : [];

describe.runIf(trials.length > 0)(
  'recorded live evaluation trials (evals/nemodots/results)',
  () => {
    it.each(trials.map((t) => [t.cohort.slice(0, 8), t]))(
      'DA-05 cohort %s: every delegated child started within 30 s of being created',
      (_cohort, { trial }) => {
        const obs = trial.observations;
        // a delegated task's creation time is the time of the evidence edge
        // its parent's vector wrote onto it at delegation
        const created = new Map<string, number>();
        for (const edge of obs.edges as Json[])
          if (edge.toKind === 'task') {
            const at = Date.parse(edge.createdAt);
            if (!created.has(edge.toId) || at < created.get(edge.toId)!)
              created.set(edge.toId, at);
          }
        const end = Date.parse(obs.endedAt ?? obs.startedAt);
        const late = (obs.tasks as Json[])
          .filter((t) => t.parentId && created.has(t.id))
          .map((t) => {
            const starts = (obs.attempts as Json[])
              .filter((a) => a.taskId === t.id)
              .map((a) => Date.parse(a.startedAt));
            const first = starts.length ? Math.min(...starts) : end;
            return {
              task: `${t.role} ${String(t.id).slice(0, 8)}`,
              waitedS: Math.round((first - created.get(t.id)!) / 1000),
              started: starts.length > 0,
            };
          })
          .filter((l) => l.waitedS > 30);
        // recorded aa11a78b: cache_specialist 371 s and 546 s, verifier 364 s
        // and 201 s; ab04d9d9: 394 s and 570 s, five children never started
        expect(late).toEqual([]);
      },
    );
  },
);
