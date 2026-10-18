// Ports and options of the Nemotron team (W4.1). The team imports contracts,
// context and inference types only; the coordinator is a type-level port
// (`TeamCoordinator`), the action boundary is `ActionAdmissionPort`, reads come
// through `SourceObserver`/`TeamReads`. Nothing here executes SQL.
import type {
  ActionAdmissionPort,
  AttemptContext,
  DependencyEntry,
  InferencePort,
  ModelCallId,
  ContextLayout,
  ObservationReceipt,
  ProviderMode,
  Scope,
  SourceKey,
  TaskId,
} from '../contracts/index.js';
import type {
  InheritedArtifactInput,
  InvalidationInput,
  RunbookCatalogue,
} from '../context/index.js';
import type { Coordinator } from '../coordinator/index.js';

export type TeamCoordinator = Pick<
  Coordinator,
  | 'publishFinding'
  | 'delegate'
  | 'recordModelCall'
  | 'addReadSet'
  | 'markWaiting'
  | 'resumeFromWaiting'
  | 'requestReplan'
  | 'getTaskStatus'
>;

/**
 * observe_source: reads the source through the SourceReaderPort, registers (or
 * confirms) the receipt in the ledger and records the readset edge for the
 * attempt, in one ledger transaction. Provided by the composition root.
 */
export interface SourceObserver {
  observe(
    context: AttemptContext,
    input: {
      sourceKey: SourceKey;
      modelCallId: ModelCallId | null;
      toolCallId: string | null;
    },
  ): Promise<ObservationReceipt>;
}

export interface ChildOutput {
  taskId: TaskId;
  role: string;
  status: string;
  usable: boolean;
  /** Bounded plain-text rendering of the published output. */
  text: string;
  digest: string | null;
  dependencyVector: readonly DependencyEntry[];
}

export interface MissionTaskView {
  id: TaskId;
  title: string;
  role: string;
  status: string;
  parentId: TaskId | null;
}

/** Read-only views the loop needs from coordinator/ledger tables (provided by bootstrap). */
export interface TeamReads {
  scope(context: AttemptContext): Scope;
  /** Outputs of the given tasks (children, prerequisites), for context and wait_for_children. */
  outputsOf(
    context: AttemptContext,
    taskIds: readonly TaskId[],
  ): Promise<ChildOutput[]>;
  /** Prerequisite outputs this task inherits (usable and unusable; the loop drops unusable ones). */
  prerequisiteOutputs(
    context: AttemptContext,
  ): Promise<InheritedArtifactInput[]>;
  /** Summaries of the invalidation that triggered a repair/replan attempt. */
  invalidationSummaries(
    context: AttemptContext,
    invalidationEventId: string,
  ): Promise<InvalidationInput[]>;
  missionTasks(context: AttemptContext): Promise<MissionTaskView[]>;
}

export interface RunbookStore {
  catalogue: RunbookCatalogue;
  /** Text of a runbook by catalogue id; throws UnknownRunbookError for anything else. */
  read(id: string): { id: string; title: string; text: string };
  all(): { id: string; title: string; text: string }[];
}

export interface TeamConfig {
  /** OPENAI_MODEL; recorded as `model.requested`. */
  model: string;
  /** Fallback provider stamp when the adapter result carries none. */
  provider: { host: string; mode: ProviderMode };
  /** Hard cap on loop iterations (contract: 12). */
  maxIterations?: number;
  /** max_tokens of each worker call (reasoning is disabled). */
  maxTokens?: number;
  plannerMaxTokens?: number;
  /** Upper bound of one wait_for_children tool call. */
  waitTimeoutMs?: number;
  waitPollMs?: number;
  /**
   * Pre-change verification: a specialist's proposal is refused until a
   * verifier child it delegated has finished with a usable output. Default ON
   * (policy.ts); an operator setting recorded in the mission report.
   */
  requireVerifier?: boolean;
  /**
   * Context layout of every compiled call (the evaluation 2x2). Absent means
   * `cache_aware`, the product layout. Set by the composition root only, never
   * by the model or an HTTP client.
   */
  layout?: ContextLayout;
}

export interface TeamDeps {
  inference: InferencePort & {
    mode?: ProviderMode;
  };
  coordinator: TeamCoordinator;
  observer: SourceObserver;
  actions: Pick<ActionAdmissionPort, 'propose'>;
  reads: TeamReads;
  runbooks: RunbookStore;
  config: TeamConfig;
  clock?: () => Date;
  ids?: () => string;
  /** Receives diagnostics (never prompts, bodies or secrets). */
  onEvent?: (event: TeamEvent) => void;
}

export type TeamEvent =
  | {
      kind: 'model_call';
      modelCallId: string;
      attemptId: string;
      role: string;
      outcome: string;
    }
  | {
      kind: 'tool';
      attemptId: string;
      name: string;
      ok: boolean;
      /** Policy error code of a refused call (never arguments or results). */
      error?: string;
      /** Policy detail of a refusal (issue text, never arguments or results). */
      detail?: string;
    }
  | { kind: 'correction'; attemptId: string; reason: string }
  | {
      kind: 'attempt_usage';
      attemptId: string;
      role: string;
      /** input + output tokens counted against the budget */
      spentTokens: number;
      promptTokens: number;
      completionTokens: number;
      /** null = the provider reported no cached count (not zero) */
      cachedTokens: number | null;
      callsWithUnavailableUsage: number;
      budgetTokens: number;
    };
