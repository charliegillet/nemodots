import type { ActionIntent, CheckedVector, ProposeInput } from './action.js';
import type {
  ActionId,
  MissionId,
  ModelCallId,
  ReceiptId,
  Scope,
  SourceKey,
} from './ids.js';
import type { MissionEvent } from './events.js';
import type {
  FinishReason,
  InferenceAttempt,
  ModelCallOutcome,
  ModelRole,
  Usage,
} from './model-call.js';
import type { ObservationReceipt } from './observation.js';
import type { InvalidationEvent } from './recovery.js';
import type { CreateMissionRequest, MissionSnapshot } from './routes.js';
import type { AttemptContext, Mission } from './task.js';
import type { ToolSchema } from './tools.js';

// CONTRACTS.md section 10: cross-package ports. Interfaces only; implementations
// are wired in system-bootstrap. No pg/redis import: PgClient is structural so
// a pg PoolClient satisfies it.

export interface PgClient {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface SupportValidator {
  /** lockMode 'share' for G2 publications, 'update' for G1 commits; controlled rows are ALWAYS locked (rev2 C9). */
  assertCurrent(
    client: PgClient,
    receiptIds: ReceiptId[],
    opts: {
      lockMode: 'share' | 'update';
      /** rev3 F4: support is checked against this mission's server-side scope; required so no caller skips it. */
      missionId: MissionId;
      freshness?: { [sourceKey: string]: number /* maxAgeMs */ };
    },
  ): Promise<CheckedVector>;
}

export interface SourceReaderPort {
  read(
    key: SourceKey,
    scope: Scope,
  ): Promise<{
    normalizedValue: unknown;
    raw: unknown;
    revisionHint: number | null;
  }>;
}

export interface ActionAdmissionPort {
  propose(
    input: ProposeInput,
    ctx: AttemptContext & { modelCallId: ModelCallId; toolCallId: string },
  ): Promise<ActionIntent>;
  /** proposed -> admitted | blocked (rev2 C4) */
  admit(actionId: ActionId, dispatcher: string): Promise<ActionIntent>;
  /** admitted -> committed | blocked; re-runs every predicate */
  commit(actionId: ActionId, dispatchFence: number): Promise<ActionIntent>;
  dispatch(actionId: ActionId, dispatchFence: number): Promise<ActionIntent>;
  reconcile(actionId: ActionId): Promise<ActionIntent>;
  cancelQueued(missionId: MissionId, generation: number): Promise<ActionId[]>;
}

export interface MissionControlPort {
  create(request: CreateMissionRequest): Promise<Mission>;
  start(missionId: MissionId): Promise<Mission>;
  pause(missionId: MissionId): Promise<Mission>;
  resume(missionId: MissionId): Promise<Mission>;
  cancel(missionId: MissionId): Promise<Mission>;
  snapshot(missionId: MissionId): Promise<MissionSnapshot>;
}

export interface EventSinkPort {
  /** takes the events advisory xact lock; returns the event id */
  append(
    client: PgClient,
    event: Omit<MissionEvent, 'id' | 'at'>,
  ): Promise<number>;
}

// Chat request/result shapes for InferencePort (OpenAI-compatible chat
// completions as served by Crusoe Managed Inference).
export type ChatToolCall = {
  toolCallId: string;
  name: string;
  /** raw JSON text as emitted by the model; validated by the tool layer */
  arguments: string;
};

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  toolSchemaHash: string | null;
  maxTokens: number | null;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | null;
  responseFormat: { name: string; schema: Record<string, unknown> } | null;
  stream: boolean;
};

export type ChatResult = {
  modelReturned: string | null;
  content: string | null;
  reasoning: string | null;
  toolCalls: ChatToolCall[];
  finishReason: FinishReason | null;
  usage: Usage;
  attempts: InferenceAttempt[];
  outcome: ModelCallOutcome;
};

export interface InferencePort {
  complete(
    req: ChatRequest,
    ctx: { signal: AbortSignal; modelCallId: ModelCallId; role: ModelRole },
  ): Promise<ChatResult>;
  listModels(): Promise<string[]>;
  /** new URL(OPENAI_BASE_URL).host */
  host(): string;
}

export interface ProbePort {
  run(missionId: MissionId): Promise<ObservationReceipt>;
}

/** coordinator implements; watcher calls */
export interface RecoveryPort {
  onInvalidation(event: InvalidationEvent): Promise<void>;
  onSelfWriteSettled(
    actionId: ActionId,
    outcome: 'verified' | 'failed',
  ): Promise<void>;
}
