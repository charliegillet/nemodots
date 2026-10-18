// Unit-test doubles for the team package. LABEL: everything here is a scripted
// adapter-policy double (deterministic race/policy proofs), never product
// behaviour and never live evidence.
//
//   ScriptedInference  InferencePort that answers from a queue of steps; each
//                      step sees the request (so tests can assert on it).
//   StubCoordinator    TeamCoordinator recording calls, with injectable errors.
//   StubObserver       SourceObserver returning receipts from a value table.
//   StubReads          TeamReads over in-memory tables.
//   StubActions        ActionAdmissionPort.propose recorder.
import { randomUUID } from 'node:crypto';
import {
  type ActionId,
  type AttemptContext,
  type AttemptId,
  type Capability,
  type ChatRequest,
  type ChatResult,
  type DependencyEntry,
  type InferenceAttempt,
  type MissionId,
  type ModelCallRecord,
  type ObservationReceipt,
  type ReceiptId,
  type SourceKey,
  type TaskId,
  type TaskRole,
  type ContextSnapshot,
  ROLE_CAPABILITIES,
  digest,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  AttemptAbortedError,
  type HandlerHelpers,
  type HandlerOutcome,
} from '../../../src/server/nemodots/coordinator/index.js';
import type { ClaimedAttempt } from '../../../src/server/nemodots/coordinator/types.js';
import {
  createRunbookStore,
  createTeamHandler,
  type ChildOutput,
  type TeamDeps,
  type TeamReads,
  type SourceObserver,
  type MissionTaskView,
} from '../../../src/server/nemodots/team/index.js';

export const NOW = new Date('2026-10-18T12:00:00.000Z');
export const MODEL = 'nvidia/test-model';
export const HOST = 'inference.test';

export const uuid = () => randomUUID();
const zeroUsage = {
  promptTokens: 100,
  completionTokens: 20,
  cachedTokens: null,
  reasoningTokens: null,
};

function attempt(overrides: Partial<InferenceAttempt> = {}): InferenceAttempt {
  return {
    n: 1,
    startedAt: NOW.toISOString(),
    headersAt: NOW.toISOString(),
    firstContentAt: null,
    finishedAt: NOW.toISOString(),
    httpStatus: 200,
    usage: zeroUsage,
    finishReason: 'stop',
    error: null,
    retryAfterMs: null,
    streamed: false,
    outcome: 'recorded',
    ...overrides,
  };
}

export type Step = (request: ChatRequest) => ChatResult | Promise<ChatResult>;

export const text =
  (content: string, usage = zeroUsage): Step =>
  () => ({
    modelReturned: MODEL,
    content,
    reasoning: null,
    toolCalls: [],
    finishReason: 'stop',
    usage,
    attempts: [attempt({ usage })],
    outcome: 'completed',
  });

/** The investigator's closing-check reply when its readings showed no defect. */
export const noDefect = (): Step =>
  text(
    JSON.stringify({
      defectFound: false,
      area: 'none',
      reason: 'nothing broken',
    }),
  );

export const calls =
  (
    ...toolCalls: { id?: string; name: string; args: unknown | string }[]
  ): Step =>
  () => ({
    modelReturned: MODEL,
    content: null,
    reasoning: null,
    toolCalls: toolCalls.map((call, i) => ({
      toolCallId: call.id ?? `call_${uuid().slice(0, 8)}_${i}`,
      name: call.name,
      arguments:
        typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
    })),
    finishReason: 'tool_calls',
    usage: zeroUsage,
    attempts: [attempt({ finishReason: 'tool_calls' })],
    outcome: 'tool_calls',
  });

export const failed =
  (
    errorClass: string,
    finishReason: 'error' | 'content_filter' = 'error',
  ): Step =>
  () => ({
    modelReturned: null,
    content: null,
    reasoning: null,
    toolCalls: [],
    finishReason,
    usage: { ...zeroUsage, promptTokens: null, completionTokens: null },
    attempts: [
      attempt({
        finishReason,
        usage: {
          promptTokens: null,
          completionTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
        },
        error: { class: errorClass as never, code: null, errorId: null },
        httpStatus: null,
      }),
    ],
    outcome: 'failed',
  });

export const refused = (): Step => () => ({
  modelReturned: MODEL,
  content: null,
  reasoning: null,
  toolCalls: [],
  finishReason: 'content_filter',
  usage: zeroUsage,
  attempts: [attempt({ finishReason: 'content_filter' })],
  outcome: 'completed',
});

export class ScriptedInference {
  requests: ChatRequest[] = [];
  contexts: { modelCallId: string; role: string }[] = [];
  readonly mode = 'fixture' as const;
  constructor(private steps: Step[]) {}
  host() {
    return HOST;
  }
  async listModels() {
    return [MODEL];
  }
  async complete(
    req: ChatRequest,
    ctx: { signal: AbortSignal; modelCallId: string; role: string },
  ): Promise<ChatResult> {
    this.requests.push(req);
    this.contexts.push({ modelCallId: ctx.modelCallId, role: ctx.role });
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedInference: script exhausted');
    return step(req);
  }
}

export interface RecordedCall {
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
}

export class StubCoordinator {
  modelCalls: RecordedCall[] = [];
  order: string[] = [];
  delegations: Record<string, unknown>[] = [];
  findings: Record<string, unknown>[] = [];
  readSets: DependencyEntry[][] = [];
  replans: string[] = [];
  waiting = 0;
  /** resumeFromWaiting answers, consumed in order; the last repeats. */
  resume: {
    allTerminal: boolean;
    children: {
      id: TaskId;
      status: string;
      outputId: string | null;
      role: string;
    }[];
  }[] = [{ allTerminal: true, children: [] }];
  delegateError: Error | null = null;
  findingError: Error | null = null;
  tasks = new Map<string, { status: string; role: string; title: string }>();

  async recordModelCall(
    _context: AttemptContext,
    input: { record: ModelCallRecord; snapshot: ContextSnapshot },
  ) {
    this.order.push(`model_call:${input.record.id}`);
    this.modelCalls.push(input);
  }
  async addReadSet(_context: AttemptContext, entries: DependencyEntry[]) {
    this.order.push('read_set');
    this.readSets.push([...entries]);
  }
  async delegate(_context: AttemptContext, input: Record<string, unknown>) {
    if (this.delegateError) throw this.delegateError;
    this.delegations.push(input);
    return { taskId: uuid() as TaskId, created: true };
  }
  async publishFinding(
    _context: AttemptContext,
    input: Record<string, unknown>,
  ) {
    if (this.findingError) throw this.findingError;
    this.findings.push(input);
    return { findingId: uuid() };
  }
  async markWaiting() {
    this.waiting += 1;
    this.order.push('mark_waiting');
  }
  async resumeFromWaiting() {
    this.order.push('resume_from_waiting');
    return this.resume.length > 1 ? this.resume.shift()! : this.resume[0];
  }
  async requestReplan(_context: AttemptContext, reason: string) {
    this.replans.push(reason);
    return { scheduled: true };
  }
  async getTaskStatus(_missionId: MissionId, taskId: TaskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      const error = new Error('task not found');
      error.name = 'TaskNotFoundError';
      throw error;
    }
    return {
      task: { status: task.status, role: task.role, title: task.title },
      outputUsable: true,
    };
  }
}

export class StubObserver implements SourceObserver {
  values = new Map<string, unknown>();
  revisions = new Map<string, number>();
  calls: {
    sourceKey: string;
    modelCallId: string | null;
    toolCallId: string | null;
  }[] = [];
  async observe(
    context: AttemptContext,
    input: {
      sourceKey: SourceKey;
      modelCallId: string | null;
      toolCallId: string | null;
    },
  ): Promise<ObservationReceipt> {
    this.calls.push(input);
    const value = this.values.get(input.sourceKey);
    if (value === undefined) throw new Error(`no value for ${input.sourceKey}`);
    const revision = (this.revisions.get(input.sourceKey) ?? 0) + 0 || 1;
    return receiptFor(context, input.sourceKey, value, revision);
  }
}

export function receiptFor(
  context: Pick<AttemptContext, 'missionId'>,
  key: string,
  value: unknown,
  revision = 1,
): ObservationReceipt {
  const id = digestToUuid(`${key}:${revision}:${JSON.stringify(value)}`);
  return {
    id: id as ReceiptId,
    source: {
      key: key as SourceKey,
      sourceType: key.startsWith('checkout.config/')
        ? 'controlled_config'
        : key === 'checkout.config'
          ? 'controlled_collection'
          : 'observed_endpoint',
      authority: key.startsWith('checkout.config') ? 'controlled' : 'observed',
      scope: {
        ownerId: 'owner',
        missionId: context.missionId,
        spaceId: null,
        environment: 'test',
        resource: 'checkout',
      },
    },
    sourceRevision: revision,
    collectionRevision: null,
    observedAt: NOW.toISOString(),
    lastConfirmedAt: NOW.toISOString(),
    contentDigest: digest(value),
    normalizedValue: value,
    rawRef: null,
    status: 'supported',
    statusVersion: 0,
    supersedes: null,
    supersededBy: null,
    trust: key.startsWith('checkout.config')
      ? 'controlled_authority'
      : 'observed_tool',
    provenance: {
      kind: 'tool_call',
      toolCallId: null,
      modelCallId: null,
      attemptId: null,
      causedByActionId: null,
      selfWrite: 'none',
    },
    negative: null,
    expiresAt: null,
  } as ObservationReceipt;
}

/** Deterministic v4-shaped uuid from text (so receipts are stable across runs). */
export function digestToUuid(input: string): string {
  const hex = digest(input).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class StubReads implements TeamReads {
  outputs = new Map<string, ChildOutput>();
  prerequisites: Awaited<ReturnType<TeamReads['prerequisiteOutputs']>> = [];
  summaries: { id: string; summary: string }[] = [];
  summaryCalls: string[] = [];
  tasks: MissionTaskView[] = [];
  scope(context: AttemptContext) {
    return {
      ownerId: 'owner',
      missionId: context.missionId,
      spaceId: null,
      environment: 'test' as const,
      resource: 'checkout',
    };
  }
  async outputsOf(_c: AttemptContext, ids: readonly TaskId[]) {
    return ids.flatMap((id) => this.outputs.get(id) ?? []);
  }
  async prerequisiteOutputs() {
    return this.prerequisites;
  }
  async invalidationSummaries(_c: AttemptContext, eventId: string) {
    this.summaryCalls.push(eventId);
    return this.summaries as never;
  }
  async missionTasks() {
    return this.tasks;
  }
}

export class StubActions {
  proposals: {
    input: Record<string, unknown>;
    ctx: Record<string, unknown>;
  }[] = [];
  async propose(input: Record<string, unknown>, ctx: Record<string, unknown>) {
    this.proposals.push({ input, ctx });
    return {
      id: uuid() as ActionId,
      status: 'proposed',
      blockReason: null,
      blockDetail: null,
    };
  }
}

export interface Rig {
  inference: ScriptedInference;
  coordinator: StubCoordinator;
  observer: StubObserver;
  reads: StubReads;
  actions: StubActions;
  deps: TeamDeps;
  events: unknown[];
}

export function rig(
  steps: Step[],
  overrides: Partial<TeamDeps['config']> = {},
): Rig {
  const inference = new ScriptedInference(steps);
  const coordinator = new StubCoordinator();
  const observer = new StubObserver();
  const reads = new StubReads();
  const actions = new StubActions();
  const events: unknown[] = [];
  let n = 0;
  const deps: TeamDeps = {
    inference: inference as never,
    coordinator: coordinator as never,
    observer,
    actions: actions as never,
    reads,
    runbooks: createRunbookStore(),
    config: {
      model: MODEL,
      provider: { host: HOST, mode: 'fixture' },
      waitPollMs: 1,
      waitTimeoutMs: 200,
      ...overrides,
    },
    clock: () => NOW,
    ids: () => digestToUuid(`id-${(n += 1)}`),
    onEvent: (event) => events.push(event),
  };
  return { inference, coordinator, observer, reads, actions, deps, events };
}

export function context(
  role: TaskRole,
  capabilities?: Capability[],
): AttemptContext {
  return {
    missionId: uuid() as MissionId,
    taskId: uuid() as TaskId,
    attemptId: uuid() as AttemptId,
    fencingToken: 1,
    generation: 0,
    capabilities: capabilities ?? [...ROLE_CAPABILITIES[role]],
    role,
  };
}

export function claimed(
  role: TaskRole,
  options: {
    kind?: ClaimedAttempt['attempt']['kind'];
    repairOf?: ClaimedAttempt['attempt']['repairOf'];
    maxIterations?: number;
    maxTokens?: number;
    capabilities?: Capability[];
    inherited?: DependencyEntry[];
  } = {},
): ClaimedAttempt {
  return {
    context: context(role, options.capabilities),
    attempt: {
      n: 1,
      kind: options.kind ?? 'initial',
      leaseExpiresAt: NOW.toISOString(),
      inheritedDependencyVector: options.inherited ?? [],
      repairOf: options.repairOf ?? null,
    },
    task: {
      title: 'Investigate',
      question: 'What is wrong with checkout?',
      parentId: null,
      depth: 0,
      maxIterations: options.maxIterations ?? 12,
      maxTokens: options.maxTokens ?? 20_000,
      maxChildren: 4,
    },
    mission: {
      goal: 'Restore checkout availability while preserving customer data.',
      constraints: [],
    },
    leaseMs: 30_000,
  };
}

export interface HelperControl extends HandlerHelpers {
  checkpoints: number;
  /** Throws AttemptAbortedError from the Nth checkpoint on (1-based). */
  abortAtCheckpoint: number | null;
  controller: AbortController;
}

export function helpers(): HelperControl {
  const controller = new AbortController();
  const h: HelperControl = {
    signal: controller.signal,
    checkpoints: 0,
    abortAtCheckpoint: null,
    controller,
    async checkpoint() {
      h.checkpoints += 1;
      if (
        h.abortAtCheckpoint !== null &&
        h.checkpoints >= h.abortAtCheckpoint
      ) {
        controller.abort(new AttemptAbortedError('readset_invalidated'));
        throw new AttemptAbortedError('readset_invalidated');
      }
    },
    abortReason: () =>
      controller.signal.aborted ? 'readset_invalidated' : null,
  };
  return h;
}

export async function runHandler(
  r: Rig,
  attemptClaim: ClaimedAttempt,
  h: HandlerHelpers = helpers(),
): Promise<HandlerOutcome> {
  return createTeamHandler(r.deps)(attemptClaim, h);
}

/** Tool results of the conversation as the model saw them, parsed. */
export function toolResultsOf(
  request: ChatRequest,
): { id: string; body: Record<string, unknown> }[] {
  return request.messages.flatMap((message) => {
    if (message.role !== 'tool') return [];
    const lines = message.content
      .split('\n')
      .filter((line) => line.startsWith('| '))
      .map((line) => line.slice(2));
    try {
      return [
        {
          id: message.toolCallId,
          body: JSON.parse(lines.join('\n')) as Record<string, unknown>,
        },
      ];
    } catch {
      return [{ id: message.toolCallId, body: { raw: lines.join('\n') } }];
    }
  });
}
