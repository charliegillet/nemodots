// In-memory, LABELLED port stubs for the team unit tests. They replace the
// packages owned by other waves (ledger/coordinator persistence, source
// readers, action admission); none of them is evidence of live behaviour.
//
//   StubCoordinator  records every call the team makes (addReadSet, delegate,
//                    publishFinding, recordModelCall, ...). It enforces nothing
//                    the real coordinator enforces; the team's own pre-checks
//                    are what these tests exercise.
//   StubReader       TeamReader over plain objects.
//   StubObserver     ObservationPort over a map of source values; ids are
//                    deterministic so a fixture replay sees identical requests.
//   ScriptedInference  InferencePort returning scripted ChatResults in order;
//                    `toFixture()` turns the captured exchange into the
//                    fixture format the real FixtureInference replays.
import { randomUUID } from 'node:crypto';
import {
  digest,
  DependencyVectorSchema,
  type AttemptContext,
  type ChatRequest,
  type ChatResult,
  type Capability,
  type DependencyVector,
  type InferenceAttempt,
  type MissionId,
  type ReceiptId,
  type SourceKey,
  type TaskId,
  type TaskRole,
  type AttemptId,
  ROLE_CAPABILITIES,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  FIXTURE_FORMAT,
  FixtureInference,
  fixtureKey,
  fixtureRequestInfo,
  type FixtureFile,
} from '../../../src/server/nemodots/inference/fixture.js';
import { createRunbookLibrary } from '../../../src/server/nemodots/team/catalogue.js';
import type { ClaimedAttempt } from '../../../src/server/nemodots/coordinator/types.js';
import type { HandlerHelpers } from '../../../src/server/nemodots/coordinator/worker-host.js';
import { AttemptAbortedError } from '../../../src/server/nemodots/coordinator/worker-host.js';
import type {
  ObservationPort,
  ObservedReceipt,
  PlanOverviewTask,
  TaskOutputView,
  TeamCoordinator,
  TeamInference,
  TeamReader,
} from '../../../src/server/nemodots/team/types.js';
import type { DelegationFacts } from '../../../src/server/nemodots/coordinator/plan-validation.js';

export const NOW = new Date('2026-10-17T18:00:00.000Z');
export const clock = () => NOW;

/** A v4-shaped uuid derived from text, so replays see identical ids. */
export function detUuid(text: string): string {
  const h = digest(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const MISSION = '11111111-1111-4111-8111-111111111111' as MissionId;
export const SCOPE = {
  ownerId: 'owner',
  missionId: MISSION,
  spaceId: null,
  environment: 'test' as const,
  resource: 'checkout',
};

let counter = 0;
export const uuid = (n = ++counter) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function makeContext(
  role: TaskRole,
  over: Partial<AttemptContext> = {},
): AttemptContext {
  return {
    missionId: MISSION,
    taskId: '22222222-2222-4222-8222-222222222222' as TaskId,
    attemptId: '33333333-3333-4333-8333-333333333333' as AttemptId,
    fencingToken: 1,
    generation: 0,
    capabilities: [...ROLE_CAPABILITIES[role]] as Capability[],
    role,
    ...over,
  };
}

export function makeClaimed(
  role: TaskRole,
  over: {
    kind?: ClaimedAttempt['attempt']['kind'];
    repairOf?: ClaimedAttempt['attempt']['repairOf'];
    inherited?: DependencyVector;
    maxIterations?: number;
    maxTokens?: number;
    context?: Partial<AttemptContext>;
  } = {},
): ClaimedAttempt {
  return {
    context: makeContext(role, over.context),
    attempt: {
      n: 1,
      kind: over.kind ?? 'initial',
      leaseExpiresAt: NOW.toISOString(),
      inheritedDependencyVector: over.inherited ?? [],
      repairOf: over.repairOf ?? null,
    },
    task: {
      title: 'Check the checkout service',
      question: 'Establish whether checkout is healthy.',
      parentId: null,
      depth: 1,
      maxIterations: over.maxIterations ?? 12,
      maxTokens: over.maxTokens ?? 1_000_000,
      maxChildren: 4,
    },
    mission: { goal: 'Restore checkout.', constraints: [] },
    leaseMs: 30_000,
  };
}

export function makeHelpers(
  abortAfterCheckpoints: number | null = null,
): HandlerHelpers & { checkpoints: number } {
  const controller = new AbortController();
  const state = { checkpoints: 0 };
  return {
    signal: controller.signal,
    async checkpoint() {
      state.checkpoints += 1;
      if (
        abortAfterCheckpoints !== null &&
        state.checkpoints > abortAfterCheckpoints
      ) {
        controller.abort();
        throw new AttemptAbortedError('readset_invalidated');
      }
    },
    abortReason: () => null,
    get checkpoints() {
      return state.checkpoints;
    },
  };
}

export class StubCoordinator implements TeamCoordinator {
  readSets: DependencyVector[] = [];
  delegations: Parameters<TeamCoordinator['delegate']>[1][] = [];
  findings: Parameters<TeamCoordinator['publishFinding']>[1][] = [];
  records: Parameters<TeamCoordinator['recordModelCall']>[1][] = [];
  replans: string[] = [];
  waits = 0;
  childrenStatus: Awaited<ReturnType<TeamCoordinator['resumeFromWaiting']>> = {
    children: [],
    allTerminal: true,
  };
  failPublishFindingWith: Error | null = null;
  failAddReadSetWith: Error | null = null;
  tasks = new Map<string, { id: string; title: string; status: string }>();

  async addReadSet(_context: AttemptContext, entries: DependencyVector) {
    if (this.failAddReadSetWith) throw this.failAddReadSetWith;
    // the real coordinator parses with this schema: unsorted vectors are refused
    this.readSets.push(DependencyVectorSchema.parse(entries));
  }
  async delegate(
    _context: AttemptContext,
    input: Parameters<TeamCoordinator['delegate']>[1],
  ) {
    this.delegations.push(input);
    return {
      taskId: detUuid(`task:${input.toolCallId}`) as TaskId,
      created: true,
    };
  }
  async publishFinding(
    _context: AttemptContext,
    input: Parameters<TeamCoordinator['publishFinding']>[1],
  ) {
    if (this.failPublishFindingWith) throw this.failPublishFindingWith;
    this.findings.push(input);
    return { findingId: detUuid(`finding:${input.claim}`) as never };
  }
  async requestReplan(_context: AttemptContext, reason: string) {
    this.replans.push(reason);
    return { scheduled: true };
  }
  async markWaiting() {
    this.waits += 1;
  }
  async resumeFromWaiting() {
    return this.childrenStatus;
  }
  async getTaskStatus(missionId: MissionId, taskId: TaskId) {
    const task = this.tasks.get(taskId);
    if (!task || missionId !== MISSION) {
      const { TaskNotFoundError } =
        await import('../../../src/server/nemodots/coordinator/errors.js');
      throw new TaskNotFoundError(taskId);
    }
    return { task: task as never, outputUsable: null };
  }
  async recordModelCall(
    _context: AttemptContext,
    input: Parameters<TeamCoordinator['recordModelCall']>[1],
  ) {
    this.records.push(input);
  }
}

export interface StubReaderOptions {
  facts?: Partial<DelegationFacts>;
  usage?: { calls: number; tokens: number };
  overview?: PlanOverviewTask[];
}

export class StubReader implements TeamReader {
  snapshotVectors = new Map<string, DependencyVector>();
  constructor(readonly options: StubReaderOptions = {}) {}
  async mission() {
    return {
      scope: SCOPE,
      goal: 'Restore checkout.',
      constraints: [],
      budgets: {
        maxTasks: 24,
        maxDepth: 3,
        maxBreadth: 4,
        maxTokens: 1_000_000,
        maxInferenceCalls: 200,
        maxWallClockMs: 600_000,
      },
      provider: { host: 'fixture.local', plannerModel: 'p', workerModel: 'w' },
    };
  }
  async receipts() {
    return [];
  }
  async snapshotVector(modelCallId: string) {
    return this.snapshotVectors.get(modelCallId) ?? null;
  }
  async invalidation() {
    return null;
  }
  async readSetOf() {
    return null;
  }
  async taskOutputs(): Promise<TaskOutputView[]> {
    return [];
  }
  async prerequisiteOutputs(): Promise<TaskOutputView[]> {
    return [];
  }
  async delegationFacts(context: AttemptContext): Promise<DelegationFacts> {
    return {
      parent: {
        id: context.taskId,
        role: context.role,
        depth: 1,
        capabilities: context.capabilities,
        maxChildren: 4,
      },
      limits: { maxDepth: 3, maxBreadth: 4, maxTasks: 24 },
      totalTasks: 3,
      parentChildren: 0,
      tasks: [],
      ...this.options.facts,
    };
  }
  async planOverview() {
    return this.options.overview ?? [];
  }
  async missionUsage() {
    return this.options.usage ?? { calls: 0, tokens: 0 };
  }
}

export class StubObserver implements ObservationPort {
  readonly calls: { sourceKey: string; toolCallId: string }[] = [];
  private revision = new Map<string, number>();
  constructor(readonly values: Record<string, unknown> = {}) {}
  async observe(input: Parameters<ObservationPort['observe']>[0]) {
    this.calls.push({
      sourceKey: input.sourceKey,
      toolCallId: input.toolCallId,
    });
    if (!(input.sourceKey in this.values))
      throw new (
        await import('../../../src/server/nemodots/team/errors.js')
      ).ToolError('source_unavailable', 'no such source in the stub');
    const value = this.values[input.sourceKey];
    const revision = (this.revision.get(input.sourceKey) ?? 0) + 1;
    this.revision.set(input.sourceKey, revision);
    const id = `${digest([input.sourceKey, revision, value]).slice(0, 8)}-0000-4000-8000-${digest(input.sourceKey).slice(0, 12)}`;
    return {
      receiptId: id as ReceiptId,
      sourceKey: input.sourceKey as SourceKey,
      sourceRevision: revision,
      collectionRevision: null,
      observedAt: NOW.toISOString(),
      lastConfirmedAt: NOW.toISOString(),
      contentDigest: digest(value),
      normalizedValue: value,
      negative: null,
      status: 'supported',
      trust: 'observed_tool',
      newRevision: true,
    } satisfies ObservedReceipt;
  }
}

export const HEALTH_VALUE = {
  status: 'degraded',
  checks: { postgres: true, redis: true, config_parse: true, writes: true },
  errors: ['pool_exhausted'],
};

export function result(
  over: Partial<ChatResult> & { content?: string | null } = {},
): ChatResult {
  const attempt: InferenceAttempt = {
    n: 1,
    startedAt: NOW.toISOString(),
    headersAt: null,
    firstContentAt: null,
    finishedAt: NOW.toISOString(),
    httpStatus: 200,
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: null,
      reasoningTokens: null,
    },
    finishReason: over.toolCalls?.length ? 'tool_calls' : 'stop',
    error: null,
    retryAfterMs: null,
    streamed: false,
    outcome: 'recorded',
  };
  const toolCalls = over.toolCalls ?? [];
  return {
    modelReturned: 'test-model',
    content: over.content ?? null,
    reasoning: null,
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: attempt.usage,
    attempts: [attempt],
    outcome: toolCalls.length ? 'tool_calls' : 'completed',
    ...over,
  };
}

export const call = (id: string, name: string, args: unknown | string) => ({
  toolCallId: id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

export function failed(
  errorClass: NonNullable<InferenceAttempt['error']>['class'],
): ChatResult {
  const base = result();
  return {
    ...base,
    outcome: 'failed',
    finishReason: 'error',
    attempts: [
      {
        ...base.attempts[0],
        httpStatus: null,
        finishReason: 'error',
        usage: {
          promptTokens: null,
          completionTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
        },
        error: { class: errorClass, code: null, errorId: null },
      },
    ],
  };
}

type Script = (ChatResult | ((request: ChatRequest) => ChatResult))[];

/** Returns scripted results in order; an exhausted script is a test bug and throws. */
export class ScriptedInference implements TeamInference {
  readonly mode = 'fixture' as const;
  requests: ChatRequest[] = [];
  responses: ChatResult[] = [];
  constructor(private readonly script: Script) {}
  host() {
    return 'fixture.local';
  }
  async listModels() {
    return ['test-model'];
  }
  async complete(request: ChatRequest) {
    const next = this.script[this.requests.length];
    if (!next) throw new Error('script exhausted');
    this.requests.push(request);
    const response = typeof next === 'function' ? next(request) : next;
    this.responses.push(response);
    return Object.assign({}, response, {
      provider: { host: 'fixture.local', mode: 'fixture' as const },
    });
  }

  /** The captured exchange in the fixture format FixtureInference replays. */
  toFixture(): FixtureFile {
    return {
      format: FIXTURE_FORMAT,
      label: 'hand-authored team test script',
      provenance: 'hand-authored',
      host: 'fixture.local',
      models: ['w', 'p'],
      entries: this.requests.map((request, i) => {
        const response = this.responses[i];
        return {
          key: fixtureKey(request),
          request: fixtureRequestInfo(request),
          response: {
            modelReturned: response.modelReturned,
            content: response.content,
            reasoning: response.reasoning,
            toolCalls: response.toolCalls,
            finishReason: (response.finishReason ?? 'stop') as never,
            usage: response.usage,
            outcome: response.outcome as never,
          },
        };
      }),
    };
  }
}

export const replayAdapter = (file: FixtureFile) =>
  new FixtureInference(file) as unknown as TeamInference;

export const runbooks = createRunbookLibrary();
export const newIdFactory = () => {
  let n = 1000;
  return () => uuid(++n);
};
export { randomUUID };
