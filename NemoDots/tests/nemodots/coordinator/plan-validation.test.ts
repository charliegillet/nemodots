// Pure validation of plans and delegations (CONTRACTS.md section 4, D1, D5).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  childCapabilities,
  createsSchedulingCycle,
  validateDelegation,
  validatePlan,
  type DelegationFacts,
} from '../../../src/server/nemodots/coordinator/plan-validation.js';
import {
  ROLE_CAPABILITIES,
  TaskRoleSchema,
  type Capability,
  type TaskId,
  type TaskRole,
} from '../../../src/server/nemodots/contracts/index.js';

const id = () => randomUUID() as TaskId;
const planTask = (over: Record<string, unknown> = {}) => ({
  title: 't',
  question: 'q',
  role: 'investigator',
  capabilities: [] as string[],
  dependsOn: [] as number[],
  ...over,
});
const limits = { maxTasks: 24, existingTasks: 1 };

describe('validatePlan', () => {
  it('accepts a plan of 2..6 acyclic tasks within the role capabilities', () => {
    const verdict = validatePlan(
      {
        tasks: [
          planTask({ capabilities: ['observe', 'publish_finding'] }),
          planTask({
            role: 'cache_specialist',
            capabilities: ['propose_cache_flush'],
            dependsOn: [0],
          }),
        ],
      },
      limits,
    );
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ['a self dependency', [planTask({ dependsOn: [0] }), planTask()], /itself/],
    [
      'a two-task cycle',
      [planTask({ dependsOn: [1] }), planTask({ dependsOn: [0] })],
      /cycle/,
    ],
    [
      'a three-task cycle',
      [
        planTask({ dependsOn: [2] }),
        planTask({ dependsOn: [0] }),
        planTask({ dependsOn: [1] }),
      ],
      /cycle/,
    ],
    [
      'an out-of-range dependency',
      [planTask({ dependsOn: [7] }), planTask()],
      /out of range/,
    ],
    [
      'duplicate dependencies',
      [planTask(), planTask({ dependsOn: [0, 0] })],
      /unique/,
    ],
  ])('rejects %s', (_label, tasks, pattern) => {
    const verdict = validatePlan({ tasks }, limits);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join('\n')).toMatch(pattern);
  });

  it('rejects an investigator plan task that asks for propose_config_change (D5)', () => {
    const verdict = validatePlan(
      {
        tasks: [
          planTask({ capabilities: ['propose_config_change'] }),
          planTask(),
        ],
      },
      limits,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.issues.join('\n')).toMatch(
        /ROLE_CAPABILITIES\.investigator/,
      );
  });

  it.each(
    TaskRoleSchema.options.flatMap((role) =>
      (
        [
          'observe',
          'delegate',
          'propose_config_change',
          'propose_cache_flush',
          'publish_finding',
          'request_replan',
        ] as Capability[]
      )
        .filter(
          (capability) =>
            !(ROLE_CAPABILITIES[role] as readonly Capability[]).includes(
              capability,
            ),
        )
        .map((capability) => [role, capability] as [TaskRole, Capability]),
    ),
  )('rejects capability escalation: %s may not hold %s', (role, capability) => {
    if (role === 'planner' || role === 'postcondition') return; // not plan roles at all
    const verdict = validatePlan(
      { tasks: [planTask({ role, capabilities: [capability] }), planTask()] },
      limits,
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects roles that are not plan roles', () => {
    for (const role of ['planner', 'postcondition'])
      expect(
        validatePlan({ tasks: [planTask({ role }), planTask()] }, limits).ok,
      ).toBe(false);
  });

  it('enforces 2..6 tasks and the mission task cap', () => {
    expect(validatePlan({ tasks: [planTask()] }, limits).ok).toBe(false);
    expect(
      validatePlan(
        { tasks: Array.from({ length: 7 }, () => planTask()) },
        limits,
      ).ok,
    ).toBe(false);
    const over = validatePlan(
      { tasks: [planTask(), planTask(), planTask()] },
      { maxTasks: 3, existingTasks: 1 },
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.issues.join()).toMatch(/room for 2/);
    expect(
      validatePlan(
        { tasks: [planTask(), planTask()] },
        { maxTasks: 3, existingTasks: 1 },
      ).ok,
    ).toBe(true);
  });

  it('rejects unknown keys and malformed input without throwing', () => {
    expect(
      validatePlan({ tasks: [{ ...planTask(), extra: 1 }, planTask()] }, limits)
        .ok,
    ).toBe(false);
    expect(validatePlan(null, limits).ok).toBe(false);
    expect(validatePlan('plan', limits).ok).toBe(false);
  });
});

function facts(
  over: Partial<DelegationFacts> & { parentRole?: TaskRole } = {},
): DelegationFacts {
  const parentRole = over.parentRole ?? 'investigator';
  const parent = id();
  return {
    parent: {
      id: parent,
      role: parentRole,
      depth: 0,
      capabilities: ROLE_CAPABILITIES[parentRole] as readonly Capability[],
      maxChildren: 4,
    },
    limits: { maxDepth: 3, maxBreadth: 4, maxTasks: 24 },
    totalTasks: 5,
    parentChildren: 0,
    tasks: [{ id: parent, parentId: null, prerequisites: [] }],
    ...over,
  };
}
const request = (over: Record<string, unknown> = {}) => ({
  role: 'verifier' as TaskRole,
  title: 'verify',
  question: 'is it fixed?',
  justification: 'an independent check',
  dependsOn: [] as TaskId[],
  ...over,
});

describe('validateDelegation', () => {
  it('accepts a justified delegation within the limits', () => {
    expect(validateDelegation(request(), facts(), id())).toEqual([]);
  });

  it.each(['failed', 'cancelled'])(
    'rejects a dependency on a %s task, which can never succeed',
    (status) => {
      const dead = id();
      const base = facts();
      const issues = validateDelegation(
        request({ dependsOn: [dead] }),
        {
          ...base,
          tasks: [
            ...base.tasks,
            { id: dead, parentId: base.parent.id, prerequisites: [], status },
          ],
        },
        id(),
      );
      expect(issues.join()).toMatch(new RegExp(`${status}`));
    },
  );

  it.each(['pending', 'runnable', 'running', 'succeeded', 'invalidated'])(
    'accepts a dependency on a %s task',
    (status) => {
      const live = id();
      const base = facts();
      expect(
        validateDelegation(
          request({ dependsOn: [live] }),
          {
            ...base,
            tasks: [
              ...base.tasks,
              { id: live, parentId: base.parent.id, prerequisites: [], status },
            ],
          },
          id(),
        ),
      ).toEqual([]);
    },
  );

  it('requires a justification (D5)', () => {
    expect(
      validateDelegation(request({ justification: '' }), facts(), id()).join(),
    ).toMatch(/justification/);
    expect(
      validateDelegation(
        request({ justification: null }),
        facts(),
        id(),
      ).join(),
    ).toMatch(/justification/);
    expect(
      validateDelegation(
        request({ justification: 'x'.repeat(501) }),
        facts(),
        id(),
      ).join(),
    ).toMatch(/justification/);
  });

  it('lets specialists delegate only verifiers (D5) and denies roles without the delegate capability', () => {
    for (const parentRole of [
      'cache_specialist',
      'database_specialist',
      'routing_specialist',
    ] as TaskRole[]) {
      expect(
        validateDelegation(
          request({ role: 'verifier' }),
          facts({ parentRole }),
          id(),
        ),
      ).toEqual([]);
      for (const role of [
        'investigator',
        'cache_specialist',
        'database_specialist',
        'routing_specialist',
      ] as TaskRole[])
        expect(
          validateDelegation(
            request({ role }),
            facts({ parentRole }),
            id(),
          ).join(),
          `${parentRole}->${role}`,
        ).toMatch(/may not delegate/);
    }
    for (const parentRole of [
      'verifier',
      'postcondition',
      'planner',
    ] as TaskRole[]) {
      const issues = validateDelegation(request(), facts({ parentRole }), id());
      expect(issues.join()).toMatch(/delegate capability|may not delegate/);
    }
    expect(
      validateDelegation(request({ role: 'cache_specialist' }), facts(), id()),
    ).toEqual([]);
    for (const role of ['planner', 'postcondition'] as TaskRole[])
      expect(
        validateDelegation(request({ role }), facts(), id()).join(),
      ).toMatch(/may not delegate/);
  });

  it('enforces depth, breadth, total and the parent budget', () => {
    const f = facts();
    expect(
      validateDelegation(
        request(),
        { ...f, parent: { ...f.parent, depth: 3 } },
        id(),
      ).join(),
    ).toMatch(/depth 4 exceeds maxDepth 3/);
    expect(
      validateDelegation(
        request(),
        { ...f, parent: { ...f.parent, depth: 2 } },
        id(),
      ),
    ).toEqual([]);
    expect(
      validateDelegation(request(), { ...f, parentChildren: 4 }, id()).join(),
    ).toMatch(/breadth 5/);
    expect(
      validateDelegation(request(), { ...f, parentChildren: 3 }, id()),
    ).toEqual([]);
    expect(
      validateDelegation(
        request(),
        { ...f, parent: { ...f.parent, maxChildren: 1 }, parentChildren: 1 },
        id(),
      ).join(),
    ).toMatch(/breadth/);
    expect(
      validateDelegation(request(), { ...f, totalTasks: 24 }, id()).join(),
    ).toMatch(/24 of 24/);
    expect(
      validateDelegation(request(), { ...f, totalTasks: 23 }, id()),
    ).toEqual([]);
  });

  it('rejects unknown and duplicate prerequisites', () => {
    const f = facts();
    expect(
      validateDelegation(request({ dependsOn: [id()] }), f, id()).join(),
    ).toMatch(/not a task of this mission/);
    const sibling = id();
    const withSibling = {
      ...f,
      tasks: [
        ...f.tasks,
        { id: sibling, parentId: f.parent.id, prerequisites: [] },
      ],
    };
    expect(
      validateDelegation(request({ dependsOn: [sibling] }), withSibling, id()),
    ).toEqual([]);
    expect(
      validateDelegation(
        request({ dependsOn: [sibling, sibling] }),
        withSibling,
        id(),
      ).join(),
    ).toMatch(/unique/);
  });

  it('rejects a prerequisite chain that leads back to the delegating parent (deadlock)', () => {
    const f = facts();
    expect(
      validateDelegation(request({ dependsOn: [f.parent.id] }), f, id()).join(),
    ).toMatch(/cycle/);
    const other = id();
    const chained = {
      ...f,
      tasks: [
        ...f.tasks,
        { id: other, parentId: null, prerequisites: [f.parent.id] },
      ],
    };
    expect(
      validateDelegation(request({ dependsOn: [other] }), chained, id()).join(),
    ).toMatch(/cycle/);
  });
});

describe('createsSchedulingCycle', () => {
  it('detects cycles through prerequisites and through parent-waits-for-child edges only', () => {
    const [a, b, c, d] = [id(), id(), id(), id()];
    const graph = [
      { id: a, parentId: null, prerequisites: [] as TaskId[] },
      { id: b, parentId: null, prerequisites: [a] },
      { id: c, parentId: null, prerequisites: [b] },
    ];
    expect(
      createsSchedulingCycle(graph, {
        id: d,
        parentId: null,
        prerequisites: [c],
      }),
    ).toBe(false);
    // d is a child of a: a waits for d; d requires c which requires b which requires a.
    expect(
      createsSchedulingCycle(graph, { id: d, parentId: a, prerequisites: [c] }),
    ).toBe(true);
    expect(
      createsSchedulingCycle(graph, { id: d, parentId: a, prerequisites: [] }),
    ).toBe(false);
    // a sibling branch does not create one
    expect(
      createsSchedulingCycle(graph, { id: d, parentId: c, prerequisites: [a] }),
    ).toBe(false);
  });
});

describe('childCapabilities', () => {
  it('is ROLE_CAPABILITIES[role] ∩ parent.capabilities', () => {
    expect(
      childCapabilities('verifier', [
        'observe',
        'delegate',
        'propose_cache_flush',
      ]).sort(),
    ).toEqual(['observe']);
    expect(
      childCapabilities(
        'cache_specialist',
        ROLE_CAPABILITIES.cache_specialist as readonly Capability[],
      ).sort(),
    ).toEqual([...ROLE_CAPABILITIES.cache_specialist].sort());
    // A child can never exceed its parent: an investigator's specialists cannot propose.
    expect(
      childCapabilities(
        'cache_specialist',
        ROLE_CAPABILITIES.investigator as readonly Capability[],
      ),
    ).not.toContain('propose_config_change');
    expect(childCapabilities('verifier', [])).toEqual([]);
  });
});
