import { randomUUID } from 'node:crypto';
import {
  convertSchemaToJsonSchema,
  type ChatMiddleware,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
} from '@tanstack/ai';
import {
  ContextSnapshotSchema,
  DependencyEntrySchema,
  ModelCallRecordSchema,
  digest,
  sha256Hex,
  unionDependencyVectors,
  type ContextSnapshot,
  type DependencyEntry,
  type FinishReason,
  type InferenceAttempt,
  type ModelCallRecord,
  type ModelCallOutcome,
  type Usage,
} from '../contracts/index.js';
import {
  reportInterceptionError,
  defaultTurnIdentity,
  type InterceptionRuntime,
  type ReceiptQuery,
  type ToolActivity,
  type TurnDescriptor,
} from './active-runtime.js';
import type { ActivePolicy } from './active-policy.js';
import {
  toInferenceAttempt,
  type FetchTelemetry,
  type HttpExchange,
} from './fetch-telemetry.js';
import { addToScopeVector, type TurnScope } from './provenance-scope.js';

// TanStack chat middleware for one Dot turn (TOOL_COVERAGE.md section 2).
//
//   onConfig          builds a ContextSnapshot of exactly what the next model
//                     call will see: system prompts, history digests, tool
//                     schema hash, the page revision and memory ids the prompt
//                     embeds, and the dependency vector of the receipts behind
//                     them.
//   onBeforeToolCall  applies the policy registry: a refused call is skipped
//                     and the model gets a visible error result.
//   onAfterToolCall   digests results; page versions the model read join the
//                     turn's dependency vector.
//   onUsage/onFinish  close the model call into a ModelCallRecord and hand it,
//                     with its snapshot, to the injected recordModelCall sink.
//
// Everything here observes; the only thing it can change is the refusal of a
// tool call that the policy disallows. Sink and resolver failures are
// reported, never thrown into the turn.

export interface PageSnapshotInput {
  pageId: string;
  revision: number;
  /** Digest of the page exactly as embedded in the prompt. */
  digest: string;
}

export interface ProvenanceMiddlewareOptions {
  turn: TurnDescriptor;
  scope: TurnScope;
  /**
   * Absent: policy enforcement only (no snapshots, no records). DotAgent then
   * still refuses disallowed tool calls when a policy is installed.
   */
  runtime?: InterceptionRuntime;
  policy: () => ActivePolicy;
  telemetry?: FetchTelemetry;
  /** The page(s) the prompt embeds (dot-agent.ts pageContext). */
  pages: readonly PageSnapshotInput[];
  /** The memories the prompt embeds, ids kept (dot-agent.ts memories). */
  memories: readonly { id: string; text: string }[];
}

export interface ProvenanceHandle {
  middleware: ChatMiddleware;
  /** Snapshots of the model calls recorded so far, in order. */
  readonly snapshots: readonly ContextSnapshot[];
  readonly records: readonly ModelCallRecord[];
  readonly toolActivity: readonly ToolActivity[];
  /**
   * Closes a model call the chat engine never closed: when the consumer stops
   * iterating after a RUN_ERROR or an abort, TanStack's terminal hooks may not
   * run. Idempotent; a no-op once onFinish/onAbort/onError has run.
   */
  flush(reason: 'error' | 'abort' | 'complete'): Promise<void>;
}

const PAGE_TOOLS = new Set([
  'read_space_page',
  'create_space_page',
  'edit_space_page',
]);

/** JSON round trip then canonical digest; falls back to hashing text. */
export function safeDigest(value: unknown): string {
  try {
    const plain =
      value === undefined
        ? null
        : (JSON.parse(JSON.stringify(value)) as unknown);
    return digest(plain);
  } catch {
    return sha256Hex(String(value));
  }
}

function jsonSchemaOf(schema: unknown): unknown {
  try {
    return convertSchemaToJsonSchema(schema as never) ?? null;
  } catch {
    return null;
  }
}

export function toolSchemaHash(
  tools: readonly {
    name: string;
    description?: string;
    inputSchema?: unknown;
  }[],
): string {
  const described = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: jsonSchemaOf(tool.inputSchema),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return safeDigest(described);
}

const promptText = (prompt: unknown): string => {
  if (typeof prompt === 'string') return prompt;
  const content = (prompt as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : safeStringify(content);
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

interface CallState {
  snapshot: ContextSnapshot;
  callIndex: number;
  startedAt: string;
  toolCalls: Map<string, { name: string; args: string; input: unknown }>;
  text: string;
  finishReason: FinishReason | null;
  runFinished: boolean;
  usage: Usage | null;
  error: string | null;
  aborted: boolean;
}

export function createProvenanceMiddleware(
  options: ProvenanceMiddlewareOptions,
): ProvenanceHandle {
  const { turn, scope, runtime, telemetry } = options;
  const now = runtime?.now ?? (() => new Date());
  const snapshots: ContextSnapshot[] = [];
  const records: ModelCallRecord[] = [];
  const toolActivity: ToolActivity[] = [];
  const toolReadEntries = new Map<string, DependencyEntry[]>();
  const receiptCache = new Map<string, DependencyEntry | null>();
  const started = new Map<string, { at: number; argumentsDigest: string }>();
  let baseUnresolved: string[] = [];
  const readUnresolved: string[] = [];
  let current: CallState | undefined;
  let localCall = 0;

  const syncUnresolved = () => {
    scope.unresolved = [...new Set([...baseUnresolved, ...readUnresolved])];
  };

  async function resolve(query: ReceiptQuery): Promise<DependencyEntry | null> {
    const cacheKey = `${query.sourceKey}|${query.sourceRevision}|${query.contentDigest}`;
    if (receiptCache.has(cacheKey)) return receiptCache.get(cacheKey) ?? null;
    let entry: DependencyEntry | null = null;
    if (runtime?.resolveReceipt) {
      try {
        const found = await runtime.resolveReceipt(query);
        const parsed = found ? DependencyEntrySchema.safeParse(found) : null;
        entry = parsed?.success ? parsed.data : null;
      } catch (error) {
        if (runtime) reportInterceptionError(runtime, error, 'resolveReceipt');
      }
    }
    // Only a found receipt is cached: a later registration may fill a miss.
    if (entry) receiptCache.set(cacheKey, entry);
    return entry;
  }

  async function buildSnapshot(
    config: ChatMiddlewareConfig,
  ): Promise<ContextSnapshot> {
    const system = config.systemPrompts.map(promptText);
    const prefix = system.join('\n\n');
    const messages = config.messages.map(
      (message) =>
        JSON.parse(JSON.stringify(message)) as Record<string, unknown>,
    );
    const hash = toolSchemaHash(config.tools);
    const unresolved: string[] = [];
    const entries: DependencyEntry[] = [];
    const receipts: ContextSnapshot['injected']['receipts'] = [];

    const pageSnapshots = options.pages.map((page) => ({
      pageId: page.pageId,
      revision: page.revision,
      digest: page.digest,
    }));
    for (const page of options.pages) {
      const sourceKey = `opendots.page/${page.pageId}`;
      const entry = await resolve({
        sourceKey,
        sourceRevision: page.revision,
        contentDigest: page.digest,
      });
      if (entry) {
        entries.push(entry);
        receipts.push({
          id: entry.receiptId,
          sourceKey: entry.sourceKey,
          sourceRevision: entry.sourceRevision,
          contentDigest: page.digest,
        } as ContextSnapshot['injected']['receipts'][number]);
      } else unresolved.push(sourceKey);
    }
    const memories = options.memories.map((memory) => ({
      id: memory.id,
      digest: safeDigest(memory.text),
    }));
    for (const memory of memories) {
      const sourceKey = `opendots.memory/${memory.id}`;
      const entry = await resolve({
        sourceKey,
        sourceRevision: null,
        contentDigest: memory.digest,
      });
      if (entry) {
        entries.push(entry);
        receipts.push({
          id: entry.receiptId,
          sourceKey: entry.sourceKey,
          sourceRevision: entry.sourceRevision,
          contentDigest: memory.digest,
        } as ContextSnapshot['injected']['receipts'][number]);
      } else unresolved.push(sourceKey);
    }

    const historyItems: ContextSnapshot['injected']['historyItems'] = [];
    for (const message of config.messages) {
      const role = message.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
      const itemDigest = safeDigest({
        role,
        content: message.content,
        name: message.name,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
      });
      const deps: DependencyEntry[] = [];
      if (runtime?.historyVector) {
        try {
          deps.push(...(await runtime.historyVector(itemDigest)));
        } catch (error) {
          reportInterceptionError(runtime, error, 'historyVector');
        }
      }
      if (role === 'tool' && message.toolCallId)
        deps.push(...(toolReadEntries.get(message.toolCallId) ?? []));
      entries.push(...deps);
      historyItems.push({
        role,
        digest:
          itemDigest as ContextSnapshot['injected']['historyItems'][number]['digest'],
        dependencyReceiptIds: deps.map(
          (entry) => entry.receiptId,
        ) as ContextSnapshot['injected']['historyItems'][number]['dependencyReceiptIds'],
      });
    }
    for (const read of toolReadEntries.values()) entries.push(...read);

    let dependencyVector: ContextSnapshot['dependencyVector'] = [];
    try {
      dependencyVector = unionDependencyVectors(entries);
    } catch (error) {
      if (runtime) reportInterceptionError(runtime, error, 'dependencyVector');
      unresolved.push('dependency_vector_conflict');
    }
    baseUnresolved = unresolved;
    syncUnresolved();
    addToScopeVector(scope, dependencyVector);

    const contextLength = prefix.length + safeStringify(messages).length;
    const snapshot = {
      id: randomUUID(),
      contextSchemaVersion: 'v1',
      layout: 'ordinary',
      prefixDigest: sha256Hex(prefix),
      prefixLength: prefix.length,
      contextDigest: safeDigest({ system, messages, toolSchemaHash: hash }),
      contextLength,
      toolSchemaHash: hash,
      injected: {
        receipts,
        inheritedArtifacts: [],
        runbooks: [],
        pageSnapshots,
        memories,
        invalidationEvents: [],
        historyItems,
      },
      dependencyVector,
      volatile: { nowIso: now().toISOString() },
    };
    return ContextSnapshotSchema.parse(snapshot);
  }

  function attemptsOf(state: CallState, exchanges: HttpExchange[]) {
    if (exchanges.length > 0)
      return exchanges.map((exchange, index) =>
        toInferenceAttempt(exchange, index + 1),
      );
    // No HTTP exchange observed (no fetch wrapper): fall back to what the
    // middleware saw, marked as such by the null HTTP status and timings.
    const usage: Usage = state.usage ?? {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    };
    const attempt: InferenceAttempt = {
      n: 1,
      startedAt: state.startedAt,
      headersAt: null,
      firstContentAt: null,
      finishedAt: now().toISOString(),
      httpStatus: null,
      usage: state.aborted
        ? {
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
          }
        : usage,
      finishReason: state.aborted ? 'cancelled' : state.finishReason,
      error: null,
      retryAfterMs: null,
      streamed: true,
      outcome: 'recorded',
    };
    return [attempt];
  }

  async function finalize() {
    const state = current;
    current = undefined;
    if (!state || !runtime) return;
    const exchanges = telemetry
      ? await telemetry.takeCall(state.callIndex)
      : [];
    if (
      exchanges.length === 0 &&
      !state.runFinished &&
      !state.usage &&
      !state.error
    )
      return; // onConfig fired but no model call followed (init pass).
    try {
      const attempts = attemptsOf(state, exchanges);
      const last = attempts[attempts.length - 1];
      const returned =
        [...exchanges].reverse().find((e) => e.modelReturned)?.modelReturned ??
        null;
      const toolCalls = [...state.toolCalls.entries()].map(
        ([toolCallId, call]) => {
          let args: unknown = call.input;
          if (args === undefined) {
            try {
              args = call.args ? JSON.parse(call.args) : {};
            } catch {
              args = call.args;
            }
          }
          return {
            toolCallId,
            name: call.name,
            argumentsDigest: safeDigest(
              args,
            ) as ModelCallRecord['toolCalls'][number]['argumentsDigest'],
          };
        },
      );
      const failed =
        !!state.error ||
        (!!last.error &&
          last.error.class !== 'cancelled' &&
          !state.runFinished);
      const outcome: ModelCallOutcome = state.aborted
        ? 'aborted'
        : failed
          ? 'failed'
          : toolCalls.length > 0
            ? 'tool_calls'
            : 'completed';
      const identity = (runtime.identity ?? defaultTurnIdentity)(turn);
      const record = ModelCallRecordSchema.parse({
        id: randomUUID(),
        scope: identity.scope,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        role: identity.role,
        model: { requested: turn.model, returned },
        provider: { host: turn.providerHost, mode: runtime.providerMode },
        contextSnapshotId: state.snapshot.id,
        attempts,
        outcome,
        outputDigest: state.text ? sha256Hex(state.text) : null,
        outputDependencyVector: state.snapshot.dependencyVector,
        toolCalls,
        createdAt: now().toISOString(),
      });
      snapshots.push(state.snapshot);
      records.push(record);
      await runtime.recordModelCall?.(
        { record, snapshot: state.snapshot },
        {
          turn,
          incident: options.policy().isIncidentDot(turn.dotId),
          toolActivity: [...toolActivity],
          refusals: [...scope.refusals],
          unresolved: [...scope.unresolved],
        },
      );
    } catch (error) {
      reportInterceptionError(runtime, error, 'recordModelCall');
    }
  }

  async function registerPageRead(
    toolCallId: string,
    toolName: string,
    result: unknown,
  ) {
    let value = result;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return;
      }
    }
    const items = (
      toolName === 'list_space_pages'
        ? Array.isArray(value)
          ? value
          : []
        : [value]
    ) as { id?: unknown; revision?: unknown }[];
    const found: DependencyEntry[] = [];
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.revision !== 'number'
      )
        continue;
      const sourceKey = `opendots.page/${item.id}`;
      const entry = await resolve({
        sourceKey,
        sourceRevision: item.revision,
        contentDigest: safeDigest(item),
      });
      if (entry) found.push(entry);
      else readUnresolved.push(sourceKey);
    }
    if (found.length > 0) {
      toolReadEntries.set(toolCallId, [
        ...(toolReadEntries.get(toolCallId) ?? []),
        ...found,
      ]);
      addToScopeVector(scope, found);
    }
    syncUnresolved();
  }

  const middleware: ChatMiddleware = {
    name: 'nemodots-provenance',

    async onConfig(ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig) {
      if (!runtime) return;
      await finalize();
      try {
        const snapshot = await buildSnapshot(config);
        current = {
          snapshot,
          callIndex: telemetry ? telemetry.beginCall() : ++localCall,
          startedAt: now().toISOString(),
          toolCalls: new Map(),
          text: '',
          finishReason: null,
          runFinished: false,
          usage: null,
          error: null,
          aborted: false,
        };
      } catch (error) {
        reportInterceptionError(runtime, error, 'contextSnapshot');
        current = undefined;
      }
      void ctx;
    },

    onChunk(_ctx, chunk) {
      const state = current;
      if (!state) return;
      switch (chunk.type) {
        case 'TOOL_CALL_START': {
          const name = chunk.toolCallName ?? chunk.toolName ?? '';
          state.toolCalls.set(chunk.toolCallId, {
            name,
            args: '',
            input: undefined,
          });
          break;
        }
        case 'TOOL_CALL_ARGS': {
          const call = state.toolCalls.get(chunk.toolCallId);
          if (call) call.args += chunk.delta;
          break;
        }
        case 'TOOL_CALL_END': {
          const call = state.toolCalls.get(chunk.toolCallId);
          if (call && chunk.input !== undefined) call.input = chunk.input;
          break;
        }
        case 'TEXT_MESSAGE_CONTENT':
          state.text += chunk.delta;
          break;
        case 'RUN_FINISHED': {
          state.runFinished = true;
          const reason = chunk.finishReason as string | null | undefined;
          if (
            reason === 'stop' ||
            reason === 'length' ||
            reason === 'content_filter' ||
            reason === 'tool_calls'
          )
            state.finishReason = reason;
          break;
        }
        case 'RUN_ERROR':
          state.error = chunk.message || 'run error';
          break;
        default:
          break;
      }
    },

    onUsage(_ctx, usage) {
      if (!current) return;
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0
          ? value
          : null;
      current.usage = {
        promptTokens: count(usage.promptTokens),
        completionTokens: count(usage.completionTokens),
        cachedTokens: count(usage.promptTokensDetails?.cachedTokens),
        reasoningTokens: count(usage.completionTokensDetails?.reasoningTokens),
      };
    },

    onBeforeToolCall(_ctx, hook) {
      started.set(hook.toolCallId, {
        at: Date.now(),
        argumentsDigest: safeDigest(hook.args),
      });
      const decision = options.policy().decideTool({
        dotId: turn.dotId,
        toolName: hook.toolName,
        origin: turn.originOf?.(hook.toolName),
        args: hook.args,
      });
      if (decision.allow) return undefined;
      scope.refusals.push({
        toolName: hook.toolName,
        code: decision.code,
        layer: 'middleware',
      });
      toolActivity.push({
        toolCallId: hook.toolCallId,
        toolName: hook.toolName,
        argumentsDigest: safeDigest(hook.args),
        resultDigest: null,
        ok: false,
        refused: true,
        durationMs: 0,
      });
      return {
        type: 'skip',
        result: {
          error: `Refused by NemoDots policy: ${decision.reason}`,
          refusedByPolicy: true,
          code: decision.code,
        },
      };
    },

    async onAfterToolCall(_ctx, info) {
      const begun = started.get(info.toolCallId);
      started.delete(info.toolCallId);
      const refusedByExecutor = scope.refusals.some(
        (r) => r.layer === 'executor' && r.toolName === info.toolName,
      );
      toolActivity.push({
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        argumentsDigest: begun?.argumentsDigest ?? null,
        resultDigest: safeDigest(info.ok ? info.result : String(info.error)),
        ok: info.ok,
        refused: !info.ok && refusedByExecutor,
        durationMs: info.duration ?? (begun ? Date.now() - begun.at : null),
      });
      if (
        runtime &&
        info.ok &&
        (PAGE_TOOLS.has(info.toolName) || info.toolName === 'list_space_pages')
      )
        await registerPageRead(info.toolCallId, info.toolName, info.result);
    },

    async onFinish() {
      await finalize();
    },

    async onAbort() {
      if (current) current.aborted = true;
      await finalize();
    },

    async onError(_ctx, info) {
      if (current)
        current.error =
          info.error instanceof Error ? info.error.message : 'chat error';
      await finalize();
    },
  };

  return {
    middleware,
    async flush(reason) {
      if (current) {
        if (reason === 'abort') current.aborted = true;
        else if (reason === 'error' && !current.error)
          current.error = 'run error';
      }
      await finalize();
    },
    get snapshots() {
      return snapshots;
    },
    get records() {
      return records;
    },
    get toolActivity() {
      return toolActivity;
    },
  };
}
