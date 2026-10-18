import { randomUUID } from 'node:crypto';
import {
  unionDependencyVectors,
  type ContextSnapshotId,
  type DependencyEntry,
  type DependencyVector,
  type ModelRole,
} from '../contracts/index.js';
import {
  compileContext,
  type HistoryItemInput,
  type InheritedArtifactInput,
} from '../context/compile.js';
import { selectReceiptsForTask } from '../context/scope.js';
import type { ContextReceipt } from '../context/index.js';
import { FenceError, isSupportError } from '../coordinator/errors.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import {
  AttemptAbortedError,
  type HandlerHelpers,
  type HandlerOutcome,
} from '../coordinator/worker-host.js';
import { MAX_LOOP_ITERATIONS, createAttemptBudget } from './budget.js';
import { WORKER_MAX_TOKENS, runModelCall } from './call.js';
import { BudgetExhaustedError, ToolError } from './errors.js';
import { toContextReceipt, toEntry } from './evidence.js';
import { classifyCall } from './outcomes.js';
import {
  COMMON_INSTRUCTIONS,
  EMPTY_TURN_CORRECTION,
  REPAIR_NOTE,
  TOOL_JSON_CORRECTION,
  roleInstructions,
} from './prompts.js';
import { prepareRepairContext } from './replan.js';
import type { TeamTools } from './tools.js';
import type {
  ObservationPort,
  RunbookLibrary,
  TeamCoordinator,
  TeamInference,
  TeamReader,
} from './types.js';

// The worker tool loop (ARCHITECTURE.md section 11). At most 12 iterations;
// every call is compiled by context/compile.ts (so its provenance is captured)
// and recorded through the coordinator before any of its tool calls run; the
// readset grows with observe_source; the loop aborts at every boundary when
// the host reports drift (readset invalidated, pause, cancel, lease lost).
// Malformed tool JSON gets one correction, then failed(invalid_output).

export const MAX_TOOL_CALLS_PER_TURN = 4;
const MAX_INHERITED_RECEIPTS = 12;
const OUTPUT_SUMMARY_MAX = 4_000;

export interface WorkerDeps {
  inference: TeamInference;
  coordinator: TeamCoordinator;
  reader: TeamReader;
  observer: ObservationPort;
  tools: TeamTools;
  runbooks: RunbookLibrary;
  clock: () => Date;
  /** Fallback when the mission row names no worker model. */
  workerModel: string;
  newId?: () => string;
  onError?: (error: unknown) => void;
}

interface Tally {
  delegated: { taskId: string; role: string }[];
  proposed: { actionId: string; status: string; action: string }[];
  findings: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim() === '') return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function runWorker(
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
  deps: WorkerDeps,
): Promise<HandlerOutcome> {
  const { context } = claimed;
  const mission = await deps.reader.mission(context.missionId);
  const model = mission.provider.workerModel || deps.workerModel;
  const modelRole: ModelRole =
    claimed.attempt.kind === 'repair' ? 'repair' : 'worker';
  const nowIso = deps.clock().toISOString();

  // Fresh scoped reads and the invalidation summary for a repair; nothing of
  // the earlier transcript is replayed.
  const repair = await prepareRepairContext(claimed, deps);

  const inherited = claimed.attempt.inheritedDependencyVector;
  const candidates = await deps.reader.receipts(
    inherited.map((entry) => entry.receiptId),
  );
  const fresh = repair.fresh.map(toContextReceipt);
  const scoped = selectReceiptsForTask({
    candidates,
    readSetReceiptIds: [],
    inheritedVector: inherited,
    requestedKeys: [],
    maxReceipts: MAX_INHERITED_RECEIPTS,
  });
  const receiptById = new Map<string, ContextReceipt>();
  for (const receipt of [...scoped.receipts, ...fresh])
    receiptById.set(receipt.id, receipt);
  // A fresh read of a key replaces an inherited receipt of the same key.
  const freshKeys = new Set(fresh.map((r) => r.source.key));
  const evidence = [...receiptById.values()].filter(
    (r) => !freshKeys.has(r.source.key) || fresh.some((f) => f.id === r.id),
  );

  const prerequisites = await deps.reader.prerequisiteOutputs(
    context.missionId,
    context.taskId,
  );
  const artifacts: InheritedArtifactInput[] = prerequisites
    .filter((output) => output.usable)
    .map((output) => ({
      kind: 'task_output' as const,
      id: output.id,
      digest: output.digest,
      text: JSON.stringify({
        task: output.taskTitle,
        role: output.role,
        kind: output.kind,
        content: output.content,
      }),
      usable: true,
      dependencyVector: output.dependencyVector,
    }));

  const budget = createAttemptBudget({
    maxIterations: claimed.task.maxIterations,
    taskMaxTokens: claimed.task.maxTokens,
    missionMaxTokens: mission.budgets.maxTokens,
    missionMaxCalls: mission.budgets.maxInferenceCalls,
    missionUsage: () => deps.reader.missionUsage(context.missionId),
  });

  const roleText =
    claimed.attempt.kind === 'repair'
      ? `${roleInstructions(context.role)}\n\n${REPAIR_NOTE}`
      : roleInstructions(context.role);

  const history: HistoryItemInput[] = [];
  const readSet = new Map<string, DependencyEntry>(
    repair.fresh.map((r) => [r.receiptId, toEntry(r)]),
  );
  const tally: Tally = { delegated: [], proposed: [], findings: [] };
  let malformed = 0;

  for (;;) {
    await helpers.checkpoint();
    try {
      await budget.beforeCall();
    } catch (error) {
      if (error instanceof BudgetExhaustedError)
        return { type: 'abort', reason: 'budget_exhausted' };
      throw error;
    }
    const compiled = compileContext({
      snapshotId: (deps.newId ?? randomUUID)() as ContextSnapshotId,
      layout: 'cache_aware',
      nowIso,
      commonInstructions: COMMON_INSTRUCTIONS,
      roleInstructions: roleText,
      mission: { goal: mission.goal, constraints: mission.constraints },
      task: {
        title: claimed.task.title,
        question: `${claimed.task.question}\n\nTurn ${budget.iterations} of at most ${Math.min(claimed.task.maxIterations, MAX_LOOP_ITERATIONS)}.`,
      },
      runbooks: deps.runbooks.all(),
      receipts: evidence,
      inheritedArtifacts: artifacts,
      pageSnapshots: [],
      memories: [],
      invalidations: repair.invalidations,
      history,
      itemCapBytes: 8192,
      readSetVector: unionDependencyVectors([...readSet.values()]),
      inheritedVector: inherited,
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
        role: modelRole,
        model,
        compiled,
        maxTokens: WORKER_MAX_TOKENS,
        responseFormat: null,
        signal: helpers.signal,
      },
    );
    budget.record(call.result.usage);
    const lastVector: DependencyVector = call.snapshot.dependencyVector;

    const disposition = classifyCall(call.result);
    if (disposition.kind === 'cancelled') {
      await helpers.checkpoint();
      return { type: 'failed', reason: 'inference_cancelled' };
    }
    if (disposition.kind === 'stop') return disposition.outcome;

    // Distinct tool call ids only (the request shape forbids repeats).
    const seen = new Set<string>();
    const calls = call.result.toolCalls.filter((c) => {
      if (seen.has(c.toolCallId)) return false;
      seen.add(c.toolCallId);
      return true;
    });
    const text = (call.result.content ?? '').trim();

    if (disposition.kind === 'invalid' || (calls.length === 0 && text === '')) {
      malformed += 1;
      if (malformed > 1) return { type: 'failed', reason: 'invalid_output' };
      history.push({
        role: 'assistant',
        content: call.result.content ?? '',
        ...(calls.length > 0
          ? {
              toolCalls: calls.map((c) => ({
                id: c.toolCallId,
                name: c.name,
                arguments: c.arguments,
              })),
            }
          : {}),
        dependencyVector: lastVector,
      });
      if (calls.length > 0)
        for (const c of calls)
          history.push({
            role: 'tool',
            toolCallId: c.toolCallId,
            toolName: c.name,
            content: JSON.stringify({
              error: 'invalid_output',
              message: 'the turn was cut off or malformed; nothing ran',
            }),
            dependencyVector: [],
          });
      else
        history.push({
          role: 'user',
          content: EMPTY_TURN_CORRECTION,
          dependencyVector: [],
        });
      continue;
    }

    if (calls.length === 0) {
      const kind =
        context.role === 'verifier' || context.role === 'postcondition'
          ? ('verification' as const)
          : ('handoff' as const);
      return {
        type: 'output',
        output: {
          kind,
          content: {
            role: context.role,
            summary: text.slice(0, OUTPUT_SUMMARY_MAX),
            findings: tally.findings,
            delegated: tally.delegated,
            proposed: tally.proposed,
            iterations: budget.iterations,
          },
          dependencyVector: lastVector,
        },
      };
    }

    history.push({
      role: 'assistant',
      content: call.result.content ?? '',
      toolCalls: calls.map((c) => ({
        id: c.toolCallId,
        name: c.name,
        arguments: c.arguments,
      })),
      dependencyVector: lastVector,
    });

    for (const [index, toolCall] of calls.entries()) {
      const push = (value: unknown, vector: DependencyVector = []) =>
        history.push({
          role: 'tool',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.name,
          content: JSON.stringify(value),
          dependencyVector: vector,
        });
      if (index >= MAX_TOOL_CALLS_PER_TURN) {
        push({
          error: 'too_many_tool_calls',
          message: `at most ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn; this one did not run`,
        });
        continue;
      }
      const args = parseArguments(toolCall.arguments);
      if (args === null) {
        malformed += 1;
        push({ error: 'invalid_json', message: TOOL_JSON_CORRECTION });
        if (malformed > 1) return { type: 'failed', reason: 'invalid_output' };
        continue;
      }
      await helpers.checkpoint();
      try {
        const execution = await deps.tools.executeDetailed(
          toolCall.name,
          args,
          {
            context,
            toolCallId: toolCall.toolCallId,
            modelCallId: call.modelCallId,
            snapshotVector: call.snapshot.dependencyVector,
            signal: helpers.signal,
            checkpoint: () => helpers.checkpoint(),
          },
        );
        if (execution.observed)
          readSet.set(
            execution.observed.receiptId,
            toEntry(execution.observed),
          );
        const value = record(execution.value);
        if (toolCall.name === 'delegate_task' && value?.taskId)
          tally.delegated.push({
            taskId: String(value.taskId),
            role: String(value.role),
          });
        else if (toolCall.name === 'propose_action' && value?.actionId)
          tally.proposed.push({
            actionId: String(value.actionId),
            status: String(value.status),
            action: String(value.action),
          });
        else if (toolCall.name === 'publish_finding' && value?.findingId)
          tally.findings.push(String(value.findingId));
        push(execution.value, execution.dependencyVector);
      } catch (error) {
        if (
          error instanceof FenceError ||
          error instanceof AttemptAbortedError ||
          isSupportError(error)
        )
          throw error;
        if (error instanceof ToolError) {
          push(error.toResult());
          continue;
        }
        deps.onError?.(error);
        push({
          error: 'tool_failed',
          message: 'the tool failed unexpectedly; its effect is unknown',
        });
      }
    }
  }
}
