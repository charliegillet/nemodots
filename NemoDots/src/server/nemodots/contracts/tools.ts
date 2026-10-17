import { z } from 'zod';
import { ProposeInputSchema } from './action.js';
import { digest, type Digest } from './digest.js';
import { FindingClaimSchema, FindingConfidenceSchema } from './finding.js';
import { ReceiptIdSchema, SourceKeySchema, TaskIdSchema } from './ids.js';
import {
  TaskJustificationSchema,
  TaskQuestionSchema,
  TaskRoleSchema,
  TaskTitleSchema,
} from './task.js';

// The nine typed team tools (ARCHITECTURE.md section 11). Identity, mission,
// task and attempt ids come from AttemptContext server-side; model-supplied
// receipt ids are citations checked against scope, never authority.

export const DELEGABLE_ROLES = TaskRoleSchema.exclude(['planner', 'postcondition']);

export const TEAM_TOOL_INPUTS = Object.freeze({
  observe_source: z.object({ sourceKey: SourceKeySchema }).strict(),
  list_runbooks: z.object({}).strict(),
  read_runbook: z
    .object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) })
    .strict(),
  delegate_task: z
    .object({
      title: TaskTitleSchema,
      role: DELEGABLE_ROLES,
      question: TaskQuestionSchema,
      dependsOn: z.array(TaskIdSchema).max(8),
      justification: TaskJustificationSchema,
    })
    .strict(),
  get_task_status: z.object({ taskId: TaskIdSchema }).strict(),
  wait_for_children: z.object({}).strict(),
  publish_finding: z
    .object({
      claim: FindingClaimSchema,
      supportingReceiptIds: z.array(ReceiptIdSchema).max(32),
      confidence: FindingConfidenceSchema,
    })
    .strict(),
  propose_action: ProposeInputSchema,
  request_replan: z.object({ reason: z.string().min(1).max(500) }).strict(),
});

export type TeamToolName = keyof typeof TEAM_TOOL_INPUTS;
export type TeamToolInput<N extends TeamToolName> = z.infer<(typeof TEAM_TOOL_INPUTS)[N]>;

/** Stable order of the tool schemas in every context prefix. */
export const TEAM_TOOL_ORDER = Object.freeze([
  'observe_source',
  'list_runbooks',
  'read_runbook',
  'delegate_task',
  'get_task_status',
  'wait_for_children',
  'publish_finding',
  'propose_action',
  'request_replan',
] as const satisfies readonly TeamToolName[]);

const DESCRIPTIONS: Readonly<Record<TeamToolName, string>> = Object.freeze({
  observe_source:
    'Read one registered source now. Records or confirms an observation receipt and adds it to your read set. Returns the receipt id, revision and normalized value.',
  list_runbooks: 'List the authorized runbook catalogue (ids and titles).',
  read_runbook: 'Read one runbook by catalogue id.',
  delegate_task:
    'Create a child task for another role. Capabilities are derived from the role and your own; depth, breadth and total task limits apply.',
  get_task_status: 'Get the status and published output summary of a task in this mission.',
  wait_for_children: 'Wait until your delegated child tasks finish, then continue with their outputs.',
  publish_finding:
    'Publish a claim with the receipt ids that support it. Findings are model claims, never evidence.',
  propose_action:
    'Propose a bounded remediation. The server derives the dependency vector, target version and required sources and admits or blocks it against current evidence.',
  request_replan: 'Ask the planner to replan the mission because the current plan no longer fits the evidence.',
});

export type ToolSchema = {
  name: TeamToolName;
  description: string;
  parameters: Record<string, unknown>;
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  return rest;
}

/** Ordered JSON Schemas for the nine team tools. Deterministic across calls. */
export function toolSchemas(): ToolSchema[] {
  return TEAM_TOOL_ORDER.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: jsonSchema(TEAM_TOOL_INPUTS[name]),
  }));
}

/** ContextSnapshot.toolSchemaHash: digest of the ordered tool schemas. */
export function toolSchemaHash(): Digest {
  return digest(toolSchemas());
}
