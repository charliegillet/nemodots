// W6.3 demo adversary: what the evaluation's "preserved work" number measures.
// EVALUATION.md 6 defines it as "succeeded tasks whose outputs are still usable
// at mission end (D8)" and the tables label it "preserved work"; the
// broad-restart arm documents "preserved work is zero by design"
// (evals/strategies/broad-restart.ts). A reader compares it across arms as work
// that survived a change without being redone. These checks build synthetic
// observations by hand (no product fixture) and re-read the recorded trials.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreEfficiency } from '../../../../src/server/nemodots/evals/scoring.js';
import type { Observations } from '../../../../src/server/nemodots/evals/observations.js';
import { parseManifest } from '../../../../src/server/nemodots/sandbox/manifest.js';
import { APP_ROOT, SCENARIO_DIR, type Json } from './support.js';

const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const MANIFEST = parseManifest(
  readFileSync(path.join(SCENARIO_DIR, 'cache_schema_mismatch.json'), 'utf8'),
);

/**
 * One invalidation at t=30 s.
 *   kept      published at t=10, never touched again          -> preserved
 *   redone    published at t=10, repaired at t=31..40         -> re-executed
 *   newcomer  created by the replan, first attempt at t=45    -> new work
 *   planner   planned at t=1, replanned at t=31               -> re-executed
 */
function observations(): Observations {
  const task = (id: string, role: string, attemptCount: number) => ({
    id,
    parentId: null,
    role,
    status: 'succeeded',
    prerequisites: [],
    outputId: `out-${id}`,
    outputUsable: true,
    attemptCount,
  });
  const attempt = (
    id: string,
    taskId: string,
    kind: string,
    start: number,
    end: number,
  ) => ({
    id,
    taskId,
    kind,
    status: 'published',
    repairOfEventId: kind === 'initial' ? null : 'event-1',
    startedAt: at(start),
    finishedAt: at(end),
  });
  return {
    missionId: 'mission-1',
    missionStatus: 'succeeded',
    startedAt: at(0),
    endedAt: at(60),
    tasks: [
      task('planner', 'planner', 2),
      task('kept', 'investigator', 1),
      task('redone', 'investigator', 2),
      task('newcomer', 'investigator', 1),
    ],
    attempts: [
      attempt('p1', 'planner', 'initial', 0, 1),
      attempt('k1', 'kept', 'initial', 2, 10),
      attempt('r1', 'redone', 'initial', 2, 10),
      attempt('p2', 'planner', 'replan', 31, 32),
      attempt('r2', 'redone', 'repair', 31, 40),
      attempt('n1', 'newcomer', 'initial', 45, 50),
    ],
    nodes: [
      { kind: 'receipt', id: 'rcpt-old', missionId: null, taskId: null },
      { kind: 'attempt', id: 'r1', missionId: 'mission-1', taskId: 'redone' },
      { kind: 'attempt', id: 'k1', missionId: 'mission-1', taskId: 'kept' },
    ],
    edges: [
      {
        kind: 'evidence',
        fromKind: 'receipt',
        fromId: 'rcpt-old',
        toKind: 'attempt',
        toId: 'r1',
        createdAt: at(5),
      },
    ],
    invalidations: [
      {
        id: 'event-1',
        sourceKey: 'checkout.metrics',
        reason: 'newer_observation',
        selfWrite: 'none',
        oldReceiptId: 'rcpt-old',
        newReceiptId: 'rcpt-new',
        createdAt: at(30),
        affected: {
          modelCallIds: [],
          attemptIds: ['r1'],
          outputIds: ['out-redone'],
          actionIds: [],
          taskIds: ['redone'],
        },
        capped: false,
      },
    ],
    intents: [],
    authorizations: [],
    results: [],
    configHistory: [],
    telemetry: {
      calls: 10,
      promptTokens: 1000,
      completionTokens: 100,
      cachedTokens: null,
      retries: 0,
      errors: 0,
      providerMismatches: 0,
      fixtureCalls: 0,
    },
    timing: {
      setupMs: null,
      inferenceMs: null,
      toolMs: null,
      recoveryMs: null,
      completionMs: null,
    },
    independent: { probe: 'pass', failedInvariants: [], healthOk: true },
    arm: { recoveryScopeRule: 'selective', contextLayouts: ['cache_aware'] },
  };
}

/** Work that existed before the first change and was not redone (independent reading). */
function preservedAcrossChange(obs: Observations): string[] {
  const first = Math.min(
    ...obs.invalidations.map((event) => Date.parse(event.createdAt)),
  );
  return obs.tasks
    .filter((task) => task.status === 'succeeded' && task.outputUsable)
    .filter((task) => {
      const attempts = obs.attempts.filter((a) => a.taskId === task.id);
      return (
        attempts.length > 0 &&
        attempts.every(
          (a) =>
            a.kind === 'initial' &&
            Date.parse(a.startedAt) < first &&
            a.finishedAt !== null &&
            Date.parse(a.finishedAt) <= first,
        )
      );
    })
    .map((task) => task.id);
}

describe('DA-03: "preserved work" counts re-executed and newly created tasks', () => {
  it('the independent reading of the synthetic trial preserves exactly one task', () => {
    expect(preservedAcrossChange(observations())).toEqual(['kept']);
  });

  it('the evaluation reports preserved work equal to the work that survived the change', () => {
    const score = scoreEfficiency(MANIFEST, observations());
    // repeatedWork and restartedTasks see the re-execution ...
    expect(score.restartedTasks).toBe(2);
    // ... but preserved work counts the repaired task, the replanned planner
    // and the task the replan created: 4 instead of 1.
    expect(score.preservedWork).toBe(
      preservedAcrossChange(observations()).length,
    );
  });
});

// The two recorded smoke trials (gitignored raw files). They are the only
// scored live trials; the matched cohort is NOT_RUN.
const RESULTS = path.join(APP_ROOT, 'evals/nemodots/results');
const recorded: { cohort: string; trial: Json }[] = existsSync(RESULTS)
  ? readdirSync(RESULTS)
      .filter((name) => existsSync(path.join(RESULTS, name, 'trials.jsonl')))
      .flatMap((cohort) =>
        readFileSync(path.join(RESULTS, cohort, 'trials.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => ({ cohort, trial: JSON.parse(line) as Json })),
      )
      .filter(
        ({ trial }) =>
          trial.score && trial.observations?.invalidations?.length > 0,
      )
  : [];

describe.runIf(recorded.length > 0)(
  'DA-03 on the recorded trials (evals/nemodots/results)',
  () => {
    it.each(recorded.map((r) => [r.cohort.slice(0, 8), r]))(
      'cohort %s: reported preserved work equals the work that survived the first change',
      (_cohort, { trial }) => {
        const obs = trial.observations as Observations;
        const reported = trial.score.efficiency.preservedWork as number;
        const survived = preservedAcrossChange(obs);
        // recorded 2026-10-18, cohort aa11a78b: reported 9, survived 1 (one
        // investigator; the planner was replanned twice and 7 of the 9 were
        // created by the replans after the first invalidation)
        expect({ reported, survived: survived.length }).toEqual({
          reported: survived.length,
          survived: survived.length,
        });
      },
    );

    it.each(recorded.map((r) => [r.cohort.slice(0, 8), r]))(
      'cohort %s: every task counted as preserved rests on receipts that were current at mission end',
      (_cohort, { trial }) => {
        const obs = trial.observations as Observations;
        const superseded = new Set(
          obs.invalidations.map((e) => e.oldReceiptId),
        );
        const into = new Map<string, typeof obs.edges>();
        for (const edge of obs.edges)
          into.set(edge.toId, [...(into.get(edge.toId) ?? []), edge]);
        const receiptsOf = (id: string, seen = new Set<string>()) => {
          const found = new Set<string>();
          for (const edge of into.get(id) ?? []) {
            if (edge.fromKind === 'receipt') found.add(edge.fromId);
            else if (!seen.has(edge.fromId)) {
              seen.add(edge.fromId);
              for (const r of receiptsOf(edge.fromId, seen)) found.add(r);
            }
          }
          return found;
        };
        const stale = obs.tasks
          .filter(
            (t) => t.status === 'succeeded' && t.outputUsable && t.outputId,
          )
          .flatMap((t) =>
            [...receiptsOf(t.outputId!)]
              .filter((r) => superseded.has(r))
              .map((r) => `${t.id}:${r}`),
          );
        expect(stale).toEqual([]);
      },
    );
  },
);
