// delegate_task pre-checks (D5). The coordinator re-validates depth, breadth,
// total, cycles and the capability intersection inside the publication
// transaction; this layer refuses what the role cannot do at all and says why
// in terms the model can act on.
import {
  allowedCapabilities,
  delegableRoles,
  type AttemptContext,
  type Capability,
  type TaskRole,
} from '../contracts/index.js';

export type DelegationPrecheck =
  | { ok: true; childCapabilities: Capability[] }
  | { ok: false; error: string; message: string };

export function precheckDelegation(
  context: Pick<AttemptContext, 'role' | 'capabilities'>,
  role: TaskRole,
  justification: string,
): DelegationPrecheck {
  if (!context.capabilities.includes('delegate'))
    return {
      ok: false,
      error: 'capability_denied',
      message: 'this task may not delegate',
    };
  if (justification.trim().length === 0)
    return {
      ok: false,
      error: 'justification_required',
      message: 'a delegated task needs a justification citing your evidence',
    };
  const allowed = delegableRoles(context.role);
  if (!allowed.includes(role))
    return {
      ok: false,
      error: 'role_not_delegable',
      message: `a ${context.role} may delegate only to: ${allowed.join(', ') || 'nobody'}`,
    };
  return {
    ok: true,
    childCapabilities: allowedCapabilities(role, context.capabilities),
  };
}
