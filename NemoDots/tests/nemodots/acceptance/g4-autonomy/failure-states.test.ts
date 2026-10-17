// TEST_PROMPT gate 4 case 7: malformed tool JSON, refusal, timeout, rate
// limit and exhausted budget must end in explicit failure or blocking states,
// never a fabricated success, a stuck running attempt or an unbounded retry
// loop. The scripted provider injects each provider behaviour; nothing here
// claims live-model behaviour.
import { describe, expect, it } from 'vitest';
import { ofKind } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { finish, launchMission, lazySystem } from './flow.js';
import type { ProviderCall, ProviderReply, ProviderScript } from './provider.js';
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
  TWO_BRANCH_PLAN,
} from './scenarios.js';

const state = { script: null as ProviderScript | null, maxTokens: 0 };
const ok = compose(
  planReply(TWO_BRANCH_PLAN),
  observeThenReport(CHARLIE, 'checkout.health'),
  observeThenReport(BRAVO, BRAVO_SOURCE),
  observeThenReport(ALPHA, ALPHA_SOURCE),
);
const system = lazySystem({
  providerPort: G4.providerPort,
  script: (call) => (state.script ?? ok)(call),
  system: { env: { NEMODOTS_INFERENCE_TIMEOUT_MS: '3000', NEMODOTS_LEASE_MS: '15000' } },
});

const alphaCall = (c: ProviderCall) => c.kind === 'worker' && c.text.includes(ALPHA) && !c.text.includes(CHARLIE);
const MALFORMED: ProviderReply = {
  type: 'tool_calls',
  calls: [{ name: 'observe_source', args: null, rawArguments: '{"sourceKey": "checkout.config/cache.schema' }],
};

async function runUntilSettled(timeoutMs: number, options: { beforeStart?: (id: string, maxTokens: number) => void } = {}) {
  const { system: sys, provider } = await system();
  const { mission, tail } = await launchMission(sys.api, { start: false });
  options.beforeStart?.(mission.id, mission.budgets.maxTokens);
  const startIndex = provider.calls.length;
  await sys.api.lifecycle(mission.id, 'start');
  const snapshot = await waitForMission(
    sys.api,
    mission.id,
    (s) => ['failed', 'blocked_provider', 'cancelled', 'succeeded', 'awaiting_acceptance'].includes(s.mission.status) || s.tasks.some((t) => t.status === 'failed'),
    timeoutMs,
    'an explicit settled or failed state',
  );
  return { sys, provider, mission, tail, snapshot, startIndex };
}

describe('G4.7 provider and model failure states (scripted)', () => {
  it('G4.7a malformed tool JSON is rejected, recorded, and the loop recovers or fails explicitly', async () => {
    state.script = compose(
      planReply(TWO_BRANCH_PLAN),
      observeThenReport(CHARLIE, 'checkout.health'),
      observeThenReport(BRAVO, BRAVO_SOURCE),
      (call) => {
        if (!alphaCall(call)) return null;
        if (call.toolResults === 0) return MALFORMED;
        if (call.toolResults === 1) return { type: 'tool_calls', calls: [{ name: 'observe_source', args: { sourceKey: ALPHA_SOURCE } }] };
        if (call.toolResults === 2) return { type: 'tool_calls', calls: [{ name: 'publish_finding', args: { claim: `${ALPHA} recovered.`, supportingReceiptIds: lastReceiptId(call) ? [lastReceiptId(call)!] : [], confidence: 'low' } }] };
        return { type: 'content', text: `${ALPHA} complete.` };
      },
    );
    const { sys, mission, tail } = await runUntilSettled(180_000);
    try {
      const recorded = tail.of('tool_call.recorded').filter((e) => e.payload.name === 'observe_source');
      const modelCalls = tail.of('model_call.recorded');
      const rejectedExplicitly =
        recorded.some((e) => !e.payload.ok) || modelCalls.some((e) => e.payload.outcome === 'invalid_output');
      expect(rejectedExplicitly, 'the truncated JSON is a recorded rejection, not a silent success').toBe(true);
      expect(
        recorded.filter((e) => e.payload.ok && e.payload.receiptId === null),
        'a successful observation always carries a receipt',
      ).toEqual([]);
      const snapshot = await waitForMission(sys.api, mission.id, (s) => s.tasks.filter((t) => t.title === ALPHA).every((t) => ['succeeded', 'failed'].includes(t.status)), 180_000, 'ALPHA resolved');
      const alpha = snapshot.tasks.find((t) => t.title === ALPHA)!;
      if (alpha.status === 'failed')
        expect(ofKind(tail.events, 'task.status').find((e) => e.payload.taskId === alpha.id && e.payload.to === 'failed')?.payload.reason, 'explicit failure reason').toBeTruthy();
      expect((await sys.api.health()).postgres, 'service stayed healthy').toBe('ok');
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);

  it('G4.7b always-malformed output ends in a bounded explicit task failure, never success', async () => {
    state.script = compose(
      planReply(TWO_BRANCH_PLAN),
      observeThenReport(CHARLIE, 'checkout.health'),
      observeThenReport(BRAVO, BRAVO_SOURCE),
      (call) => (alphaCall(call) ? MALFORMED : null),
    );
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(240_000);
    try {
      const snapshot = await waitForMission(sys.api, mission.id, (s) => s.tasks.find((t) => t.title === ALPHA)?.status === 'failed', 240_000, 'ALPHA failed');
      const alpha = snapshot.tasks.find((t) => t.title === ALPHA)!;
      expect(snapshot.mission.status, 'a failed branch is never reported as mission success').not.toBe('succeeded');
      expect(alpha.attemptCount, 'bounded attempts').toBeLessThanOrEqual(4);
      expect(snapshot.outputs.filter((o) => o.taskId === alpha.id && o.usable), 'no usable output is invented').toHaveLength(0);
      expect(snapshot.findings.filter((f) => f.taskId === alpha.id && f.usable), 'no finding is invented').toHaveLength(0);
      expect(provider.calls.length - startIndex, 'bounded model calls').toBeLessThanOrEqual(120);
      expect(ofKind(tail.events, 'task.status').find((e) => e.payload.taskId === alpha.id && e.payload.to === 'failed')?.payload.reason).toBeTruthy();
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 360_000);

  it('G4.7c a refusal from the planner fails the mission with a reason and fabricates no plan', async () => {
    state.script = (call) => (call.kind === 'structured' ? { type: 'refusal', text: 'I cannot help with that.' } : { type: 'content', text: 'unused' });
    const { sys, mission, tail, snapshot } = await runUntilSettled(180_000);
    try {
      const final = await waitForMission(sys.api, mission.id, (s) => ['failed', 'blocked_provider'].includes(s.mission.status), 120_000, 'mission failed or blocked');
      expect(final.tasks, 'no tasks are made up from a refusal').toHaveLength(0);
      expect(final.mission.failureReason ?? ofKind(tail.events, 'mission.status').at(-1)?.payload.reason, 'explicit reason').toBeTruthy();
      expect(snapshot.mission.status).not.toBe('succeeded');
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);

  it('G4.7d invalid plan JSON gets exactly one bounded correction turn, then failed(invalid_plan)', async () => {
    state.script = (call) => (call.kind === 'structured' ? { type: 'content', text: 'definitely not json {' } : { type: 'content', text: 'unused' });
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(180_000);
    try {
      const final = await waitForMission(sys.api, mission.id, (s) => s.mission.status === 'failed', 120_000, 'mission failed');
      expect(final.mission.failureReason ?? '', 'names the plan problem').toMatch(/plan/i);
      const structured = provider.calls.slice(startIndex).filter((c) => c.kind === 'structured');
      expect(structured.length, 'initial planner call plus exactly one correction').toBe(2);
      expect(final.tasks).toHaveLength(0);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);

  it('G4.7e provider timeout: bounded retries, then an explicit blocked_provider or failed state', async () => {
    state.script = (call) => (call.kind === 'structured' ? { type: 'hang', ms: 120_000 } : { type: 'content', text: 'unused' });
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(400_000);
    try {
      const final = await waitForMission(sys.api, mission.id, (s) => ['blocked_provider', 'failed'].includes(s.mission.status), 400_000, 'blocked_provider or failed after timeouts');
      expect(final.mission.status).not.toBe('succeeded');
      const planner = provider.calls.slice(startIndex).filter((c) => c.kind === 'structured');
      expect(planner.length, 'at most 1 + 4 retries per logical call, one correction at most').toBeLessThanOrEqual(10);
      expect(final.mission.failureReason ?? ofKind(tail.events, 'mission.status').at(-1)?.payload.reason, 'explicit reason').toBeTruthy();
      expect(final.tasks.filter((t) => t.status === 'succeeded')).toHaveLength(0);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 480_000);

  it('G4.7f rate limiting (429): bounded backoff, then an explicit blocked_provider or failed state', async () => {
    state.script = (call) => (call.kind === 'structured' ? { type: 'http', status: 429, retryAfter: 1 } : { type: 'content', text: 'unused' });
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(300_000);
    try {
      const final = await waitForMission(sys.api, mission.id, (s) => ['blocked_provider', 'failed'].includes(s.mission.status), 300_000, 'blocked_provider or failed after 429s');
      const attempts = provider.calls.slice(startIndex).filter((c) => c.kind === 'structured');
      expect(attempts.length, 'retry bound').toBeLessThanOrEqual(10);
      expect(final.mission.status).not.toBe('succeeded');
      expect(final.mission.failureReason ?? ofKind(tail.events, 'mission.status').at(-1)?.payload.reason, 'explicit reason').toBeTruthy();
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 400_000);

  it('G4.7g exhausted token budget aborts with budget_exhausted and stops spending', async () => {
    state.script = compose(
      planReply(TWO_BRANCH_PLAN),
      (call) => {
        if (call.kind !== 'worker') return null;
        // every worker reply reports more usage than the whole mission may spend
        return {
          type: 'tool_calls',
          calls: [{ name: 'observe_source', args: { sourceKey: call.text.includes(BRAVO) ? BRAVO_SOURCE : ALPHA_SOURCE } }],
          usage: { prompt_tokens: state.maxTokens + 1, completion_tokens: 10 },
        };
      },
    );
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(240_000, {
      beforeStart: (_id, maxTokens) => {
        state.maxTokens = maxTokens;
      },
    });
    try {
      const final = await waitForMission(sys.api, mission.id, (s) => s.mission.status === 'failed' || s.attempts.some((a) => a.abortReason === 'budget_exhausted'), 240_000, 'budget exhaustion recorded');
      const exhausted = final.attempts.some((a) => a.abortReason === 'budget_exhausted');
      expect(exhausted || /budget/i.test(final.mission.failureReason ?? ''), 'budget exhaustion is explicit').toBe(true);
      await new Promise((r) => setTimeout(r, 6_000));
      const spent = provider.calls.slice(startIndex).filter((c) => c.kind === 'worker').length;
      expect(spent, 'no unbounded spending after exhaustion (<= 4 in flight plus the exhausting calls)').toBeLessThanOrEqual(12);
      expect(ofKind(tail.events, 'action.committed')).toHaveLength(0);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 360_000);

  it('G4.7h an endless tool loop is cut off by the iteration and inference-call budgets', async () => {
    state.script = compose(
      planReply(TWO_BRANCH_PLAN),
      (call) =>
        call.kind === 'worker'
          ? { type: 'tool_calls', calls: [{ name: 'observe_source', args: { sourceKey: ALPHA_SOURCE } }] }
          : null,
    );
    const { sys, provider, mission, tail, startIndex } = await runUntilSettled(240_000);
    try {
      await waitForMission(sys.api, mission.id, (s) => ['failed', 'blocked_provider'].includes(s.mission.status) || s.tasks.filter((t) => t.status === 'failed').length >= 2, 300_000, 'loops cut off');
      await new Promise((r) => setTimeout(r, 5_000));
      const total = provider.calls.length - startIndex;
      expect(total, 'bounded by mission.budgets.maxInferenceCalls plus in-flight').toBeLessThanOrEqual(mission.budgets.maxInferenceCalls + 4);
      const snapshot = await sys.api.snapshot(mission.id);
      for (const attempt of snapshot.attempts) {
        const calls = tail.of('model_call.recorded').filter((e) => e.payload.attemptId === attempt.id).length;
        expect(calls, `model calls in attempt n=${attempt.n}`).toBeLessThanOrEqual(12 + 1);
      }
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 400_000);
});
