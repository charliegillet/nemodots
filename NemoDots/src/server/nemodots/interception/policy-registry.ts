import { computerInputs } from '../../../shared/computer-types.js';
import { connectionActionTool } from '../../../shared/connection-types.js';
import { pageReviewTool } from '../../../shared/page-review.js';
import {
  ALLOW,
  type ActivePolicy,
  type ApprovalRevalidationRequest,
  type ApprovalVerdict,
  type ComputerActionRequest,
  type ConnectionCallRequest,
  type PolicyDecision,
  type ToolDecisionRequest,
  type ToolOrigin,
} from './active-policy.js';

// OpenDots tool-path policy registry (docs/nemodots/TOOL_COVERAGE.md sections
// 2-3). Every model-visible tool name OpenDots can register maps to a class and
// a treatment. A name that is not in the registry is `deny_unknown`: it is
// disabled for incident Dots. A name containing read, list or get is not proof
// of read-only, and an MCP readOnlyHint is a hint, never proof.
//
// Incident Dots are the ones listed in NEMODOTS_INCIDENT_DOT_IDS (finding I4;
// `Dot` has no profile field). With the list empty every refusal below is
// inactive and OpenDots behaves exactly as upstream.

export type ToolClass = 'read' | 'mutate' | 'unknown';
export type ToolTreatment =
  | 'instrumented'
  | 'policy-checked'
  | 'disabled'
  | 'n/a-blocked';

export interface PolicyClassification {
  /** Registry entry id; 'deny_unknown' when nothing matched. */
  id: string;
  /** TOOL_COVERAGE.md row ids (R6, M2, ...). */
  rows: readonly string[];
  class: ToolClass;
  treatment: ToolTreatment;
  matched: boolean;
}

interface Entry extends Omit<PolicyClassification, 'matched'> {
  names?: readonly string[];
  pattern?: RegExp;
  /** Origins this entry applies to. Default: tools registered by the server itself. */
  origins: readonly ToolOrigin[];
}

const COMPUTER_READ_ACTIONS = new Set([
  'snapshot',
  'read',
  'screenshot',
  'files_list',
  'files_read',
]);

const computerEntries = (): Entry[] =>
  Object.keys(computerInputs).map((name) =>
    name.startsWith('human_')
      ? {
          id: `computer_${name}`,
          rows: ['R12', 'M7'],
          class: 'mutate',
          treatment: 'disabled',
          names: [`computer_${name}`],
          origins: ['server'],
        }
      : {
          id: `computer_${name}`,
          rows: ['R12', 'M6'],
          class: COMPUTER_READ_ACTIONS.has(name) ? 'read' : 'mutate',
          // Docker is absent in this environment, so no computer tool is
          // registered; the policy still refuses them for incident Dots.
          treatment: 'n/a-blocked',
          names: [`computer_${name}`],
          origins: ['server'],
        },
  );

/** Exported for the completeness test and for documentation generation. */
export const TOOL_POLICY_ENTRIES: readonly Entry[] = Object.freeze([
  {
    id: 'list_authorized_spaces',
    rows: ['R6'],
    class: 'read',
    treatment: 'instrumented',
    names: ['list_authorized_spaces'],
    origins: ['server'],
  },
  {
    id: 'list_space_pages',
    rows: ['R7'],
    class: 'read',
    treatment: 'instrumented',
    names: ['list_space_pages'],
    origins: ['server'],
  },
  {
    id: 'read_space_page',
    rows: ['R8'],
    class: 'read',
    treatment: 'instrumented',
    names: ['read_space_page'],
    origins: ['server'],
  },
  {
    id: 'create_space_page',
    rows: ['M1'],
    class: 'mutate',
    treatment: 'policy-checked',
    names: ['create_space_page'],
    origins: ['server'],
  },
  {
    id: 'edit_space_page',
    rows: ['M2'],
    class: 'mutate',
    treatment: 'policy-checked',
    names: ['edit_space_page'],
    origins: ['server'],
  },
  {
    id: 'search_web',
    rows: ['R9', 'M12'],
    class: 'read',
    treatment: 'disabled',
    names: ['search_web'],
    origins: ['server'],
  },
  {
    id: 'read_public_page',
    rows: ['R9', 'R9b', 'M12'],
    class: 'read',
    treatment: 'disabled',
    names: ['read_public_page'],
    origins: ['server'],
  },
  ...computerEntries(),
  {
    id: 'learned_skill_tools',
    rows: ['R13'],
    class: 'read',
    treatment: 'disabled',
    names: ['copilotkit_load_skill', 'copilotkit_read_skill_file'],
    origins: ['server', 'learned_skill'],
  },
  {
    // Client tools: executor-less, resolved by the browser; the approved
    // effect runs through its own route (M3, M10).
    id: pageReviewTool.name,
    rows: ['M3'],
    class: 'mutate',
    treatment: 'instrumented',
    names: [pageReviewTool.name],
    origins: ['server'],
  },
  {
    id: connectionActionTool.name,
    rows: ['M9', 'M10'],
    class: 'mutate',
    treatment: 'instrumented',
    names: [connectionActionTool.name],
    origins: ['server'],
  },
  {
    // exposedTools() names are `<connection>__<tool>[_n]` slugs.
    id: 'mcp_tools',
    rows: ['R10', 'M8'],
    class: 'unknown',
    treatment: 'disabled',
    pattern: /^[a-z0-9_-]{1,20}__[a-z0-9_-]{1,40}(?:_\d+)?$/,
    origins: ['mcp'],
  },
  {
    // Composio tool slugs are upper-case with underscores.
    id: 'composio_tools',
    rows: ['R11', 'M11'],
    class: 'unknown',
    treatment: 'disabled',
    pattern: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
    origins: ['composio'],
  },
]);

const DENY_UNKNOWN: PolicyClassification = Object.freeze({
  id: 'deny_unknown',
  rows: [],
  class: 'unknown',
  treatment: 'disabled',
  matched: false,
});

/**
 * Classifies a tool by name. `origin` is what the registering code knows
 * (DotAgent knows which tools came from a connection or Composio); without it
 * the MCP and Composio name patterns still apply, with it they apply
 * unconditionally for that origin.
 */
export function classifyTool(
  toolName: string,
  origin?: ToolOrigin,
): PolicyClassification {
  for (const entry of TOOL_POLICY_ENTRIES) {
    const originMatches = origin
      ? entry.origins.includes(origin)
      : entry.origins.includes('server') || entry.pattern !== undefined;
    if (!originMatches) continue;
    const nameMatches = entry.names
      ? entry.names.includes(toolName)
      : origin
        ? true
        : (entry.pattern?.test(toolName) ?? false);
    if (!nameMatches) continue;
    return {
      id: entry.id,
      rows: entry.rows,
      class: entry.class,
      treatment: entry.treatment,
      matched: true,
    };
  }
  return DENY_UNKNOWN;
}

export type IncidentDotIds =
  | ReadonlySet<string>
  | readonly string[]
  | (() => Iterable<string>);

/** NEMODOTS_INCIDENT_DOT_IDS: comma-separated Dot ids; empty/absent means none. */
export function parseIncidentDotIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export interface ToolPolicyOptions {
  /** Lazily evaluated on every decision when a function, so the list may change at runtime. */
  incidentDotIds: IncidentDotIds;
  /**
   * policy-checked create_space_page: the only Space an incident Dot may write
   * to is the mission projection Space. Default: refuse. `spaceId` is the
   * model-supplied value (undefined when it relied on the default).
   */
  allowIncidentPageCreate?: (request: {
    dotId: string;
    spaceId: string | undefined;
  }) => boolean;
  /** policy-checked edit_space_page for an incident Dot. Default: refuse. */
  allowIncidentPageEdit?: (request: {
    dotId: string;
    spaceId: string | undefined;
    pageId: string | undefined;
  }) => boolean;
  revalidateApproval?: ActivePolicy['revalidateApproval'];
}

const deny = (
  code: Extract<PolicyDecision, { allow: false }>['code'],
  reason: string,
): PolicyDecision => ({ allow: false, code, reason });

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

export function createToolPolicy(options: ToolPolicyOptions): ActivePolicy {
  const incidentIds = (): ReadonlySet<string> => {
    const source = options.incidentDotIds;
    if (typeof source === 'function') return new Set(source());
    return source instanceof Set ? source : new Set(source);
  };
  const isIncidentDot = (dotId: string) => incidentIds().has(dotId);
  const decideTool = (request: ToolDecisionRequest): PolicyDecision => {
    if (!isIncidentDot(request.dotId)) return ALLOW;
    const entry = classifyTool(request.toolName, request.origin);
    if (!entry.matched)
      return deny(
        'deny_unknown',
        `Tool ${request.toolName} is not in the NemoDots tool policy registry and is disabled for incident Dots.`,
      );
    switch (entry.treatment) {
      case 'instrumented':
        return ALLOW;
      case 'disabled':
      case 'n/a-blocked':
        return deny(
          'disabled_for_incident',
          `Tool ${request.toolName} is disabled for incident Dots.`,
        );
      case 'policy-checked': {
        const args = record(request.args);
        if (
          entry.id === 'create_space_page' &&
          options.allowIncidentPageCreate?.({
            dotId: request.dotId,
            spaceId: text(args.spaceId),
          })
        )
          return ALLOW;
        if (
          entry.id === 'edit_space_page' &&
          options.allowIncidentPageEdit?.({
            dotId: request.dotId,
            spaceId: text(args.spaceId),
            pageId: text(args.id),
          })
        )
          return ALLOW;
        return deny(
          'policy_checked_refused',
          `Tool ${request.toolName} is not permitted for incident Dots: page changes belong to the mission.`,
        );
      }
    }
  };
  return {
    name: 'nemodots-tool-policy',
    isIncidentDot,
    decideTool,
    decideConnectionCall(request: ConnectionCallRequest): PolicyDecision {
      if (request.via === 'owner_approval' || !isIncidentDot(request.dotId))
        return ALLOW;
      return deny(
        'agent_action_refused',
        'Connected-service tools are disabled for incident Dots.',
      );
    },
    decideComputerAction(request: ComputerActionRequest): PolicyDecision {
      if (request.actor === 'owner' || !isIncidentDot(request.dotId))
        return ALLOW;
      return deny(
        'agent_action_refused',
        'Computer actions by agents are disabled for incident Dots.',
      );
    },
    revalidateApproval: options.revalidateApproval
      ? (request: ApprovalRevalidationRequest): ApprovalVerdict | Promise<ApprovalVerdict> =>
          options.revalidateApproval!(request)
      : undefined,
  };
}
