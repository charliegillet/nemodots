// Specialist/investigator/verifier loop (W4.1): at most 12 iterations, every
// call compiled and recorded, tool results fed back as untrusted data, readset
// growing with observe_source. Before every call the host's checkpoint runs, so
// a readset invalidation, pause, cancel or lease loss aborts the loop before
// the next model call. Malformed output gets one correction, then
// failed(invalid_output). Nothing about the incident is decided here: the
// model chooses sources, delegation, proposals and its answer.
import {
  unionDependencyVectors,
  type DependencyEntry,
  type ModelRole,
} from '../contracts/index.js';
import {
  selectInheritedArtifacts,
  type HistoryItemInput,
} from '../context/index.js';
import type { HandlerHelpers, HandlerOutcome } from '../coordinator/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import { createBudget } from './budget.js';
import { buildContext } from './context-input.js';
import { failureOutcome } from './failures.js';
import { callModel } from './model-call.js';
import { CORRECTION_NOTICE, FINAL_ITERATION_NOTICE } from './prompts.js';
import { createToolExecutor, newLoopState } from './tools.js';
import type { TeamDeps } from './types.js';

const SUMMARY_MAX = 8000;

export async function runWorker(
  deps: TeamDeps,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
): Promise<HandlerOutcome> {
  const { context } = claimed;
  const state = newLoopState();
  const executor = createToolExecutor(deps, claimed, helpers, state);
  const budget = createBudget({
    maxIterations: Math.min(
      claimed.task.maxIterations,
      deps.config.maxIterations ?? 12,
    ),
    maxTokens: claimed.task.maxTokens,
  });
  const modelRole: ModelRole =
    claimed.attempt.kind === 'repair' ? 'repair' : 'worker';
  const repairOf = claimed.attempt.repairOf;

  // Fresh scoped inputs only: prerequisite outputs that are still usable and,
  // for a repair, the summary of what changed. Never the old transcript.
  const inherited = selectInheritedArtifacts(
    await deps.reads.prerequisiteOutputs(context),
    8,
  ).artifacts;
  const invalidations = repairOf
    ? await deps.reads.invalidationSummaries(
        context,
        repairOf.invalidationEventId,
      )
    : [];

  const history: HistoryItemInput[] = [];
  let corrections = 0;

  while (budget.next()) {
    await helpers.checkpoint();
    if (budget.tokensExhausted())
      return { type: 'abort', reason: 'budget_exhausted' };
    const last = budget.isLastIteration();
    if (last)
      history.push({
        role: 'user',
        content: FINAL_ITERATION_NOTICE,
        dependencyVector: [],
      });
    const compiled = buildContext({
      deps,
      claimed,
      history,
      artifacts: inherited,
      invalidations,
      readSetVector: state.readSet,
      noTools: last,
    });
    const lastVector = compiled.snapshot.dependencyVector;
    const call = await callModel({
      deps,
      claimed,
      helpers,
      compiled,
      role: modelRole,
      maxTokens: deps.config.maxTokens ?? 1536,
    });
    budget.spend(call.record.attempts.at(-1)?.usage ?? null);
    const failure = failureOutcome(call.result);
    if (failure) return failure;

    const { result } = call;
    if (result.toolCalls.length > 0 && !last) {
      history.push({
        role: 'assistant',
        content: result.content ?? '',
        toolCalls: result.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.name,
          arguments: tc.arguments,
        })),
        dependencyVector: [],
      });
      let malformed = false;
      for (const tc of result.toolCalls) {
        let args: unknown;
        let outcome;
        try {
          args = tc.arguments.trim() === '' ? {} : JSON.parse(tc.arguments);
          outcome = await executor.execute(tc.name, args, {
            toolCallId: tc.toolCallId,
            modelCallId: call.modelCallId,
            snapshot: call.snapshot,
          });
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          malformed = true;
          outcome = {
            ok: false,
            content: JSON.stringify({
              ok: false,
              error: 'invalid_json',
              message: 'tool arguments must be one valid JSON object',
            }),
            vector: [] as DependencyEntry[],
          };
        }
        history.push({
          role: 'tool',
          toolCallId: tc.toolCallId,
          toolName: tc.name,
          content: outcome.content,
          dependencyVector: outcome.vector,
        });
        await helpers.checkpoint();
      }
      if (malformed) {
        corrections += 1;
        deps.onEvent?.({
          kind: 'correction',
          attemptId: context.attemptId,
          reason: 'invalid_json',
        });
        if (corrections > 1)
          return { type: 'failed', reason: 'invalid_output' };
      }
      continue;
    }

    const text = (result.content ?? '').trim();
    if (text === '' || result.toolCalls.length > 0) {
      // empty or truncated reply (or tool calls on the no-tools last step)
      corrections += 1;
      deps.onEvent?.({
        kind: 'correction',
        attemptId: context.attemptId,
        reason: 'unusable_reply',
      });
      if (corrections > 1 || last)
        return { type: 'failed', reason: 'invalid_output' };
      history.push({
        role: 'assistant',
        content: text,
        dependencyVector: [],
      });
      history.push({
        role: 'user',
        content: CORRECTION_NOTICE('empty or truncated reply'),
        dependencyVector: [],
      });
      continue;
    }

    // Final answer: published as this task's output. The vector is a
    // conservative union of everything the attempt read, inherited or was told.
    const vector = unionDependencyVectors(
      lastVector,
      state.readSet,
      ...history.map((item) => item.dependencyVector),
    );
    return {
      type: 'output',
      output: {
        kind:
          context.role === 'verifier' || context.role === 'postcondition'
            ? 'verification'
            : 'handoff',
        content: {
          summary: text.slice(0, SUMMARY_MAX),
          findingIds: state.findingIds,
          delegatedTaskIds: state.delegated,
          proposedActionIds: state.proposedActionIds,
          observedReceiptIds: state.readSetReceiptIds,
        },
        dependencyVector: vector,
      },
    };
  }
  return { type: 'failed', reason: 'iteration_limit' };
}
