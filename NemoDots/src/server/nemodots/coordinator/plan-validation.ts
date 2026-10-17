import {
  PlanSchema,
  TaskJustificationSchema,
  TaskQuestionSchema,
  TaskTitleSchema,
  allowedCapabilities,
  delegableRoles,
  type Capability,
  type Plan,
  type TaskId,
  type TaskRole,
} from '../contracts/index.js';

// Pure validation of plans and delegations (CONTRACTS.md section 4,
// ARCHITECTURE.md section 11, findings D1/D5). No I/O: the persistence layer
// feeds it rows read under FOR UPDATE on the mission row, so the counts it
// checks cannot move underneath it.

export type PlanValidation =
  | { ok: true; plan: Plan }
  | { ok: false; issues: string[] };

export interface PlanLimits {
  /** budgets.maxTasks */
  maxTasks: number;
  /** tasks that already exist in the mission (all statuses, planner seed included) */
  existingTasks: number;
}

/**
 * Schema + semantic checks of a planner output: 2..6 tasks, plan roles only,
 * capabilities within ROLE_CAPABILITIES[role] (an investigator task asking for
 * propose_config_change is rejected, D5), in-range acyclic dependsOn, and the
 * mission-wide task cap. Root tasks have no parent, so their allowed set is the
 * role default (nothing to intersect with).
 */
export function validatePlan(input: unknown, limits: PlanLimits): PlanValidation {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<plan>'}: ${issue.message}`,
      ),
    };
  const issues: string[] = [];
  const room = limits.maxTasks - limits.existingTasks;
  if (parsed.data.tasks.length > room)
    issues.push(
      `plan has ${parsed.data.tasks.length} tasks but the mission has room for ${Math.max(room, 0)} (maxTasks ${limits.maxTasks})`,
    );
  parsed.data.tasks.forEach((task, i) => {
    const allowed = allowedCapabilities(task.role, null);
    for (const capability of task.capabilities)
      if (!allowed.includes(capability))
        issues.push(
          `tasks[${i}] capability ${capability} escalates beyond role ${task.role}`,
        );
  });
  return issues.length ? { ok: false, issues } : { ok: true, plan: parsed.data };
}

export interface DelegationParent {
  id: TaskId;
  role: TaskRole;
  depth: number;
  capabilities: readonly Capability[];
  /** the parent task's budget.maxChildren */
  maxChildren: number;
}

export interface DelegationLimits {
  maxDepth: number;
  maxBreadth: number;
  maxTasks: number;
}

export interface DelegationRequest {
  role: TaskRole;
  title: string;
  question: string;
  justification: string | null | undefined;
  dependsOn: readonly TaskId[];
}

/** Scheduling-relevant shape of every task of the mission. */
export interface GraphTask {
  id: TaskId;
  parentId: TaskId | null;
  prerequisites: readonly TaskId[];
}

export interface DelegationFacts {
  parent: DelegationParent;
  limits: DelegationLimits;
  totalTasks: number;
  parentChildren: number;
  tasks: readonly GraphTask[];
}

/**
 * True when adding `candidate` creates a scheduling cycle. A task "depends on"
 * its prerequisites, and a parent depends on its children (it cannot finish
 * before them), so a child that requires something that transitively requires
 * its own parent is a deadlock and is rejected like any other cycle.
 */
export function createsSchedulingCycle(
  tasks: readonly GraphTask[],
  candidate: GraphTask,
): boolean {
  const all = new Map<string, GraphTask>(tasks.map((task) => [task.id, task]));
  all.set(candidate.id, candidate);
  const children = new Map<string, string[]>();
  for (const task of all.values())
    if (task.parentId)
      children.set(task.parentId, [
        ...(children.get(task.parentId) ?? []),
        task.id,
      ]);
  const next = (id: string): string[] => [
    ...(all.get(id)?.prerequisites ?? []),
    ...(children.get(id) ?? []),
  ];
  const seen = new Set<string>();
  const stack = [...next(candidate.id)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === candidate.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return false;
}

/** Issues that make a delegate_task request invalid; empty means acceptable. */
export function validateDelegation(
  request: DelegationRequest,
  facts: DelegationFacts,
  candidateId: TaskId,
): string[] {
  const issues: string[] = [];
  const { parent, limits } = facts;
  if (!parent.capabilities.includes('delegate'))
    issues.push(`task ${parent.id} lacks the delegate capability`);
  if (!delegableRoles(parent.role).includes(request.role))
    issues.push(
      `a ${parent.role} task may not delegate to role ${request.role}` +
        ` (allowed: ${delegableRoles(parent.role).join(', ') || 'none'})`,
    );
  if (!request.justification)
    issues.push('justification is required for delegated tasks');
  else if (!TaskJustificationSchema.safeParse(request.justification).success)
    issues.push('justification must be 1..500 characters');
  if (!TaskTitleSchema.safeParse(request.title).success)
    issues.push('title must be 1..160 characters');
  if (!TaskQuestionSchema.safeParse(request.question).success)
    issues.push('question must be 1..2000 characters');
  if (parent.depth + 1 > limits.maxDepth)
    issues.push(
      `depth ${parent.depth + 1} exceeds maxDepth ${limits.maxDepth}`,
    );
  const breadth = Math.min(limits.maxBreadth, parent.maxChildren);
  if (facts.parentChildren + 1 > breadth)
    issues.push(
      `breadth ${facts.parentChildren + 1} exceeds the limit of ${breadth} children per task`,
    );
  if (facts.totalTasks + 1 > limits.maxTasks)
    issues.push(`mission already has ${facts.totalTasks} of ${limits.maxTasks} tasks`);
  const known = new Map(facts.tasks.map((task) => [task.id, task]));
  for (const id of request.dependsOn)
    if (!known.has(id)) issues.push(`dependsOn ${id} is not a task of this mission`);
  if (new Set(request.dependsOn).size !== request.dependsOn.length)
    issues.push('dependsOn must be unique');
  if (
    issues.length === 0 &&
    createsSchedulingCycle(facts.tasks, {
      id: candidateId,
      parentId: parent.id,
      prerequisites: request.dependsOn,
    })
  )
    issues.push('dependsOn creates a scheduling cycle');
  return issues;
}

/** The capability set a delegated child receives: ROLE_CAPABILITIES[role] ∩ parent.capabilities. */
export function childCapabilities(
  role: TaskRole,
  parentCapabilities: readonly Capability[],
): Capability[] {
  return allowedCapabilities(role, parentCapabilities);
}
