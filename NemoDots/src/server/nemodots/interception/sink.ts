// What a deployment injects to receive Dot-turn provenance. Every method is
// optional; with no sink nothing is recorded.
import type {
  AttemptId,
  ContextSnapshot,
  DependencyEntry,
  Digest,
  ModelCallRecord,
  ModelRole,
  Scope,
  TaskId,
} from '../contracts/index.js';

export interface TurnIdentity {
  scope: Scope;
  taskId: TaskId;
  attemptId: AttemptId;
  role: ModelRole;
}

export interface ToolResultInfo {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
  resultDigest: Digest;
}

export interface ProvenanceSink {
  /** Who owns the model calls of this turn; null means observe snapshots only. */
  identify?(turn: { dotId: string; threadId: string }): TurnIdentity | null;
  recordSnapshot?(snapshot: ContextSnapshot): void | Promise<void>;
  recordModelCall?(record: ModelCallRecord): void | Promise<void>;
  /** Receipts registered for a read tool result; they join the turn vector. */
  registerToolResult?(
    info: ToolResultInfo,
  ):
    | readonly DependencyEntry[]
    | void
    | Promise<readonly DependencyEntry[] | void>;
}
