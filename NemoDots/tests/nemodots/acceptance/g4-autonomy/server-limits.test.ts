// TEST_PROMPT gate 4 case 2: depth, total tasks and permissions are enforced
// server-side. A scripted provider plays an over-eager model that tries to
// exceed every cap; the assertions read recorded server state and never trust
// model output. Breadth (fixed at 4) and inference concurrency have their own
// file (breadth-concurrency.test.ts) because the total-task cap used here binds
// first. Scripted replies prove enforcement only, not live inference (case 1
// and the live cases live in autonomy-live.test.ts).
//
// Hand-enumerated expectation with DEPTH_CAP=2 and TASK_CAP=7: 2 roots,
// DEEP-chain-1 and -2 accepted and -3 refused (depth), 3 of the 6 WIDE
// children accepted (total cap), the extra-capability and planner delegations
// refused (schema/role), so 7 tasks exist and at least 6 delegations fail.

import { describe, expect, it } from 'vitest';
import { treeShape } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { finish, lazySystem, launchMission } from './flow.js';
import type { ProviderCall, ProviderReply } from './provider.js';
import {
  type PlanTaskSpec,
  observeCall,
  planReply,
  receiptIdAt,
} from './scenarios.js';
import {
  SPEC_MAX_BREADTH,
  SPEC_ROLE_CAPABILITIES,
  specDigest,
} from './spec.js';
import { committedActionRows, readConfig } from './system.js';

const DEPTH_CAP = 2;
const TASK_CAP = 7;
const child1 = { digest: '0'.repeat(64), value: 5 as number };

const PLAN: PlanTaskSpec[] = [
  {
    title: 'DEEP-chain',
    question: 'DEEP-chain: look deeper step by step.',
    role: 'investigator',
  },
  {
    title: 'WIDE-fan',
    question: 'WIDE-fan: spread the checks out.',
    role: 'investigator',
  },
];

const delegate = (
  title: string,
  role: string,
  extra: Record<string, unknown> = {},
) => ({
  name: 'delegate_task',
  args: {
    title,
    role,
    question: `${title}: do the scoped check.`,
    dependsOn: [],
    justification: `${title} needs a separate scoped read`,
    ...extra,
  },
});

function chainLevel(call: ProviderCall) {
  const levels = [...call.text.matchAll(/DEEP-chain-(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  return levels.length ? Math.max(...levels) : 0;
}

const script = (call: ProviderCall): ProviderReply => {
  if (call.kind === 'structured') return planReply(PLAN);
  // order matters: child markers first, parents quote their own title only
  // a conversation that already delegated or waited is a parent, even though its
  // tool results may quote the children's titles
  const isParent = call.toolCallNames.some(
    (n) => n === 'delegate_task' || n === 'wait_for_children',
  );
  const child = isParent ? undefined : /WIDE-child-(\d)/.exec(call.text)?.[1];
  if (child) {
    // WIDE-child-1 is a cache_specialist child of an investigator parent, so its
    // capabilities are the intersection {observe, delegate, publish_finding}:
    // it can never propose. Its proposal is otherwise ADMISSIBLE by spec (the
    // target member and checkout.health are observed and cited, the digest is
    // the stored value's), so a block or rejection can only come from the
    // missing capability check.
    if (child === '1') {
      if (call.toolResults === 0)
        return observeCall('checkout.config/cache.schema_version');
      if (call.toolResults === 1) return observeCall('checkout.health');
      if (call.toolResults === 2)
        return {
          type: 'tool_calls',
          calls: [
            {
              name: 'propose_action',
              args: {
                action: 'set_config',
                payload: {
                  key: 'cache.schema_version',
                  value: child1.value,
                  expectedCurrentValueDigest: child1.digest,
                },
                supportingReceiptIds: [
                  receiptIdAt(call, 0),
                  receiptIdAt(call, 1),
                ].filter((id): id is string => Boolean(id)),
                rationale:
                  'WIDE-child-1 attempts a proposal it has no capability for',
              },
            },
          ],
        };
    }
    return { type: 'content', text: `WIDE-child-${child} complete.` };
  }
  if (call.text.includes('DEEP-chain')) {
    const level = chainLevel(call);
    if (call.toolResults === 0)
      return {
        type: 'tool_calls',
        calls: [delegate(`DEEP-chain-${level + 1}`, 'investigator')],
      };
    if (call.toolResults === 1)
      return {
        type: 'tool_calls',
        calls: [{ name: 'wait_for_children', args: {} }],
      };
    return { type: 'content', text: `DEEP-chain-${level} complete.` };
  }
  if (call.text.includes('WIDE-fan')) {
    if (call.toolResults === 0)
      return {
        type: 'tool_calls',
        calls: [1, 2, 3, 4, 5, 6].map((i) =>
          delegate(
            `WIDE-child-${i}`,
            i === 1 ? 'cache_specialist' : 'verifier',
          ),
        ),
      };
    if (call.toolResults === 1)
      return {
        type: 'tool_calls',
        calls: [
          // model-supplied capabilities must be rejected by the strict tool schema
          delegate('WIDE-extra-caps', 'verifier', {
            capabilities: ['propose_config_change'],
          }),
          // the planner role is not delegable
          delegate('WIDE-planner', 'planner'),
        ],
      };
    if (call.toolResults === 2)
      return {
        type: 'tool_calls',
        calls: [{ name: 'wait_for_children', args: {} }],
      };
    return { type: 'content', text: 'WIDE-fan complete.' };
  }
  return { type: 'content', text: 'nothing to do' };
};

const system = lazySystem({
  providerPort: G4.providerPort,
  script,
  system: {
    env: {
      NEMODOTS_MAX_DEPTH: String(DEPTH_CAP),
      NEMODOTS_MAX_TASKS: String(TASK_CAP),
      NEMODOTS_LEASE_MS: '8000',
    },
  },
});

const SETTLED = ['succeeded', 'failed', 'cancelled', 'invalidated'];
let memo: ReturnType<typeof run> | null = null;
const scenario = () => (memo ??= run());

async function run() {
  const { system: sys } = await system();
  const current = await readConfig(sys, 'cache.schema_version');
  child1.digest = specDigest(current.value);
  child1.value = Number(current.value) === 5 ? 6 : 5;
  const { mission, tail } = await launchMission(sys.api);
  try {
    const snapshot = await waitForMission(
      sys.api,
      mission.id,
      (s) =>
        s.tasks.length >= 2 &&
        s.tasks.some((t) => t.title === 'WIDE-child-1') &&
        s.tasks.every((t) => SETTLED.includes(t.status)),
      240_000,
      'all tasks settled',
    );
    return { sys, mission, tail, snapshot };
  } catch (error) {
    await finish(sys.api, mission.id, tail);
    throw error;
  }
}

describe('G4.2 server-side caps and permissions (scripted over-eager model)', () => {
  it('G4.2a depth and total-task caps hold, the spec breadth is 4, and every refused delegation is accounted for', async () => {
    const { mission, tail, snapshot } = await scenario();
    expect(mission.budgets.maxDepth, 'server resolved NEMODOTS_MAX_DEPTH').toBe(
      DEPTH_CAP,
    );
    expect(mission.budgets.maxTasks, 'server resolved NEMODOTS_MAX_TASKS').toBe(
      TASK_CAP,
    );
    expect(
      mission.budgets.maxBreadth,
      'ARCHITECTURE section 11 fixes breadth at 4, whatever the server chose',
    ).toBe(SPEC_MAX_BREADTH);
    expect(mission.budgets.maxWallClockMs).toBeGreaterThan(0);
    const shape = treeShape(snapshot);
    expect(shape.maxDepth, 'deepest task').toBe(DEPTH_CAP);
    expect(shape.maxBreadth, 'children per parent').toBeLessThanOrEqual(
      SPEC_MAX_BREADTH,
    );
    expect(
      shape.total,
      'the total-task cap was reached, and not exceeded',
    ).toBe(TASK_CAP);

    const attempted = tail
      .of('tool_call.recorded')
      .filter((e) => e.payload.name === 'delegate_task');
    const accepted = snapshot.tasks.filter((t) => t.parentId !== null).length;
    const rejected = attempted.filter((e) => !e.payload.ok).length;
    expect(
      attempted.length,
      'every delegation attempt is recorded exactly once',
    ).toBe(accepted + rejected);
    expect(
      rejected,
      'depth, total, extra-capability and planner delegations are refused',
    ).toBeGreaterThanOrEqual(6);
    expect(
      snapshot.tasks.some(
        (t) => t.title === 'WIDE-extra-caps' || t.title === 'WIDE-planner',
      ),
      'neither the over-privileged nor the planner delegation became a task',
    ).toBe(false);
  }, 360_000);

  it('G4.2b children never exceed role or parent capabilities (spec table) and carry a justification', async () => {
    const { snapshot } = await scenario();
    const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
    for (const task of snapshot.tasks) {
      const allowed = SPEC_ROLE_CAPABILITIES[task.role] as readonly string[];
      expect(allowed, `known role ${task.role}`).toBeDefined();
      expect(
        task.capabilities.every((c) => allowed.includes(c)),
        `${task.title} within role ${task.role}`,
      ).toBe(true);
      if (task.parentId) {
        const parent = byId.get(task.parentId)!;
        expect(
          task.capabilities.every((c) => parent.capabilities.includes(c)),
          `${task.title} within parent ${parent.title}`,
        ).toBe(true);
        expect(task.depth, 'child depth is parent depth + 1').toBe(
          parent.depth + 1,
        );
        expect(
          (task.justification ?? '').length,
          `${task.title} justification`,
        ).toBeGreaterThan(0);
        if (parent.role === 'investigator' && task.role === 'cache_specialist')
          expect(
            task.capabilities,
            'propose rights are not granted by an investigator parent',
          ).not.toContain('propose_config_change');
      }
    }
    expect(
      snapshot.tasks.some(
        (t) => t.title === 'WIDE-child-1' && t.role === 'cache_specialist',
      ),
      'the cache_specialist child exists',
    ).toBe(true);
  }, 360_000);

  it('G4.2c an otherwise admissible proposal from a child without the capability is denied, not merely incomplete', async () => {
    const { sys, tail, snapshot } = await scenario();
    const child = snapshot.tasks.find((t) => t.title === 'WIDE-child-1')!;
    const attemptIds = new Set(
      snapshot.attempts.filter((a) => a.taskId === child.id).map((a) => a.id),
    );
    const proposeCalls = tail
      .of('tool_call.recorded')
      .filter(
        (e) =>
          e.payload.name === 'propose_action' &&
          attemptIds.has(e.payload.attemptId),
      );
    expect(
      proposeCalls.length,
      'NOT_MET if the child never reached its proposal (its two observations failed)',
    ).toBeGreaterThanOrEqual(1);
    const intents = snapshot.actions.filter((a) => a.taskId === child.id);
    if (intents.length === 0) {
      expect(
        proposeCalls.every((e) => !e.payload.ok),
        'no intent was created, so every propose_action call is a recorded failure',
      ).toBe(true);
    } else {
      expect(intents, 'one intent at most').toHaveLength(1);
      expect(intents[0].status).toBe('blocked');
      expect(
        intents[0].blockReason,
        'the block is the capability check, not an incidental payload or evidence problem',
      ).toBe('capability_denied');
    }
    expect(
      await committedActionRows(sys),
      'no controlled effect committed',
    ).toHaveLength(0);
    expect(tail.of('action.committed'), 'no commit events').toHaveLength(0);
    expect(
      snapshot.actions.filter((a) => a.taskId !== child.id),
      'no other task proposed anything',
    ).toHaveLength(0);
  }, 360_000);

  it('G4.2z cleanup', async () => {
    await finishLater();
  });
});

async function finishLater() {
  const s = memo ? await memo.catch(() => null) : null;
  if (s) await finish(s.sys.api, s.mission.id, s.tail);
}
