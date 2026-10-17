import type { DependencyVector } from '../contracts/model-call.js';

// Module-level tool policy (ARCHITECTURE.md section 2, finding I5).
//
// OpenDots builds a fresh ConnectionService and ComputerService for every Dot
// turn (dot-agent.ts), so a hook attached to the platform-level instances would
// miss them. These services therefore consult this registry at their execution
// boundary regardless of which instance they run on. The default policy allows
// everything and an installed policy only changes behaviour for Dots it names,
// so upstream behaviour is unchanged when NemoDots is absent.
//
// This module imports types only: it is loaded by connections.ts and
// computer-service.ts and must stay free of heavy dependencies.

export type PolicyDenialCode =
  | 'disabled_for_incident'
  | 'deny_unknown'
  | 'policy_checked_refused'
  | 'agent_action_refused';

export type PolicyDecision =
  | { allow: true }
  | { allow: false; code: PolicyDenialCode; reason: string };

export const ALLOW: PolicyDecision = Object.freeze({ allow: true });

export type ToolOrigin = 'server' | 'mcp' | 'composio' | 'learned_skill';

export interface ToolDecisionRequest {
  dotId: string;
  toolName: string;
  /** Where the tool was registered; narrows the name-pattern lookup. */
  origin?: ToolOrigin;
  /** Parsed model-supplied arguments, when known (policy-checked rows read them). */
  args?: unknown;
}

export interface ConnectionCallRequest {
  dotId: string;
  /** Real MCP tool name on the connection. */
  tool: string;
  /**
   * 'agent': the model's direct (non-approval) call path.
   * 'owner_approval': the owner approved a stored request; revalidation runs
   * in the route before this point.
   */
  via: 'agent' | 'owner_approval';
}

export interface ComputerActionRequest {
  dotId: string;
  action: string;
  actor: 'owner' | 'agent';
}

export interface ApprovalRevalidationRequest {
  approvalId: string;
  threadId: string;
  dotId: string;
  connectionId: string;
  tool: string;
  /** null: the approval was created without a bound dependency vector. */
  vector: DependencyVector | null;
}

export type ApprovalVerdict =
  | { ok: true }
  | {
      ok: false;
      /** stale_evidence: a bound receipt is no longer current. unbound_evidence: no vector on an incident Dot. */
      code: 'stale_evidence' | 'unbound_evidence';
      message: string;
      receiptId?: string;
    };

export interface ActivePolicy {
  readonly name: string;
  isIncidentDot(dotId: string): boolean;
  decideTool(request: ToolDecisionRequest): PolicyDecision;
  decideConnectionCall(request: ConnectionCallRequest): PolicyDecision;
  decideComputerAction(request: ComputerActionRequest): PolicyDecision;
  /** Evidence revalidation in front of the approval callback. Absent: no check. */
  revalidateApproval?(
    request: ApprovalRevalidationRequest,
  ): ApprovalVerdict | Promise<ApprovalVerdict>;
}

export const ALLOW_ALL_POLICY: ActivePolicy = Object.freeze({
  name: 'allow-all',
  isIncidentDot: () => false,
  decideTool: () => ALLOW,
  decideConnectionCall: () => ALLOW,
  decideComputerAction: () => ALLOW,
});

let active: ActivePolicy = ALLOW_ALL_POLICY;

/** Called by bootstrap. Pass null to restore the allow-all default. */
export function setActivePolicy(policy: ActivePolicy | null): void {
  active = policy ?? ALLOW_ALL_POLICY;
}

export function getActivePolicy(): ActivePolicy {
  return active;
}

/** True when a non-default policy is installed (DotAgent adds its layers only then). */
export function hasActivePolicy(): boolean {
  return active !== ALLOW_ALL_POLICY;
}
