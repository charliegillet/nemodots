import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PlanShapeSchema,
  digest,
  unionDependencyVectors,
  type ContextSnapshotId,
  type DependencyVector,
  type ModelCallId,
  type SourceKey,
} from '../contracts/index.js';
import { compileContext, type HistoryItemInput } from '../context/compile.js';
import type { ContextReceipt } from '../context/index.js';
import { validatePlan } from '../coordinator/plan-validation.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import type {
  HandlerHelpers,
  HandlerOutcome,
} from '../coordinator/worker-host.js';
import { createAttemptBudget, type AttemptBudget } from './budget.js';
import { BudgetExhaustedError, ToolError } from './errors.js';
import { PLANNER_MAX_TOKENS, runModelCall } from './call.js';
import { toContextReceipt, toEntry } from './evidence.js';
import { classifyCall } from './outcomes.js';
import {
  COMMON_INSTRUCTIONS,
  PLANNER_INSTRUCTIONS,
  correctionPrompt,
} from './prompts.js';
import { planOverviewText } from './replan.js';
import type {
  ObservationPort,
  ObservedReceipt,
  RunbookLibrary,
  TeamCoordinator,
  TeamInference,
  TeamReader,
} from './types.js';

// The planner (ARCHITECTURE.md section 11): strict json_schema output through
// InferencePort, validated by the contracts' PlanSchema, one bounded
// correction turn, then failed(invalid_plan). Its evidence is exactly the
// mission goal, the checkout health receipt and the membership receipt of the
// configuration (the list of keys, never their values). The plan is a
// scheduling artifact: the coordinator persists it and the planner's reads
// create no evidence dependence of the tasks (D1).

export interface PlannerDeps {
  inference: TeamInference;
  coordinator: Pick<TeamCoordinator, 'recordModelCall' | 'addReadSet'>;
  reader: Pick<
    TeamReader,
    'mission' | 'planOverview' | 'invalidation' | 'missionUsage'
  >;
  observer: ObservationPort;
  runbooks: RunbookLibrary;
  clock: () => Date;
  /** Fallback when the mission row names no planner model. */
  plannerModel: string;
  newId?: () => string;
}

/** The sources the planner reads: health and the membership list, nothing else. */
export const PLANNER_SOURCES = ['checkout.health', 'checkout.config'] as const;

export function planResponseSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PlanShapeSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function issuesOf(content: string | null, existing: number, max: number) {
  if (content === null || content.trim() === '')
    return { ok: false as const, issues: ['the output was empty'] };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false as const, issues: ['the output was not valid JSON'] };
  }
  const verdict = validatePlan(json, {
    maxTasks: max,
    existingTasks: existing,
  });
  return verdict.ok
    ? { ok: true as const, plan: verdict.plan }
    : { ok: false as const, issues: verdict.issues };
}

export async function runPlanner(
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
  deps: PlannerDeps,
): Promise<HandlerOutcome> {
  const { context } = claimed;
  const mission = await deps.reader.mission(context.missionId);
  const model = mission.provider.plannerModel || deps.plannerModel;
  const nowIso = deps.clock().toISOString();

  // Evidence: read now, record in the readset (fenced, support-checked).
  const observed: ObservedReceipt[] = [];
  const unavailable: string[] = [];
  for (const sourceKey of PLANNER_SOURCES) {
    await helpers.checkpoint();
    try {
      observed.push(
        await deps.observer.observe({
          context,
          sourceKey: sourceKey as SourceKey,
          toolCallId: `planner-read:${context.attemptId}:${sourceKey}`,
          modelCallId: null,
        }),
      );
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      unavailable.push(sourceKey);
    }
  }
  if (observed.length > 0)
    await deps.coordinator.addReadSet(
      context,
      unionDependencyVectors(observed.map(toEntry)),
    );
  const receipts: ContextReceipt[] = observed.map(toContextReceipt);
  const readSetVector: DependencyVector = unionDependencyVectors(
    observed.map(toEntry),
  );

  const overview = await deps.reader.planOverview(context.missionId);
  const replan = claimed.attempt.kind === 'replan';
  const event = claimed.attempt.repairOf
    ? await deps.reader.invalidation(
        claimed.attempt.repairOf.invalidationEventId,
        context.missionId,
      )
    : null;

  const summaryText = [
    'Existing tasks of this mission (revise the plan only for work that is not already done and still valid):',
    planOverviewText(overview),
  ].join('\n');
  const task = {
    title: replan ? 'Revise the mission plan' : 'Plan the mission',
    question: [
      replan
        ? 'The evidence behind the current plan changed. Produce the root tasks for the work that remains.'
        : 'Produce the root tasks that will restore the checkout service and satisfy the acceptance statement.',
      unavailable.length > 0
        ? `These sources could not be read right now: ${unavailable.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
  const budget: AttemptBudget = createAttemptBudget({
    maxIterations: 2,
    taskMaxTokens: claimed.task.maxTokens,
    missionMaxTokens: mission.budgets.maxTokens,
    missionMaxCalls: mission.budgets.maxInferenceCalls,
    missionUsage: () => deps.reader.missionUsage(context.missionId),
  });

  const history: HistoryItemInput[] = [];
  let lastIssues: string[] = [];
  for (let turn = 1; turn <= 2; turn += 1) {
    await helpers.checkpoint();
    try {
      await budget.beforeCall();
    } catch (error) {
      if (error instanceof BudgetExhaustedError)
        return { type: 'abort', reason: 'budget_exhausted' };
      throw error;
    }
    const compiled = compileContext({
      snapshotId: randomUUID() as ContextSnapshotId,
      layout: 'cache_aware',
      nowIso,
      commonInstructions: COMMON_INSTRUCTIONS,
      roleInstructions: PLANNER_INSTRUCTIONS,
      toolNames: [],
      mission: { goal: mission.goal, constraints: mission.constraints },
      task,
      runbooks: deps.runbooks.all(),
      receipts,
      inheritedArtifacts: replan
        ? [
            {
              kind: 'summary',
              id: 'plan-state',
              digest: digest(summaryText),
              text: summaryText,
              usable: true,
              dependencyVector: [],
            },
          ]
        : [],
      pageSnapshots: [],
      memories: [],
      invalidations: event
        ? [
            {
              id: event.id,
              summary: `Source ${event.sourceKey} changed (${event.reason}).`,
            },
          ]
        : [],
      history,
      itemCapBytes: 8192,
      readSetVector,
      inheritedVector: claimed.attempt.inheritedDependencyVector,
    });
    const call = await runModelCall(
      {
        inference: deps.inference,
        coordinator: deps.coordinator,
        clock: deps.clock,
        newId: deps.newId,
      },
      {
        context,
        scope: mission.scope,
        role: replan ? 'replan' : 'planner',
        model,
        compiled,
        maxTokens: PLANNER_MAX_TOKENS,
        responseFormat: { name: 'nemodots_plan', schema: planResponseSchema() },
        signal: helpers.signal,
      },
    );
    budget.record(call.result.usage);
    const disposition = classifyCall(call.result);
    if (disposition.kind === 'cancelled') {
      await helpers.checkpoint();
      return { type: 'failed', reason: 'inference_cancelled' };
    }
    if (disposition.kind === 'stop') return disposition.outcome;

    const checked = issuesOf(
      call.result.content,
      overview.length,
      mission.budgets.maxTasks,
    );
    if (disposition.kind === 'ok' && checked.ok)
      return {
        type: 'plan',
        plan: checked.plan,
        createdByModelCallId: call.modelCallId as ModelCallId,
      };
    lastIssues = checked.ok
      ? ['the output did not match the schema']
      : checked.issues;
    history.push(
      {
        role: 'assistant',
        content: call.result.content ?? '',
        dependencyVector: call.snapshot.dependencyVector,
      },
      {
        role: 'user',
        content: correctionPrompt(lastIssues),
        dependencyVector: [],
      },
    );
  }
  return {
    type: 'failed',
    reason: `invalid_plan: ${lastIssues.join('; ')}`.slice(0, 480),
  };
}
