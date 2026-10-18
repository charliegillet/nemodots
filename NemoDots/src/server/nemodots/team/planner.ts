// The Nemotron planner (W4.1). Input is the goal plus two fresh readings: the
// checkout health and the configuration membership. The plan is the model's
// strict JSON; this module only validates it (PlanSchema) and allows one
// correction turn. Nothing about the plan is scripted. The published plan
// carries `createdByModelCallId` and no evidence edge from the planner's reads
// (D1): provenance, not dependence.
import { z } from 'zod';
import {
  PlanSchema,
  PlanShapeSchema,
  type ModelCallId,
  type Plan,
  type SourceKey,
  type TaskId,
} from '../contracts/index.js';
import type { HistoryItemInput } from '../context/index.js';
import type { HandlerHelpers, HandlerOutcome } from '../coordinator/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import { buildContext } from './context-input.js';
import { failureOutcome } from './failures.js';
import { callModel } from './model-call.js';
import { CORRECTION_NOTICE } from './prompts.js';
import type { TeamDeps } from './types.js';

export const PLAN_SOURCES = ['checkout.health', 'checkout.config'] as const;

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export const PLAN_RESPONSE_FORMAT = Object.freeze({
  name: 'incident_plan',
  schema: jsonSchemaOf(PlanShapeSchema),
});

export type PlanKind = 'plan' | 'replan';

export interface PlanParse {
  plan: Plan;
  cancelTaskIds: TaskId[];
}

export type PlanParseResult =
  { ok: true; value: PlanParse } | { ok: false; issues: string };

/** Plan validation shared by plan and replan; `extra` adds mode-specific checks. */
export function parsePlanText(
  text: string,
  extra?: (raw: unknown) => { cancelTaskIds: TaskId[]; issues: string[] },
): PlanParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: 'the reply is not valid JSON' };
  }
  const issues: string[] = [];
  let cancelTaskIds: TaskId[] = [];
  let planRaw = raw;
  if (extra) {
    const parsed = extra(raw);
    issues.push(...parsed.issues);
    cancelTaskIds = parsed.cancelTaskIds;
    planRaw = { tasks: (raw as { tasks?: unknown })?.tasks };
  }
  const plan = PlanSchema.safeParse(planRaw);
  if (!plan.success)
    issues.push(
      ...plan.error.issues
        .slice(0, 6)
        .map(
          (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        ),
    );
  if (issues.length > 0 || !plan.success)
    return { ok: false, issues: issues.join('; ') };
  return { ok: true, value: { plan: plan.data, cancelTaskIds } };
}

export async function runPlanning(
  deps: TeamDeps,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
  options: {
    kind: PlanKind;
    task: { title: string; question: string };
    invalidations?: Parameters<typeof buildContext>[0]['invalidations'];
    responseFormat: { name: string; schema: Record<string, unknown> };
    parse: (text: string) => PlanParseResult;
  },
): Promise<HandlerOutcome> {
  const { context } = claimed;
  // Two fresh readings; the planner decides everything else.
  const receipts = [];
  for (const sourceKey of PLAN_SOURCES)
    receipts.push(
      await deps.observer.observe(context, {
        sourceKey: sourceKey as SourceKey,
        modelCallId: null,
        toolCallId: null,
      }),
    );
  const history: HistoryItemInput[] = [];
  for (let turn = 0; turn < 2; turn += 1) {
    await helpers.checkpoint();
    const compiled = buildContext({
      deps,
      claimed,
      history,
      receipts,
      invalidations: options.invalidations,
      noTools: true,
      task: options.task,
    });
    const call = await callModel({
      deps,
      claimed,
      helpers,
      compiled,
      role: options.kind === 'replan' ? 'replan' : 'planner',
      maxTokens: deps.config.plannerMaxTokens ?? 2048,
      responseFormat: options.responseFormat,
    });
    const failure = failureOutcome(call.result);
    if (failure) return failure;
    const text = (call.result.content ?? '').trim();
    const parsed =
      call.result.outcome === 'completed' && text !== ''
        ? options.parse(text)
        : ({ ok: false, issues: 'the reply was empty or invalid' } as const);
    if (parsed.ok)
      return {
        type: 'plan',
        plan: parsed.value.plan,
        createdByModelCallId: call.modelCallId as ModelCallId,
        ...(parsed.value.cancelTaskIds.length > 0
          ? { cancelTaskIds: parsed.value.cancelTaskIds }
          : {}),
      };
    deps.onEvent?.({
      kind: 'correction',
      attemptId: context.attemptId,
      reason: 'plan_rejected',
    });
    history.push({ role: 'assistant', content: text, dependencyVector: [] });
    history.push({
      role: 'user',
      content: CORRECTION_NOTICE(parsed.issues),
      dependencyVector: [],
    });
  }
  return { type: 'failed', reason: 'invalid_output' };
}

export function runPlanner(
  deps: TeamDeps,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
): Promise<HandlerOutcome> {
  return runPlanning(deps, claimed, helpers, {
    kind: 'plan',
    task: {
      title: 'Plan the incident response',
      question:
        'Using the mission goal and the health and configuration readings in the evidence section, produce the plan: 2 to 6 tasks with roles, capabilities and dependencies, as strict JSON.',
    },
    responseFormat: PLAN_RESPONSE_FORMAT,
    parse: (text) => parsePlanText(text),
  });
}
