import type { Capability, TaskId } from '../contracts/index.js';
import {
  childCapabilities,
  validateDelegation,
  type DelegationFacts,
  type DelegationRequest,
} from '../coordinator/plan-validation.js';

// Delegation rules as the team sees them (ARCHITECTURE.md section 11, D5):
// depth <= maxDepth, breadth <= min(maxBreadth, parent.maxChildren), total
// <= maxTasks, role in delegableRoles(parent) (specialists: verifier only),
// child capabilities = ROLE_CAPABILITIES[role] ∩ parent.capabilities, no
// scheduling cycle, justification required. The coordinator re-runs the same
// pure rules inside the delegation transaction under the mission row lock;
// this pre-check gives the model a precise refusal and writes nothing.

export type DelegationDecision =
  | { ok: true; capabilities: Capability[]; depth: number }
  | { ok: false; issues: string[] };

export function checkDelegation(
  request: DelegationRequest,
  facts: DelegationFacts,
  candidateId: TaskId,
): DelegationDecision {
  const issues = validateDelegation(request, facts, candidateId);
  const capabilities = childCapabilities(
    request.role,
    facts.parent.capabilities,
  );
  if (issues.length === 0 && capabilities.length === 0)
    issues.push(
      `a ${request.role} child of this task would hold no capabilities (the parent lacks every capability of that role)`,
    );
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, capabilities, depth: facts.parent.depth + 1 };
}
