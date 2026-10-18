import { createHash } from 'node:crypto';
import type {
  ContextSnapshot,
  DependencyEntry,
  ModelCallRecord,
  ModelRole,
  ProviderMode,
  Scope,
} from '../contracts/index.js';
import type { ToolOrigin } from './active-policy.js';
import type { PolicyRefusal, TurnScope } from './provenance-scope.js';

// Module-level provenance runtime. Bootstrap installs it (with the ledger
// behind recordModelCall and resolveReceipt); DotAgent reads it. Absent by
// default: with no runtime, DotAgent adds no middleware, no fetch wrapper and
// no scope, so every hook is a no-op (the 54 upstream test files run on this).

export interface TurnDescriptor {
  dotId: string;
  threadId: string;
  runId: string;
  /** Model id the adapter requests. */
  model: string;
  /** new URL(baseUrl).host */
  providerHost: string;
  /** Which tools came from a connection or Composio, by registered name. */
  originOf?: (toolName: string) => ToolOrigin | undefined;
}

export interface ModelCallSinkInput {
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
}

/** What the sink additionally learns about the turn (not part of the stored contract). */
export interface ModelCallSinkTurn {
  turn: TurnDescriptor;
  incident: boolean;
  toolActivity: ToolActivity[];
  refusals: PolicyRefusal[];
  /** Evidence the model saw that has no receipt yet. */
  unresolved: string[];
}

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  argumentsDigest: string | null;
  resultDigest: string | null;
  ok: boolean;
  refused: boolean;
  durationMs: number | null;
}

export interface ReceiptQuery {
  sourceKey: string;
  /** null for sources without a revision (memories). */
  sourceRevision: number | null;
  /** Digest of the content exactly as the model saw it. */
  contentDigest: string;
}

export interface TurnIdentity {
  scope: Scope;
  taskId: ModelCallRecord['taskId'];
  attemptId: ModelCallRecord['attemptId'];
  role: ModelRole;
}

export interface InterceptionRuntime {
  /**
   * Whether the model host is the live provider or a fixture. Required: this
   * is stamped on every ModelCallRecord and must never be guessed.
   */
  providerMode: ProviderMode;
  /** Defaults to a no-op. Errors are reported through onError, never thrown into the turn. */
  recordModelCall?: (
    input: ModelCallSinkInput,
    info: ModelCallSinkTurn,
  ) => void | Promise<void>;
  /**
   * The current receipt for a page or memory version. null: no receipt yet
   * (the evidence is recorded as unresolved). Absent: no ledger attached, so
   * every source is unresolved.
   */
  resolveReceipt?: (
    query: ReceiptQuery,
  ) => DependencyEntry | null | Promise<DependencyEntry | null>;
  /** Vectors of earlier model outputs replayed as conversation history, by item digest. */
  historyVector?: (
    digest: string,
  ) => readonly DependencyEntry[] | Promise<readonly DependencyEntry[]>;
  /** Overrides the default identity derived from the Dot, thread and run. */
  identity?: (turn: TurnDescriptor) => TurnIdentity;
  onError?: (error: unknown, where: string) => void;
  now?: () => Date;
}

let active: InterceptionRuntime | null = null;

export function setInterceptionRuntime(runtime: InterceptionRuntime | null) {
  active = runtime;
}

export function getInterceptionRuntime(): InterceptionRuntime | null {
  return active;
}

export function reportInterceptionError(
  runtime: InterceptionRuntime,
  error: unknown,
  where: string,
) {
  if (runtime.onError) runtime.onError(error, where);
  else
    console.error(
      `[nemodots] interception ${where} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
}

/** A UUIDv4-shaped id derived from a label, so the same Dot turn maps to the same ids. */
export function derivedUuid(label: string): string {
  const hex = createHash('sha256').update(label, 'utf8').digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Identity of a Dot turn that is not part of a mission. The ids are derived,
 * not invented: the scope's resource names the Dot, the mission id is a
 * stable hash of it. 'worker' is the closest ModelRole; the resource field
 * says what it really is.
 */
export function defaultTurnIdentity(turn: TurnDescriptor): TurnIdentity {
  return {
    scope: {
      ownerId: 'opendots',
      missionId: derivedUuid(
        `opendots-dot:${turn.dotId}`,
      ) as Scope['missionId'],
      spaceId: null,
      environment: 'dev',
      resource: `opendots.dot/${turn.dotId}`,
    },
    taskId: derivedUuid(
      `opendots-thread:${turn.threadId}`,
    ) as ModelCallRecord['taskId'],
    attemptId: derivedUuid(
      `opendots-run:${turn.threadId}:${turn.runId}`,
    ) as ModelCallRecord['attemptId'],
    role: 'worker',
  };
}

export type { PolicyRefusal, TurnScope };
