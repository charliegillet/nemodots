// One model call: compiled context -> InferencePort -> ModelCallRecord ->
// coordinator.recordModelCall (fenced, one transaction with the snapshot).
// Every call the team makes goes through here, so every call is compiled by
// context/compile.ts and recorded, planner calls included.
import { randomUUID } from 'node:crypto';
import {
  digest,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ContextSnapshot,
  type ContextSnapshotId,
  type ModelCallId,
  type ModelCallRecord,
  type ModelRole,
  type ProviderMode,
} from '../contracts/index.js';
import type { CompiledContext } from '../context/index.js';
import {
  AttemptAbortedError,
  type HandlerHelpers,
} from '../coordinator/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import type { TeamDeps } from './types.js';

export interface ModelCallOutput {
  modelCallId: ModelCallId;
  result: ChatResult;
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
}

export function newSnapshotId(deps: Pick<TeamDeps, 'ids'>): ContextSnapshotId {
  return (deps.ids?.() ?? randomUUID()) as ContextSnapshotId;
}

/** Compiled context -> OpenAI-shaped messages (system first). */
export function toChatMessages(compiled: CompiledContext): ChatMessage[] {
  return [
    { role: 'system', content: compiled.system },
    ...compiled.messages.map((message): ChatMessage => {
      if (message.role === 'tool')
        return {
          role: 'tool',
          toolCallId: message.toolCallId,
          content: message.content,
        };
      if (message.role === 'assistant')
        return {
          role: 'assistant',
          content: message.content === '' ? null : message.content,
          toolCalls: (message.toolCalls ?? []).map((call) => ({
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        };
      return { role: 'user', content: message.content };
    }),
  ];
}

export async function callModel(input: {
  deps: TeamDeps;
  claimed: ClaimedAttempt;
  helpers: HandlerHelpers;
  compiled: CompiledContext;
  role: ModelRole;
  maxTokens: number;
  responseFormat?: ChatRequest['responseFormat'];
}): Promise<ModelCallOutput> {
  const { deps, claimed, helpers, compiled } = input;
  const modelCallId = (deps.ids?.() ?? randomUUID()) as ModelCallId;
  const request: ChatRequest = {
    model: deps.config.model,
    messages: toChatMessages(compiled),
    tools: compiled.tools,
    toolSchemaHash:
      compiled.tools.length > 0 ? compiled.snapshot.toolSchemaHash : null,
    maxTokens: input.maxTokens,
    // Reasoning is on by default on Nemotron; small budgets are consumed by it.
    reasoningEffort: 'none',
    responseFormat: input.responseFormat ?? null,
    // No delta consumer: nothing here needs onAttemptReset.
    stream: false,
  };
  const result = await deps.inference.complete(request, {
    signal: helpers.signal,
    modelCallId,
    role: input.role,
  });
  const stamp = (result as { provider?: { host: string; mode: ProviderMode } })
    .provider;
  const record: ModelCallRecord = {
    id: modelCallId,
    scope: deps.reads.scope(claimed.context),
    taskId: claimed.context.taskId,
    attemptId: claimed.context.attemptId,
    role: input.role,
    model: { requested: deps.config.model, returned: result.modelReturned },
    provider: stamp ?? deps.config.provider,
    contextSnapshotId: compiled.snapshot.id,
    attempts: result.attempts,
    outcome: result.outcome,
    outputDigest:
      result.content === null && result.toolCalls.length === 0
        ? null
        : digest({ content: result.content, toolCalls: result.toolCalls }),
    outputDependencyVector: compiled.snapshot.dependencyVector,
    toolCalls: result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      argumentsDigest: digest(call.arguments),
    })),
    createdAt: (deps.clock?.() ?? new Date()).toISOString(),
  };
  // Fenced and support-checked; FenceError / SupportError reach the worker
  // host, which reports the attempt as fenced or support_rejected.
  await deps.coordinator.recordModelCall(claimed.context, {
    record,
    snapshot: compiled.snapshot,
  });
  deps.onEvent?.({
    kind: 'model_call',
    modelCallId,
    attemptId: claimed.context.attemptId,
    role: input.role,
    outcome: result.outcome,
  });
  if (helpers.signal.aborted) throw abortError(helpers);
  return { modelCallId, result, record, snapshot: compiled.snapshot };
}

export function abortError(helpers: HandlerHelpers): Error {
  const reason = helpers.signal.reason;
  return reason instanceof Error
    ? reason
    : new AttemptAbortedError(helpers.abortReason() ?? 'host_stopped');
}
