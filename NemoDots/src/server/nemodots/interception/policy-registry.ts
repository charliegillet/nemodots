// Tool policy registry (TOOL_COVERAGE.md sections 2-3). Maps a model-visible
// tool name to a class and a treatment for incident agents. Anything that is
// not listed is `deny_unknown`: a name containing read/list/get is not proof
// of read-only, and MCP readOnlyHint is a hint, never proof.
//
// Incident Dots are listed in NEMODOTS_INCIDENT_DOT_IDS (comma-separated; Dot
// has no profile field). With the list empty every rule here is inactive.

export type ToolClass = 'read' | 'mutate' | 'unknown';
export type Treatment =
  'instrumented' | 'policy-checked' | 'disabled' | 'deny_unknown';

export interface PolicyEntry {
  /** Matrix row, e.g. "R7" or "M2". */
  row: string;
  class: ToolClass;
  treatment: Treatment;
}

export const INCIDENT_ENV = 'NEMODOTS_INCIDENT_DOT_IDS';

const exact: Record<string, PolicyEntry> = {
  list_authorized_spaces: {
    row: 'R6',
    class: 'read',
    treatment: 'instrumented',
  },
  list_space_pages: { row: 'R7', class: 'read', treatment: 'instrumented' },
  read_space_page: { row: 'R8', class: 'read', treatment: 'instrumented' },
  create_space_page: {
    row: 'M1',
    class: 'mutate',
    treatment: 'policy-checked',
  },
  edit_space_page: { row: 'M2', class: 'mutate', treatment: 'policy-checked' },
  // R9 / R9b: Parallel search and the browser worker write captures.
  search_web: { row: 'R9', class: 'read', treatment: 'disabled' },
  read_public_page: { row: 'R9', class: 'read', treatment: 'disabled' },
  // R13: learned-skill executors.
  copilotkit_load_skill: { row: 'R13', class: 'read', treatment: 'disabled' },
  copilotkit_read_skill_file: {
    row: 'R13',
    class: 'read',
    treatment: 'disabled',
  },
  // Client tools keep no executor (I7); listed so the registry is complete.
  review_space_page: { row: 'M3', class: 'mutate', treatment: 'instrumented' },
  request_connection_action: {
    row: 'M10',
    class: 'mutate',
    treatment: 'policy-checked',
  },
};

/** Every static name the registry knows (for the completeness test). */
export const REGISTERED_TOOL_NAMES = Object.keys(exact);

const COMPUTER_PREFIX = 'computer_';
const denyUnknown: PolicyEntry = {
  row: 'default',
  class: 'unknown',
  treatment: 'deny_unknown',
};

export function classifyTool(name: string): PolicyEntry {
  const hit = Object.hasOwn(exact, name) ? exact[name] : undefined;
  if (hit) return hit;
  // R12 / M6: computer_* actions (human_* are not model-visible).
  if (name.startsWith(COMPUTER_PREFIX))
    return { row: 'M6', class: 'mutate', treatment: 'disabled' };
  return denyUnknown;
}

export function parseIncidentDotIds(
  raw: string | undefined,
): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isIncidentDot(
  dotId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseIncidentDotIds(env[INCIDENT_ENV]).has(dotId);
}

export interface Refusal {
  refused: true;
  row: string;
  treatment: Treatment;
  message: string;
}

/**
 * Decide whether an incident agent may run `name`. `instrumented` tools pass;
 * `policy-checked` tools pass only when `allowPolicyChecked` says so; anything
 * else is refused with a message the model can read.
 */
export function decideTool(
  name: string,
  allowPolicyChecked: (name: string, args: unknown) => boolean,
  args: unknown,
): Refusal | null {
  const entry = classifyTool(name);
  if (entry.treatment === 'instrumented') return null;
  if (entry.treatment === 'policy-checked' && allowPolicyChecked(name, args))
    return null;
  return {
    refused: true,
    row: entry.row,
    treatment: entry.treatment,
    message: `Tool ${name} is not available in the incident scope (${entry.treatment}).`,
  };
}
