// TEST_PROMPT gate 4 case 2: depth, total tasks, breadth and budgets are
// enforced server-side and children cannot expand permissions. A scripted
// provider plays an over-eager model that tries to exceed every cap; the
// assertions read recorded server state and never trust model output.
// Scripted replies prove enforcement only, not live inference (case 1 and the
// live cases live in autonomy-live.test.ts).
import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES } from '../../../../src/server/nemodots/contracts/index.js';
import { treeShape } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { finish, lazySystem, launchMission } from './flow.js';
import type { ProviderCall, ProviderReply } from './provider.js';
import { type PlanTaskSpec, planReply } from './scenarios.js';
import { committedActionRows } from './system.js';

const DEPTH_CAP = 2;
const TASK_CAP = 7;

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
  const child = /WIDE-child-(\d)/.exec(call.text)?.[1];
  if (child) {
    if (call.toolResults === 0 && child === '1')
      // a cache_specialist child of an investigator must not gain propose rights
      return {
        type: 'tool_calls',
        calls: [
          {
            name: 'propose_action',
            args: {
              action: 'set_config',
              payload: {
                key: 'cache.schema_version',
                value: 5,
                expectedCurrentValueDigest: '0'.repeat(64),
              },
              supportingReceiptIds: [],
              rationale:
                'WIDE-child-1 attempts a proposal it has no capability for',
            },
          },
        ],
      };
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

describe('G4.2 server-side caps and permissions (scripted over-eager model)', () => {
  it('G4.2a depth, breadth and total task caps hold and every refused delegation is accounted for', async () => {
    const { system: sys } = await system();
    const { mission, tail } = await launchMission(sys.api);
    try {
      expect(
        mission.budgets.maxDepth,
        'server resolved NEMODOTS_MAX_DEPTH',
      ).toBe(DEPTH_CAP);
      expect(
        mission.budgets.maxTasks,
        'server resolved NEMODOTS_MAX_TASKS',
      ).toBe(TASK_CAP);
      const snapshot = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.tasks.length >= 2 &&
          s.tasks.every((t) =>
            ['succeeded', 'failed', 'cancelled', 'invalidated'].includes(
              t.status,
            ),
          ),
        180_000,
        'all tasks settled',
      );
      const shape = treeShape(snapshot);
      expect(shape.maxDepth, 'deepest task').toBeLessThanOrEqual(
        mission.budgets.maxDepth,
      );
      expect(
        shape.maxDepth,
        'the chain reached the cap, so the cap was actually exercised',
      ).toBe(DEPTH_CAP);
      expect(shape.maxBreadth, 'children per parent').toBeLessThanOrEqual(
        mission.budgets.maxBreadth,
      );
      expect(shape.total, 'total tasks').toBeLessThanOrEqual(
        mission.budgets.maxTasks,
      );

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
        'depth, breadth, total, extra-capability and planner delegations are refused',
      ).toBeGreaterThanOrEqual(5);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 240_000);

  it('G4.2b children never exceed role or parent capabilities and carry a justification', async () => {
    const { system: sys } = await system();
    const { mission, tail } = await launchMission(sys.api);
    try {
      const snapshot = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.tasks.some((t) => t.parentId !== null) &&
          s.tasks.every((t) =>
            ['succeeded', 'failed', 'cancelled', 'invalidated'].includes(
              t.status,
            ),
          ),
        180_000,
        'children settled',
      );
      const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
      for (const task of snapshot.tasks) {
        const allowed = ROLE_CAPABILITIES[task.role] as readonly string[];
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
          if (
            parent.role === 'investigator' &&
            task.role === 'cache_specialist'
          )
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
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 240_000);

  it('G4.2c a child that proposes without the capability produces no committed effect', async () => {
    const { system: sys } = await system();
    const { mission, tail } = await launchMission(sys.api);
    try {
      const snapshot = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.tasks.some(
            (t) =>
              t.title === 'WIDE-child-1' &&
              ['succeeded', 'failed', 'cancelled'].includes(t.status),
          ),
        180_000,
        'WIDE-child-1 settled',
      );
      expect(
        await committedActionRows(sys),
        'no controlled effect committed',
      ).toHaveLength(0);
      for (const action of snapshot.actions)
        expect(
          ['blocked', 'cancelled', 'failed'],
          `intent ${action.id}`,
        ).toContain(action.status);
      expect(tail.of('action.committed'), 'no commit events').toHaveLength(0);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 240_000);
});
