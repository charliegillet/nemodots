// The nine team tools (TOOL_COVERAGE section 1). Identity comes from the
// AttemptContext the coordinator built; model-supplied receipt ids are
// citations checked against scope, never authority; mission/task/attempt ids
// are never accepted from the model. Policy refusals are tool results the model
// can act on ({ ok:false, error }); fence, support and abort errors propagate to
// the worker host, which owns their handling.
import {
  digest,
  TEAM_TOOL_INPUTS,
  type ActionAdmissionPort,
  type AttemptContext,
  type Capability,
  type ContextSnapshot,
  type DependencyEntry,
  type ModelCallId,
  type ObservationReceipt,
  type ReceiptId,
  sourceKeyFamily,
  type TaskId,
  type TeamToolName,
  unionDependencyVectors,
} from '../contracts/index.js';
import { citationsOutOfScope, UnknownRunbookError } from '../context/index.js';
import type { HandlerHelpers } from '../coordinator/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import { precheckDelegation } from './delegation.js';
import { requireVerifierEnabled } from './policy.js';
import type { TeamDeps } from './types.js';

export interface LoopState {
  receipts: Map<string, ObservationReceipt>;
  latestByKey: Map<string, ObservationReceipt>;
  readSet: DependencyEntry[];
  readSetReceiptIds: string[];
  findingIds: string[];
  delegated: TaskId[];
  delegatedVerifiers: TaskId[];
  proposedActionIds: string[];
}

export function newLoopState(): LoopState {
  return {
    receipts: new Map(),
    latestByKey: new Map(),
    readSet: [],
    readSetReceiptIds: [],
    findingIds: [],
    delegated: [],
    delegatedVerifiers: [],
    proposedActionIds: [],
  };
}

export interface ToolCall {
  toolCallId: string;
  modelCallId: ModelCallId;
  snapshot: ContextSnapshot;
}

export interface ToolOutcome {
  ok: boolean;
  /** JSON text handed back to the model. */
  content: string;
  /** Dependencies the result introduces into the attempt's context. */
  vector: DependencyEntry[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const fail = (error: string, message: string, extra?: object): ToolOutcome => ({
  ok: false,
  content: JSON.stringify({ ok: false, error, message, ...extra }),
  vector: [],
});

const done = (
  payload: object,
  vector: DependencyEntry[] = [],
): ToolOutcome => ({
  ok: true,
  content: JSON.stringify({ ok: true, ...payload }),
  vector,
});

const hasAny = (context: AttemptContext, wanted: Capability[]) =>
  wanted.some((capability) => context.capabilities.includes(capability));

const entryOf = (receipt: ObservationReceipt): DependencyEntry => ({
  sourceKey: receipt.source.key,
  sourceRevision: receipt.sourceRevision,
  receiptId: receipt.id,
});

function issuesOf(error: unknown): string {
  const issues = (
    error as { issues?: { path: PropertyKey[]; message: string }[] }
  ).issues;
  return issues
    ? issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    : (error as Error).message;
}

function refusalOf(content: string): { error?: string; detail?: string } {
  const body = JSON.parse(content) as {
    error?: string;
    message?: string;
    issues?: string[];
  };
  return {
    error: body.error,
    detail: (body.issues?.join('; ') ?? body.message ?? '').slice(0, 240),
  };
}

export function createToolExecutor(
  deps: TeamDeps,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
  state: LoopState,
) {
  const { context } = claimed;
  const attemptScope = () => ({
    readSetReceiptIds: state.readSetReceiptIds as ReceiptId[],
    inheritedDependencyVector: claimed.attempt.inheritedDependencyVector,
  });

  async function observeSource(args: unknown, call: ToolCall) {
    if (!context.capabilities.includes('observe'))
      return fail('capability_denied', 'this task may not observe sources');
    const input = TEAM_TOOL_INPUTS.observe_source.parse(args);
    let receipt: ObservationReceipt;
    try {
      receipt = await deps.observer.observe(context, {
        sourceKey: input.sourceKey,
        modelCallId: call.modelCallId,
        toolCallId: call.toolCallId,
      });
    } catch (error) {
      // A registered key family with no reader (page, memory, runbook,
      // acceptance) is a refusal the model can act on, not a failed attempt.
      // Acceptance data stays model-invisible: no reader is added for it.
      if ((error as Error).name === 'UnsupportedSourceError') {
        // angle brackets would be escaped inside the data wrapper: use braces
        const family = (
          sourceKeyFamily(input.sourceKey) ?? 'requested'
        ).replace(/<([^>]+)>/g, '{$1}');
        return fail(
          'source_unavailable',
          `no reader serves the ${family} source family; observe one of the sources listed in the checkout-architecture runbook instead`,
          { family },
        );
      }
      throw error;
    }
    const entry = entryOf(receipt);
    state.receipts.set(receipt.id, receipt);
    state.latestByKey.set(receipt.source.key, receipt);
    if (!state.readSetReceiptIds.includes(receipt.id)) {
      state.readSetReceiptIds.push(receipt.id);
      state.readSet = unionDependencyVectors(state.readSet, [entry]);
      // Fenced and support-checked: a receipt superseded since registration
      // rejects the publication and invalidates this attempt (C13).
      await deps.coordinator.addReadSet(context, [entry]);
    }
    return done(
      {
        receiptId: receipt.id,
        sourceKey: receipt.source.key,
        revision: receipt.sourceRevision,
        observedAt: receipt.observedAt,
        status: receipt.status,
        value: receipt.normalizedValue,
      },
      [entry],
    );
  }

  async function delegateTask(args: unknown, call: ToolCall) {
    const input = TEAM_TOOL_INPUTS.delegate_task.parse(args);
    const check = precheckDelegation(context, input.role, input.justification);
    if (!check.ok) return fail(check.error, check.message);
    try {
      const created = await deps.coordinator.delegate(context, {
        ...input,
        dependencyVector: call.snapshot.dependencyVector,
        createdByModelCallId: call.modelCallId,
        toolCallId: call.toolCallId,
      });
      state.delegated.push(created.taskId);
      if (input.role === 'verifier')
        state.delegatedVerifiers.push(created.taskId);
      return done({
        taskId: created.taskId,
        created: created.created,
        role: input.role,
        capabilities: check.childCapabilities,
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'DelegationRejectedError')
        return fail('delegation_rejected', (error as Error).message, {
          issues: (error as { issues: string[] }).issues,
        });
      if (name === 'CapabilityDeniedError')
        return fail('capability_denied', (error as Error).message);
      throw error;
    }
  }

  async function waitForChildren(call: ToolCall) {
    if (!context.capabilities.includes('delegate'))
      return fail('capability_denied', 'this task may not delegate');
    await deps.coordinator.markWaiting(context);
    const pollMs = deps.config.waitPollMs ?? 250;
    const deadline = Date.now() + (deps.config.waitTimeoutMs ?? 120_000);
    // The wait runs PARKED: it holds no worker slot, so the children it waits
    // for (and their own children) can use the capacity this attempt would
    // otherwise sit on. The attempt stays leased, fenced and drift-checked
    // (checkpoint below), and takes a slot again before it continues. Test
    // doubles without a host run the wait in place.
    const park =
      helpers.parked?.bind(helpers) ?? (<T>(wait: () => Promise<T>) => wait());
    return park(async () => {
      for (;;) {
        await helpers.checkpoint();
        const status = await deps.coordinator.resumeFromWaiting(context);
        if (status.allTerminal) {
          // fresh reads of what the children published, now
          const outputs = await deps.reads.outputsOf(
            context,
            status.children.map((child) => child.id),
          );
          const vector = unionDependencyVectors(
            ...outputs.filter((o) => o.usable).map((o) => o.dependencyVector),
          );
          return done(
            {
              allTerminal: true,
              children: outputs.map((child) => ({
                taskId: child.taskId,
                role: child.role,
                status: child.status,
                usable: child.usable,
                output: child.usable ? child.text : null,
              })),
            },
            vector,
          );
        }
        if (Date.now() >= deadline || helpers.signal.aborted)
          return done({
            allTerminal: false,
            children: status.children.map((child) => ({
              taskId: child.id,
              role: child.role,
              status: child.status,
            })),
          });
        await sleep(pollMs, helpers.signal);
      }
    });
    void call;
  }

  async function publishFinding(args: unknown, call: ToolCall) {
    if (!context.capabilities.includes('publish_finding'))
      return fail('capability_denied', 'this task may not publish findings');
    const input = TEAM_TOOL_INPUTS.publish_finding.parse(args);
    const outside = citationsOutOfScope(
      input.supportingReceiptIds,
      call.snapshot,
      attemptScope(),
    );
    if (outside.length > 0)
      return fail(
        'citation_out_of_scope',
        'cited receipts are not in your scope',
        { receiptIds: outside },
      );
    try {
      const { findingId } = await deps.coordinator.publishFinding(context, {
        ...input,
        dependencyVector: unionDependencyVectors(
          call.snapshot.dependencyVector,
          state.readSet,
        ),
      });
      state.findingIds.push(findingId);
      return done({ findingId });
    } catch (error) {
      if ((error as Error).name === 'CitationOutOfScopeError')
        return fail('citation_out_of_scope', (error as Error).message);
      throw error;
    }
  }

  /** True once a verifier this attempt delegated finished with a usable output. */
  async function verifierConfirmed(): Promise<boolean> {
    for (const id of state.delegatedVerifiers) {
      const status = await deps.coordinator.getTaskStatus(
        context.missionId,
        id,
      );
      if (status.task.status === 'succeeded' && status.outputUsable === true)
        return true;
    }
    return false;
  }

  async function proposeAction(args: unknown, call: ToolCall) {
    const proposeCapabilities: Capability[] = [
      'propose_config_change',
      'propose_cache_flush',
    ];
    if (!hasAny(context, proposeCapabilities))
      return fail(
        'capability_denied',
        `a ${context.role} task cannot propose changes; delegate the repair to a specialist with delegate_task and a justification`,
        { capability: 'propose_config_change' },
      );
    const raw = (args ?? {}) as {
      action?: unknown;
      payload?: Record<string, unknown>;
      supportingReceiptIds?: unknown;
    };
    const needed: Capability =
      raw.action === 'flush_cache_namespace'
        ? 'propose_cache_flush'
        : 'propose_config_change';
    if (!context.capabilities.includes(needed))
      return fail(
        'capability_denied',
        `this task lacks ${needed}; delegate to a role that has it`,
        { capability: needed },
      );
    // The model cannot compute a digest: the server derives the expected
    // current value digest from this attempt's latest reading of the key.
    let candidate: unknown = args;
    if (raw.action === 'set_config' && raw.payload) {
      const key = String(raw.payload.key ?? '');
      const latest = state.latestByKey.get(`checkout.config/${key}`);
      if (!latest)
        return fail(
          'observe_first',
          `observe checkout.config/${key} before proposing a change to it`,
        );
      const observed = latest.normalizedValue as { value?: unknown };
      candidate = {
        ...raw,
        payload: {
          ...raw.payload,
          expectedCurrentValueDigest: digest(observed.value),
        },
      };
    }
    if (requireVerifierEnabled(deps.config) && !(await verifierConfirmed())) {
      if (!context.capabilities.includes('delegate'))
        return fail(
          'verification_unavailable',
          'pre-change verification is required but this task may not delegate a verifier; ask for a replan',
        );
      return fail(
        'verification_required',
        'before proposing a change, delegate a verifier (delegate_task with role verifier) to confirm your reading independently, wait_for_children, then propose',
      );
    }
    const input = TEAM_TOOL_INPUTS.propose_action.parse(candidate);
    const outside = citationsOutOfScope(
      input.supportingReceiptIds,
      call.snapshot,
      attemptScope(),
    );
    if (outside.length > 0)
      return fail(
        'citation_out_of_scope',
        'cited receipts are not in your scope',
        { receiptIds: outside },
      );
    try {
      const intent = await deps.actions.propose(input, {
        ...context,
        modelCallId: call.modelCallId,
        toolCallId: call.toolCallId,
      } as Parameters<ActionAdmissionPort['propose']>[1]);
      state.proposedActionIds.push(intent.id);
      return done({
        actionId: intent.id,
        status: intent.status,
        blockReason: intent.blockReason,
        blockDetail: intent.blockDetail,
      });
    } catch (error) {
      if ((error as Error).name === 'ProposalRejectedError')
        return fail('proposal_rejected', (error as Error).message);
      throw error;
    }
  }

  async function requestReplan(args: unknown) {
    if (!context.capabilities.includes('request_replan'))
      return fail('capability_denied', 'this task may not request a replan');
    const input = TEAM_TOOL_INPUTS.request_replan.parse(args);
    const outcome = await deps.coordinator.requestReplan(context, input.reason);
    return done({ scheduled: outcome.scheduled });
  }

  async function execute(
    name: string,
    args: unknown,
    call: ToolCall,
  ): Promise<ToolOutcome> {
    const known = name as TeamToolName;
    // own keys only: 'constructor', 'toString', '__proto__' are not tools
    if (!Object.hasOwn(TEAM_TOOL_INPUTS, name))
      return fail('unknown_tool', `no tool named ${name}`);
    let outcome: ToolOutcome;
    try {
      switch (known) {
        case 'observe_source':
          outcome = await observeSource(args, call);
          break;
        case 'list_runbooks':
          TEAM_TOOL_INPUTS.list_runbooks.parse(args ?? {});
          outcome = done({ runbooks: deps.runbooks.catalogue.list() });
          break;
        case 'read_runbook': {
          const input = TEAM_TOOL_INPUTS.read_runbook.parse(args);
          try {
            const runbook = deps.runbooks.read(input.id);
            outcome = done({ id: runbook.id, text: runbook.text });
          } catch (error) {
            if (!(error instanceof UnknownRunbookError)) throw error;
            outcome = fail('unknown_runbook', 'no such runbook id');
          }
          break;
        }
        case 'get_task_status': {
          const input = TEAM_TOOL_INPUTS.get_task_status.parse(args);
          try {
            const status = await deps.coordinator.getTaskStatus(
              context.missionId,
              input.taskId,
            );
            outcome = done({
              taskId: input.taskId,
              status: status.task.status,
              role: status.task.role,
              title: status.task.title,
              outputUsable: status.outputUsable,
            });
          } catch (error) {
            if ((error as Error).name !== 'TaskNotFoundError') throw error;
            outcome = fail('task_not_found', 'no such task in this mission');
          }
          break;
        }
        case 'wait_for_children':
          TEAM_TOOL_INPUTS.wait_for_children.parse(args ?? {});
          outcome = await waitForChildren(call);
          break;
        case 'delegate_task':
          outcome = await delegateTask(args, call);
          break;
        case 'publish_finding':
          outcome = await publishFinding(args, call);
          break;
        case 'propose_action':
          outcome = await proposeAction(args, call);
          break;
        case 'request_replan':
          outcome = await requestReplan(args);
          break;
      }
    } catch (error) {
      if ((error as Error).name === 'ZodError')
        outcome = fail('invalid_arguments', issuesOf(error));
      else throw error;
    }
    deps.onEvent?.({
      kind: 'tool',
      attemptId: context.attemptId,
      name,
      ok: outcome.ok,
      ...(outcome.ok ? {} : refusalOf(outcome.content)),
    });
    return outcome;
  }

  return { execute };
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;
