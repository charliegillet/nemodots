// TanStack chat middleware for Dot turns (TOOL_COVERAGE section 2). It
//  - computes a ContextSnapshot at the start of every model iteration,
//  - enforces the tool policy registry for incident Dots (`skip` + a visible
//    tool error, in addition to withToolPolicy),
//  - records tool results and lets the sink register receipts for read tools,
//  - turns each iteration's observed provider requests into a ModelCallRecord
//    handed to an injected `recordModelCall` sink.
// Every sink method is optional; without a sink nothing is recorded.
import { randomUUID } from 'node:crypto';
import type { ChatMiddleware } from '@tanstack/ai';
import {
  ContextSnapshotSchema,
  ModelCallRecordSchema,
  digest,
  unionDependencyVectors,
  type ContextSnapshot,
  type Digest,
  type InferenceAttempt,
  type ModelCallOutcome,
  type ModelCallRecord,
  type ProviderMode,
} from '../contracts/index.js';
import type { FetchTelemetry, ObservedRequest } from './fetch-telemetry.js';
import { addToScopeVector, type ProvenanceScope } from './provenance-scope.js';
import { checkToolCall, type ToolPolicyScope } from './with-tool-policy.js';
import { classifyTool } from './policy-registry.js';
import type { ProvenanceSink } from './sink.js';

export type { ProvenanceSink, ToolResultInfo, TurnIdentity } from './sink.js';

export interface TurnFacts {
  dotId: string;
  threadId: string;
  requestedModel: string;
  providerHost: string;
  providerMode: ProviderMode;
  pageSnapshots: { pageId: string; revision: number; digest: Digest }[];
  memories: { id: string; digest: Digest }[];
}

export interface ProvenanceOptions {
  scope: ProvenanceScope;
  sink: ProvenanceSink;
  telemetry: FetchTelemetry;
  facts: TurnFacts;
  policy: ToolPolicyScope;
  now?: () => Date;
}

export interface ProvenanceMiddleware {
  middleware: ChatMiddleware;
  snapshots: readonly ContextSnapshot[];
  records: readonly ModelCallRecord[];
  /** Resolves once the terminal hook has flushed every ModelCallRecord. */
  flushed(): Promise<void>;
}

interface Iteration {
  snapshot: ContextSnapshot;
  requestStart: number;
  toolCalls: { toolCallId: string; name: string; argumentsDigest: Digest }[];
  content: string;
}

const safeDigest = (value: unknown): Digest => {
  try {
    return digest(value ?? null);
  } catch {
    return digest(String(value));
  }
};
const bytes = (value: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
};

function attemptOf(request: ObservedRequest, n: number): InferenceAttempt {
  return {
    n,
    startedAt: request.startedAt,
    headersAt: request.headersAt,
    firstContentAt: request.firstContentAt,
    finishedAt: request.finishedAt,
    httpStatus: request.httpStatus,
    usage: request.usage,
    finishReason: request.finishReason,
    error: request.error,
    retryAfterMs: null,
    streamed: request.streamed,
    outcome: 'recorded',
  };
}

export function provenanceMiddleware(
  options: ProvenanceOptions,
): ProvenanceMiddleware {
  const { scope, sink, telemetry, facts } = options;
  const now = options.now ?? (() => new Date());
  const iterations: Iteration[] = [];
  const snapshots: ContextSnapshot[] = [];
  const records: ModelCallRecord[] = [];
  let flush: Promise<void> | null = null;

  const current = () => iterations[iterations.length - 1];

  const build = (): ModelCallRecord[] => {
    const identity = sink.identify?.({
      dotId: facts.dotId,
      threadId: facts.threadId,
    });
    if (!identity) return [];
    const out: ModelCallRecord[] = [];
    iterations.forEach((iteration, index) => {
      const end =
        index + 1 < iterations.length
          ? iterations[index + 1].requestStart
          : telemetry.requests.length;
      const slice = telemetry.requests.slice(iteration.requestStart, end);
      if (slice.length === 0) return;
      const last = slice[slice.length - 1];
      const cancelled = last.error?.class === 'cancelled';
      const outcome: ModelCallOutcome = cancelled
        ? 'aborted'
        : last.error || !last.httpStatus
          ? 'failed'
          : last.finishReason === 'tool_calls' && iteration.toolCalls.length
            ? 'tool_calls'
            : 'completed';
      const record = ModelCallRecordSchema.parse({
        id: randomUUID(),
        scope: identity.scope,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        role: identity.role,
        model: {
          requested: facts.requestedModel,
          returned:
            [...slice].reverse().find((r) => r.modelReturned)?.modelReturned ??
            null,
        },
        provider: {
          host: last.host || facts.providerHost,
          mode: facts.providerMode,
        },
        contextSnapshotId: iteration.snapshot.id,
        attempts: slice.map((request, i) => attemptOf(request, i + 1)),
        outcome,
        outputDigest:
          outcome === 'failed' || cancelled
            ? null
            : safeDigest({
                content: iteration.content,
                toolCalls: iteration.toolCalls,
              }),
        // Conservative: an output depends on everything its call was given.
        outputDependencyVector: iteration.snapshot.dependencyVector,
        toolCalls: iteration.toolCalls,
        createdAt: now().toISOString(),
      });
      out.push(record);
    });
    return out;
  };

  const finish = (ctx: { defer: (p: Promise<unknown>) => void }) => {
    if (flush) return;
    flush = (async () => {
      await telemetry.settled();
      for (const record of build()) {
        records.push(record);
        await sink.recordModelCall?.(record);
      }
    })().catch(() => undefined);
    ctx.defer(flush);
  };

  const middleware: ChatMiddleware = {
    name: 'nemodots-provenance',
    onConfig(ctx, config) {
      if (ctx.phase !== 'beforeModel') return;
      const tools = config.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
      const toolSchemaHash = safeDigest(tools);
      const system = config.systemPrompts.map((p) => String(p));
      const history = config.messages.map((message) => ({
        role: message.role,
        digest: safeDigest(message),
      }));
      const prefix = { tools: toolSchemaHash };
      const snapshot = ContextSnapshotSchema.parse({
        id: randomUUID(),
        contextSchemaVersion: 'v1',
        layout: 'ordinary',
        prefixDigest: safeDigest(prefix),
        prefixLength: bytes(tools),
        contextDigest: safeDigest({ system, history }),
        contextLength: bytes(tools) + bytes(system) + bytes(config.messages),
        toolSchemaHash,
        injected: {
          receipts: [],
          inheritedArtifacts: [],
          runbooks: [],
          pageSnapshots: facts.pageSnapshots,
          memories: facts.memories,
          invalidationEvents: [],
          historyItems: history
            .filter(
              (h) =>
                h.role === 'assistant' ||
                h.role === 'tool' ||
                h.role === 'user',
            )
            .map((h) => ({
              role: h.role as 'assistant' | 'tool' | 'user',
              digest: h.digest,
              dependencyReceiptIds: [],
            })),
        },
        dependencyVector: unionDependencyVectors(scope.dependencyVector),
        volatile: { nowIso: now().toISOString() },
      });
      snapshots.push(snapshot);
      iterations.push({
        snapshot,
        requestStart: telemetry.requests.length,
        toolCalls: [],
        content: '',
      });
      return sink.recordSnapshot
        ? Promise.resolve(sink.recordSnapshot(snapshot)).then(() => undefined)
        : undefined;
    },
    onChunk(ctx) {
      const iteration = current();
      if (iteration) iteration.content = ctx.accumulatedContent;
    },
    onBeforeToolCall(_ctx, hook) {
      current()?.toolCalls.push({
        toolCallId: hook.toolCallId,
        name: hook.toolName,
        argumentsDigest: safeDigest(hook.args),
      });
      const refusal = checkToolCall(options.policy, hook.toolName, hook.args);
      if (!refusal) return;
      options.policy.onRefusal?.({ ...refusal, toolName: hook.toolName });
      return {
        type: 'skip',
        result: { status: 'refused', error: refusal.message },
      };
    },
    async onAfterToolCall(_ctx, info) {
      if (!info.ok || !sink.registerToolResult) return;
      if (classifyTool(info.toolName).class !== 'read') return;
      const entries = await sink.registerToolResult({
        toolName: info.toolName,
        toolCallId: info.toolCallId,
        args: info.toolCall?.function?.arguments,
        result: info.result,
        resultDigest: safeDigest(info.result),
      });
      if (entries && entries.length) addToScopeVector(scope, entries);
    },
    onFinish(ctx) {
      finish(ctx);
    },
    onAbort(ctx) {
      finish(ctx);
    },
    onError(ctx) {
      finish(ctx);
    },
  };

  return {
    middleware,
    snapshots,
    records,
    flushed: () => flush ?? Promise.resolve(),
  };
}
