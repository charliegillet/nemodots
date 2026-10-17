// TEST_PROMPT gate 4 cases 5 and 6: kill and restart the coordinator and the
// worker process, rebuild from PostgreSQL, fencing and outbox, and two source
// changes landing while the worker is down. Real processes, real PostgreSQL,
// SIGKILL. The scripted provider only supplies model replies; the Redis-loss
// case is in redis-loss.test.ts. Resume bound: 60 s after restart
// (ACCEPTANCE_CONTRACT 4.1).
import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import {
  attemptsPerTask,
  fencingMonotonic,
  ofKind,
  repairsByInvalidation,
} from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { changeSource, finish, launchMission, lazySystem } from './flow.js';
import type { Provider, ProviderCall, ProviderReply } from './provider.js';
import {
  ALPHA,
  ALPHA_SOURCE,
  BRAVO,
  BRAVO_SOURCE,
  CHARLIE,
  compose,
  lastReceiptId,
  observeThenReport,
  planReply,
  toolMessageTexts,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import { committedActionRows, readConfig, type System } from './system.js';

const state = { proposeValue: 5, proposeMode: false };

function alphaPropose(call: ProviderCall): ProviderReply | null {
  if (
    !state.proposeMode ||
    !call.text.includes(ALPHA) ||
    call.text.includes(CHARLIE)
  )
    return null;
  if (call.toolResults === 0)
    return {
      type: 'tool_calls',
      calls: [{ name: 'observe_source', args: { sourceKey: ALPHA_SOURCE } }],
    };
  if (call.toolResults === 1) {
    const hex = toolMessageTexts(call)
      .join(' ')
      .match(/\b[0-9a-f]{64}\b/)?.[0];
    const receipt = lastReceiptId(call);
    return {
      type: 'tool_calls',
      calls: [
        {
          name: 'propose_action',
          args: {
            action: 'set_config',
            payload: {
              key: 'cache.schema_version',
              value: state.proposeValue,
              expectedCurrentValueDigest: hex ?? digest(state.proposeValue),
            },
            supportingReceiptIds: receipt ? [receipt] : [],
            rationale: `${ALPHA} proposes the schema version it observed to be wrong.`,
          },
        },
      ],
    };
  }
  return { type: 'content', text: `${ALPHA} complete.` };
}

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    alphaPropose,
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
    observeThenReport(ALPHA, ALPHA_SOURCE),
  ),
  system: {
    separateWorker: true,
    env: { NEMODOTS_LEASE_MS: '6000', NEMODOTS_DISPATCH_LEASE_MS: '6000' },
  },
});

const alphaFirstThink = (c: ProviderCall) =>
  c.kind === 'worker' &&
  c.text.includes(ALPHA) &&
  !c.text.includes(CHARLIE) &&
  c.toolResults === 1;

const taskId = (
  tail: { events: Parameters<typeof ofKind>[0] },
  title: string,
) =>
  ofKind(tail.events, 'task.created').find(
    (e) => e.payload.task.title === title,
  )?.payload.task.id as string | undefined;

async function holdAlphaMidAttempt(sys: System, provider: Provider) {
  state.proposeMode = false;
  const gate = provider.gate(alphaFirstThink);
  const { mission, tail } = await launchMission(sys.api);
  await gate.arrived;
  await tail.until(
    (e) => {
      const id = taskId({ events: e }, BRAVO);
      return (
        Boolean(id) &&
        ofKind(e, 'task.status').some(
          (x) => x.payload.taskId === id && x.payload.to === 'succeeded',
        )
      );
    },
    120_000,
    'BRAVO succeeded before the crash',
  );
  return { mission, tail, gate };
}

describe('G4.5 kill and restart, rebuild from PostgreSQL, fencing and outbox', () => {
  it('G4.5a SIGKILL of worker-main mid-attempt: state survives, a fenced successor attempt finishes, no re-execution of finished work', async () => {
    const { system: sys, provider } = await system();
    const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
    try {
      const before = await sys.api.snapshot(mission.id);
      const alphaId = taskId(tail, ALPHA)!;
      const bravoId = taskId(tail, BRAVO)!;
      const a1 = before.attempts.find((a) => a.taskId === alphaId)!;
      expect(a1.status, 'ALPHA attempt 1 is mid-flight').toBe('running');
      const bravoCallsBefore = ofKind(
        tail.events,
        'model_call.recorded',
      ).filter((e) => e.payload.taskId === bravoId).length;
      const bravoOutput = before.outputs.find((o) => o.taskId === bravoId)!;
      expect(bravoOutput, 'BRAVO published before the crash').toBeDefined();

      await sys.worker!.kill('SIGKILL');
      // the coordinator API still serves the authoritative state while the worker is down
      const mid = await sys.api.snapshot(mission.id);
      expect(mid.tasks.map((t) => t.id).sort()).toEqual(
        before.tasks.map((t) => t.id).sort(),
      );
      expect(mid.outputs.find((o) => o.taskId === bravoId)?.digest).toBe(
        bravoOutput.digest,
      );
      gate.release();

      const restartedAt = Date.now();
      await sys.startWorker();
      const after = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.attempts.some(
            (a) => a.taskId === alphaId && a.n >= 2 && a.status === 'published',
          ),
        90_000,
        'ALPHA successor attempt published after the worker restart',
      );
      expect(
        Date.now() - restartedAt,
        'resume bound after restart',
      ).toBeLessThan(60_000 + 6_000);
      const old = after.attempts.find((a) => a.id === a1.id)!;
      expect(
        ['expired', 'aborted', 'failed', 'invalidated'],
        'the killed attempt is closed, never published',
      ).toContain(old.status);
      if (old.status === 'aborted') expect(old.abortReason).toBe('lease_lost');
      expect(
        after.outputs.filter((o) => o.attemptId === a1.id),
        'a dead worker publishes nothing',
      ).toHaveLength(0);
      const successor = after.attempts.find(
        (a) => a.taskId === alphaId && a.n >= 2,
      )!;
      expect(
        successor.lease.fencingToken,
        'strictly newer fence',
      ).toBeGreaterThan(a1.lease.fencingToken);
      expect(fencingMonotonic(after)).toBe(true);
      expect(
        after.attempts.filter((a) => a.taskId === bravoId),
        'finished branch not re-executed',
      ).toHaveLength(1);
      const bravoCallsAfter = ofKind(tail.events, 'model_call.recorded').filter(
        (e) => e.payload.taskId === bravoId,
      ).length;
      expect(bravoCallsAfter).toBe(bravoCallsBefore);
      for (const [id, count] of attemptsPerTask(after))
        expect(count, `attempts of ${id}`).toBeLessThanOrEqual(4);
      for (const task of after.tasks)
        expect(
          after.attempts.filter(
            (a) =>
              a.taskId === task.id && a.status === 'published' && !a.repairOf,
          ).length,
        ).toBeLessThanOrEqual(1);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);

  it('G4.5b SIGKILL of the whole app and worker: mission, tasks and durable events are rebuilt from PostgreSQL', async () => {
    const { system: sys, provider } = await system();
    const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
    try {
      const before = await sys.api.snapshot(mission.id);
      const lastId = tail.last;
      const idsBefore = tail.events.map((e) => e.id);
      await sys.worker!.kill('SIGKILL');
      gate.release();
      await tail.stop();
      await sys.restartApp();
      const reopened = await sys.api.snapshot(mission.id);
      expect(reopened.mission.id).toBe(mission.id);
      expect(reopened.tasks.map((t) => t.id).sort(), 'tasks rebuilt').toEqual(
        before.tasks.map((t) => t.id).sort(),
      );
      expect(
        reopened.outputs.map((o) => o.id).sort(),
        'published outputs rebuilt',
      ).toEqual(before.outputs.map((o) => o.id).sort());
      expect(
        reopened.receipts.length,
        'receipts rebuilt',
      ).toBeGreaterThanOrEqual(before.receipts.length);
      // Last-Event-ID replay: exactly the events after the cursor, no duplicates of earlier ids
      const resumed = sys.api.tail(mission.id, lastId).start();
      await sys.startWorker();
      try {
        await resumed.until(
          (e) => e.length > 0,
          30_000,
          'events after the cursor',
        );
        expect(
          resumed.events.every((e) => e.id > lastId),
          'resume returns only newer events',
        ).toBe(true);
        const full = sys.api.tail(mission.id, 0).start();
        await full.until(
          (e) => e.length >= idsBefore.length,
          30_000,
          'full durable replay',
        );
        expect(
          idsBefore.every((id) => full.events.some((e) => e.id === id)),
          'durable events survived the restart',
        ).toBe(true);
        expect(full.parseErrors).toEqual([]);
        await full.stop();
      } finally {
        await resumed.stop();
      }
      await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.tasks.some(
            (t) =>
              t.title === ALPHA && ['succeeded', 'failed'].includes(t.status),
          ),
        120_000,
        'ALPHA resolves after full restart',
      );
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 360_000);

  it('G4.5c worker killed inside the admission window: the outbox delivers the proposal exactly once', async () => {
    const { system: sys } = await system();
    const current = await readConfig(sys, 'cache.schema_version');
    state.proposeValue = Number(current.value) === 5 ? 6 : 5;
    state.proposeMode = true;
    const { mission, tail } = await launchMission(sys.api, {
      admissionMinAgeMs: 5_000,
    });
    try {
      await tail.until(
        (e) => e.some((x) => x.payload.kind === 'action.proposed'),
        120_000,
        'action.proposed',
      );
      await sys.worker!.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 1_000));
      await sys.startWorker();
      await tail.until(
        (e) =>
          e.some(
            (x) =>
              x.payload.kind === 'action.committed' ||
              (x.payload.kind === 'action.decided' &&
                x.payload.decision === 'blocked'),
          ),
        120_000,
        'a terminal admission outcome',
      );
      await new Promise((r) => setTimeout(r, 8_000)); // let any duplicate delivery show itself
      const snapshot = await sys.api.snapshot(mission.id);
      const proposed = ofKind(tail.events, 'action.proposed');
      expect(proposed, 'one proposal, not replayed by recovery').toHaveLength(
        1,
      );
      const actionId = proposed[0].payload.actionId;
      const commits = ofKind(tail.events, 'action.committed').filter(
        (e) => e.payload.actionId === actionId,
      );
      expect(
        commits.length,
        'at most one commit event for the action',
      ).toBeLessThanOrEqual(1);
      const rows = (await committedActionRows(sys)).filter(
        (r) => r.caused_by_action_id === actionId,
      );
      expect(
        rows.length,
        'history rows caused by the action equal commit events',
      ).toBe(commits.length);
      const results = snapshot.results.filter((r) => r.actionId === actionId);
      expect(results.length, 'one result receipt at most').toBeLessThanOrEqual(
        1,
      );
      const intent = snapshot.actions.find((a) => a.id === actionId)!;
      expect([
        'committed',
        'verified',
        'blocked',
        'dispatched',
        'outcome_unknown',
      ]).toContain(intent.status);
      if (commits.length === 1) {
        const live = await readConfig(sys, 'cache.schema_version');
        expect(live.value).toEqual(state.proposeValue);
        expect(live.version, 'exactly one version advance').toBe(
          current.version + 1,
        );
      } else {
        expect(
          intent.blockReason,
          'a recovery block must be explicit',
        ).not.toBeNull();
      }
    } finally {
      state.proposeMode = false;
      await finish(sys.api, mission.id, tail);
    }
  }, 360_000);
});

describe('G4.6 two source changes while recovery is pending', () => {
  it('G4.6a recovery stays bounded, never resurrects an old revision, and ignores the benign change', async () => {
    const { system: sys, provider } = await system();
    const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
    try {
      const alphaId = taskId(tail, ALPHA)!;
      const before = await sys.api.snapshot(mission.id);
      await sys.worker!.kill('SIGKILL');
      // two changes of the evidence the stranded attempt read, plus an unrelated owner banner edit
      const first = await changeSource(sys, 'cache.schema_version');
      const second = await changeSource(sys, 'cache.schema_version');
      const benign = await changeSource(sys, 'ui.banner_text');
      expect(second.result.version).toBeGreaterThan(first.result.version);
      expect(benign.result.version).toBeGreaterThan(benign.before.version);
      gate.release();
      await tail.until(
        (e) =>
          ofKind(e, 'receipt.registered').filter(
            (x) => x.payload.sourceKey === ALPHA_SOURCE,
          ).length >= 2,
        30_000,
        'the app registers both new revisions while the worker is down',
      );
      await sys.startWorker();
      await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.attempts.some(
            (a) => a.taskId === alphaId && a.status === 'published' && a.n >= 2,
          ),
        120_000,
        'ALPHA recovered',
      );
      await new Promise((r) => setTimeout(r, 10_000)); // a repair storm would show itself here
      const snapshot = await sys.api.snapshot(mission.id);

      const events = ofKind(tail.events, 'invalidation.recorded');
      const perRevision = new Map<string, number>();
      for (const e of events) {
        const key = `${e.payload.sourceKey}|${e.payload.oldReceiptId}`;
        perRevision.set(key, (perRevision.get(key) ?? 0) + 1);
      }
      for (const [key, count] of perRevision)
        expect(count, `invalidation events for ${key}`).toBe(1);
      expect(
        events.filter(
          (e) => e.payload.sourceKey === 'checkout.config/ui.banner_text',
        ),
        'benign change invalidates nothing',
      ).toHaveLength(0);
      expect(
        events.every(
          (e) =>
            !(e.payload.affected.taskIds as string[]).includes(
              taskId(tail, BRAVO)!,
            ),
        ),
        'independent branch untouched',
      ).toBe(true);
      for (const [key, count] of repairsByInvalidation(snapshot))
        expect(count, `repairs for ${key}`).toBeLessThanOrEqual(1);
      for (const [id, count] of attemptsPerTask(snapshot))
        expect(count, `attempts of task ${id}`).toBeLessThanOrEqual(4);
      expect(
        provider.calls.length,
        'total model calls in the trial',
      ).toBeLessThanOrEqual(120);

      const bySource = new Map<string, typeof snapshot.receipts>();
      for (const r of snapshot.receipts)
        bySource.set(r.source.key, [...(bySource.get(r.source.key) ?? []), r]);
      for (const [key, receipts] of bySource) {
        const current = receipts.filter(
          (r) => r.supersededBy === null && r.status === 'supported',
        );
        expect(
          current.length,
          `exactly one current receipt for ${key}`,
        ).toBeLessThanOrEqual(1);
        const top = Math.max(...receipts.map((r) => r.sourceRevision));
        for (const r of current)
          expect(
            r.sourceRevision,
            `current receipt for ${key} is the newest revision`,
          ).toBe(top);
      }
      const superseded = new Set(
        snapshot.receipts
          .filter((r) => r.supersededBy !== null)
          .map((r) => r.id as string),
      );
      for (const f of snapshot.findings.filter((x) => x.usable))
        expect(
          (f.supportingReceiptIds as string[]).filter((id) =>
            superseded.has(id),
          ),
          'no usable finding on a superseded receipt',
        ).toEqual([]);
      for (const o of snapshot.outputs.filter((x) => x.usable))
        expect(
          o.dependencyVector.filter((d) => superseded.has(d.receiptId)),
          'no usable output on a superseded receipt',
        ).toEqual([]);
      expect(before.mission.id).toBe(snapshot.mission.id);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 420_000);
});
