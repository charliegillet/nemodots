import { randomUUID } from 'node:crypto';
import {
  digest,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ContextSnapshot,
  type ModelCallId,
  type ModelCallRecord,
  type ModelRole,
  type Scope,
  type AttemptContext,
} from '../contracts/index.js';
import type { CompiledContext } from '../context/compile.js';
import type { TeamCoordinator, TeamInference } from './types.js';

// One inference call of the team: the compiled context becomes the request
// (one system message, ordered tool schemas, reasoning_effort none, no
// tool_choice), the result is stamped with the provider that served it, and
// the call is recorded through the coordinator (fenced, support-checked) with
// its context snapshot. Nothing is executed here.

export const WORKER_MAX_TOKENS = 1536;
export const PLANNER_MAX_TOKENS = 2048;

export interface ModelCallParams {
  context: AttemptContext;
  scope: Scope;
  role: ModelRole;
  model: string;
  compiled: CompiledContext;
  maxTokens: number;
  responseFormat: ChatRequest['responseFormat'];
  signal: AbortSignal;
}

export interface ModelCallDeps {
  inference: TeamInference;
  coordinator: Pick<TeamCoordinator, 'recordModelCall'>;
  clock: () => Date;
  newId?: () => string;
}

export interface ModelCallOutcome {
  result: ChatResult;
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
  modelCallId: ModelCallId;
}

export function toChatMessages(compiled: CompiledContext): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: compiled.system },
  ];
  for (const message of compiled.messages) {
    if (message.role === 'tool')
      messages.push({
        role: 'tool',
        toolCallId: message.toolCallId,
        content: message.content,
      });
    else if (message.role === 'assistant')
      messages.push({
        role: 'assistant',
        content: message.content,
        toolCalls: (message.toolCalls ?? []).map((call) => ({
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });
    else messages.push({ role: 'user', content: message.content });
  }
  return messages;
}

export async function runModelCall(
  deps: ModelCallDeps,
  params: ModelCallParams,
): Promise<ModelCallOutcome> {
  const { compiled } = params;
  const modelCallId = (deps.newId ?? randomUUID)() as ModelCallId;
  const request: ChatRequest = {
    model: params.model,
    messages: toChatMessages(compiled),
    tools: compiled.tools,
    toolSchemaHash: compiled.snapshot.toolSchemaHash,
    maxTokens: params.maxTokens,
    reasoningEffort: 'none',
    responseFormat: params.responseFormat,
    stream: false,
  };
  const result = await deps.inference.complete(request, {
    signal: params.signal,
    modelCallId,
    role: params.role,
  });
  const stamp = (result as { provider?: { host: string; mode: 'live' | 'fixture' } })
    .provider ?? { host: deps.inference.host(), mode: deps.inference.mode };
  const failed =
    result.outcome === 'failed' || result.outcome === 'aborted';
  const record: ModelCallRecord = {
    id: modelCallId,
    scope: params.scope,
    taskId: params.context.taskId,
    attemptId: params.context.attemptId,
    role: params.role,
    model: { requested: params.model, returned: result.modelReturned },
    provider: { host: stamp.host, mode: stamp.mode },
    contextSnapshotId: compiled.snapshot.id,
    attempts: result.attempts,
    outcome: result.outcome,
    outputDigest: failed
      ? null
      : digest({ content: result.content, toolCalls: result.toolCalls }),
    // Outputs depend on at least what the call was given (citations add, never remove).
    outputDependencyVector: compiled.snapshot.dependencyVector,
    toolCalls: result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      argumentsDigest: digest(call.arguments),
    })),
    createdAt: deps.clock().toISOString(),
  };
  await deps.coordinator.recordModelCall(params.context, {
    record,
    snapshot: compiled.snapshot,
  });
  return { result, record, snapshot: compiled.snapshot, modelCallId };
}
