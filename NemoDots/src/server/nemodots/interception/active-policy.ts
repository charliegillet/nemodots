// Module-level interception registry. Upstream domain services (ConnectionService,
// ComputerService, Pages, the approval route) consult it so the per-turn
// instances DotAgent builds are covered, not only the ones the platform owns
// (finding I5). The default is env-driven: with NEMODOTS_INCIDENT_DOT_IDS empty
// every method allows and upstream behaviour is unchanged (finding I4).
import type { DependencyEntry } from '../contracts/index.js';
import { isIncidentDot } from './policy-registry.js';
import { resetToolEvidence } from './provenance-scope.js';
import type { ProvenanceSink } from './sink.js';

export type Actor = 'agent' | 'owner';

export interface PageRevisionEvent {
  kind: 'create' | 'update' | 'reparent' | 'delete';
  spaceId: string;
  pageId: string;
  /** Revision after the write; null when the page no longer exists. */
  revision: number | null;
}

export interface ApprovalRevalidation {
  threadId: string;
  dotId: string;
  approvalId: string;
  /** null when the approval was created outside a provenance scope. */
  dependencyVector: readonly DependencyEntry[] | null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface ToolPolicy {
  isIncident(dotId: string): boolean;
  /** Return a refusal message, or null to allow. */
  connectionCall(call: {
    dotId: string;
    connectionId: string;
    tool: string;
  }): string | null;
  computerAction(call: {
    dotId: string;
    action: string;
    actor: Actor;
  }): string | null;
  /** Page writes by an incident agent: allow only into the projection Space. */
  pageWriteAllowed(call: { dotId: string; spaceId: string | null }): boolean;
  revalidateApproval(
    approval: ApprovalRevalidation,
  ): Promise<Verdict> | Verdict;
}

export interface InterceptionHooks {
  pageRevision?: (event: PageRevisionEvent) => void;
  /** Receives Dot-turn snapshots and ModelCallRecords. Absent = no recording. */
  sink?: ProvenanceSink;
  /** Whether provider traffic is live or a fixture; labels records honestly. */
  providerMode?: 'live' | 'fixture';
}

export interface VectorChecker {
  /** True when every entry is still the current, supported receipt. */
  isCurrent(vector: readonly DependencyEntry[]): Promise<boolean> | boolean;
}

export interface IncidentPolicyOptions {
  env?: Record<string, string | undefined>;
  /** Space incident Dots may create pages in (mission projection); none by default. */
  projectionSpaceId?: string;
  vectors?: VectorChecker;
}

export function createIncidentPolicy(
  options: IncidentPolicyOptions = {},
): ToolPolicy {
  const incident = (dotId: string) =>
    isIncidentDot(dotId, options.env ?? process.env);
  return {
    isIncident: incident,
    connectionCall: ({ dotId }) =>
      incident(dotId)
        ? 'Connected-service tools are disabled for incident agents.'
        : null,
    computerAction: ({ dotId, actor }) =>
      actor === 'agent' && incident(dotId)
        ? 'Computer actions are disabled for incident agents.'
        : null,
    pageWriteAllowed: ({ dotId, spaceId }) =>
      !incident(dotId) ||
      (options.projectionSpaceId !== undefined &&
        spaceId === options.projectionSpaceId),
    revalidateApproval: async (approval) => {
      const vector = approval.dependencyVector;
      // No evidence binding: NULL (created outside a provenance scope) or an
      // empty vector (created in one that had read nothing). Ordinary Dots
      // pass; for incident Dots both refuse, so an approval cannot be claimed
      // on evidence nobody recorded (M10).
      if (vector === null || vector.length === 0)
        return incident(approval.dotId)
          ? {
              ok: false,
              reason:
                'Approval carries no evidence binding for an incident Dot.',
            }
          : { ok: true };
      if (!options.vectors)
        return incident(approval.dotId)
          ? { ok: false, reason: 'Evidence cannot be revalidated.' }
          : { ok: true };
      return (await options.vectors.isCurrent(vector))
        ? { ok: true }
        : {
            ok: false,
            reason: 'Evidence behind this approval was superseded.',
          };
    },
  };
}

let active: ToolPolicy = createIncidentPolicy();
let hooks: InterceptionHooks = {};

export function setActivePolicy(policy: ToolPolicy | null): void {
  active = policy ?? createIncidentPolicy();
}
export function getActivePolicy(): ToolPolicy {
  return active;
}
export function setInterceptionHooks(next: InterceptionHooks | null): void {
  hooks = next ?? {};
}
export function getInterceptionHooks(): InterceptionHooks {
  return hooks;
}
export function resetInterception(): void {
  active = createIncidentPolicy();
  hooks = {};
  resetToolEvidence();
}
