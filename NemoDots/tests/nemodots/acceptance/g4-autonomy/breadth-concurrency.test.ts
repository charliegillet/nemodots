// TEST_PROMPT gate 4 case 2, the two limits server-limits.test.ts cannot
// reach: breadth and inference concurrency. The total-task cap is raised to 24
// here so that it cannot bind before breadth does (in server-limits.test.ts
// TASK_CAP=7 binds first). Expected numbers come from ARCHITECTURE section 11
// (breadth <= 4) and section 12 / CONTRACTS section 3 (at most 4 inference
// requests in flight per model), not from the mission the server returns.
//
// Hand-enumerated expectation: one investigator tries six children in a single
// response. Exactly 4 become tasks and exactly 2 are refused with a breadth
// reason. 8 workers and 8 simultaneously runnable tasks would put 8 requests in
// flight; the provider-side peak must stay at or below 4.
import { describe, expect, it } from 'vitest';
import { treeShape } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { finish, launchMission, lazySystem, notMet } from './flow.js';
import type { ProviderCall, ProviderReply } from './provider.js';
import { type PlanTaskSpec, observeCall, planReply } from './scenarios.js';
import { SPEC_MAX_BREADTH, SPEC_MAX_IN_FLIGHT } from './spec.js';

const REPLY_DELAY_MS = 1_500;
const seen = { delegateResults: [] as string[] };

const PLAN: PlanTaskSpec[] = [
  {
    title: 'BREADTH-fan',
    question: 'BREADTH-fan: split the work into six scoped checks.',
    role: 'investigator',
  },
  {
    title: 'BREADTH-side',
    question: 'BREADTH-side: read the health of the service.',
    role: 'verifier',
  },
];

const script = (call: ProviderCall): ProviderReply => {
  const slow = <T extends ProviderReply>(reply: T): T =>
    reply.type === 'content' || reply.type === 'tool_calls'
      ? { ...reply, delayMs: REPLY_DELAY_MS }
      : reply;
  if (call.kind === 'structured') return slow(planReply(PLAN));
  const isParent = call.toolCallNames.some(
    (n) => n === 'delegate_task' || n === 'wait_for_children',
  );
  const child = isParent
    ? undefined
    : /BREADTH-child-(\d)/.exec(call.text)?.[1];
  if (child)
    return slow({ type: 'content', text: `BREADTH-child-${child} complete.` });
  if (call.text.includes('BREADTH-fan')) {
    if (call.toolResults === 0)
      return slow({
        type: 'tool_calls',
        calls: [1, 2, 3, 4, 5, 6].map((i) => ({
          name: 'delegate_task',
          args: {
            title: `BREADTH-child-${i}`,
            role: 'verifier',
            question: `BREADTH-child-${i}: read the health of the service.`,
            dependsOn: [],
            justification: `BREADTH-child-${i} is one of six independent scoped reads`,
          },
        })),
      });
    if (call.toolResults >= 6 && call.toolResults < 7) {
      seen.delegateResults = call.toolMessages.map((m) =>
        typeof m === 'string' ? m : JSON.stringify(m),
      );
      return slow({
        type: 'tool_calls',
        calls: [{ name: 'wait_for_children', args: {} }],
      });
    }
    return slow({ type: 'content', text: 'BREADTH-fan complete.' });
  }
  if (call.text.includes('BREADTH-side')) {
    if (call.toolResults === 0) return slow(observeCall('checkout.health'));
    return slow({ type: 'content', text: 'BREADTH-side complete.' });
  }
  return slow({ type: 'content', text: 'nothing to do' });
};

const system = lazySystem({
  providerPort: G4.providerPort,
  script,
  system: {
    env: {
      NEMODOTS_MAX_TASKS: '24',
      NEMODOTS_MAX_DEPTH: '2',
      NEMODOTS_WORKERS: '8',
      NEMODOTS_LEASE_MS: '20000',
    },
  },
});

let memo: ReturnType<typeof run> | null = null;
const scenario = () => (memo ??= run());

async function run() {
  const { system: sys, provider } = await system();
  provider.resetPeak();
  const { mission, tail } = await launchMission(sys.api);
  try {
    const snapshot = await waitForMission(
      sys.api,
      mission.id,
      (s) =>
        s.tasks.filter((t) => t.parentId !== null).length >= 1 &&
        s.tasks.every((t) =>
          ['succeeded', 'failed', 'cancelled', 'invalidated'].includes(
            t.status,
          ),
        ),
      240_000,
      'all tasks settled',
    );
    return { sys, provider, mission, tail, snapshot, peak: provider.peakInFlight };
  } catch (error) {
    await finish(sys.api, mission.id, tail);
    throw error;
  }
}

describe('G4.2 breadth and inference concurrency (scripted, total-task cap cannot bind)', () => {
  it('G4.2d six attempted children yield exactly four tasks and two breadth refusals', async () => {
    const { mission, tail, snapshot } = await scenario();
    expect(mission.budgets.maxBreadth, 'spec breadth').toBe(SPEC_MAX_BREADTH);
    expect(mission.budgets.maxTasks, 'the total cap is out of the way').toBe(24);
    const fan = snapshot.tasks.find((t) => t.title === 'BREADTH-fan')!;
    const children = snapshot.tasks.filter((t) => t.parentId === fan.id);
    expect(children, 'exactly the spec breadth of children were accepted').toHaveLength(
      SPEC_MAX_BREADTH,
    );
    expect(treeShape(snapshot).total, 'far below the total cap').toBe(2 + SPEC_MAX_BREADTH);
    const fanAttempts = new Set(
      snapshot.attempts.filter((a) => a.taskId === fan.id).map((a) => a.id),
    );
    const delegations = tail
      .of('tool_call.recorded')
      .filter(
        (e) => e.payload.name === 'delegate_task' && fanAttempts.has(e.payload.attemptId),
      );
    expect(delegations, 'six attempts recorded').toHaveLength(6);
    expect(delegations.filter((e) => e.payload.ok)).toHaveLength(4);
    expect(delegations.filter((e) => !e.payload.ok)).toHaveLength(2);
    const reasons = seen.delegateResults.filter((text) =>
      /breadth|too many|children|limit|cap|maximum/i.test(text),
    );
    expect(
      reasons.length,
      'the two refusals tell the model why (breadth reason in the tool result)',
    ).toBeGreaterThanOrEqual(2);
    for (const child of children) {
      expect((child.justification ?? '').length).toBeGreaterThan(0);
      expect(child.depth).toBe(fan.depth + 1);
    }
  }, 360_000);

  it('G4.2e at most 4 inference requests are ever in flight, measured at the provider', async () => {
    const { peak, snapshot } = await scenario();
    if (peak < 3)
      notMet(
        `peak concurrency was only ${peak}: 8 workers and ${snapshot.tasks.length} tasks never overlapped, so the cap was not exercised`,
      );
    expect(peak, 'peak in-flight chat completions at the provider').toBeLessThanOrEqual(
      SPEC_MAX_IN_FLIGHT,
    );
  }, 360_000);

  it('G4.2z cleanup', async () => {
    const s = memo ? await memo.catch(() => null) : null;
    if (s) await finish(s.sys.api, s.mission.id, s.tail);
  });
});
