import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import {
  ADAPTER_POLICY,
  AttemptContextSchema,
  ROLE_CAPABILITIES,
  TEAM_TOOL_INPUTS,
  digest,
  toolSchemas,
  unionDependencyVectors,
  type ActionAdmissionPort,
  type AttemptContext,
  type Capability,
  type DependencyEntry,
  type DependencyVector,
  type ModelCallId,
  type ReceiptId,
  type TaskId,
  type TeamToolName,
  type ToolSchema,
  CONFIG_VALUE_DOMAINS,
} from '../contracts/index.js';
import { stripActors } from '../context/untrusted.js';
import { UnknownRunbookError } from '../context/runbooks.js';
import { InvalidProposalError } from '../actions/errors.js';
import { createEventSink } from '../coordinator/events.js';
import {
  CapabilityDeniedError,
  CitationOutOfScopeError,
  DelegationRejectedError,
  TaskNotFoundError,
} from '../coordinator/errors.js';
import { createRunbookLibrary } from './catalogue.js';
import { checkDelegation } from './delegation.js';
import { ToolError } from './errors.js';
import { createLedgerObserver } from './observer.js';
import { createPgTeamReader } from './pg-reader.js';
import type {
  ObservationPort,
  ObservedReceipt,
  RunbookLibrary,
  TeamReader,
  ToolCoordinator,
} from './types.js';
import {
  createAuthorityReader,
  createDefaultActions,
  createPublishingCoordinator,
} from './wiring.js';

// The nine typed team tools (TOOL_COVERAGE.md section 1). Identity, mission,
// task and attempt come from the AttemptContext only; receipt ids supplied by
// the model are citations that the ports validate against scope, never
// authority. Every result is data for the model; fence and support errors
// propagate to the worker host untouched.

export interface ExecuteOptions {
  context: AttemptContext;
  toolCallId: string;
  /** The model call that emitted this tool call (needed by propose_action). */
  modelCallId?: string | null;
  /** Snapshot vector of the emitting call when the caller already holds it. */
  snapshotVector?: DependencyVector;
  signal?: AbortSignal;
  /** Re-checks the attempt (abort on drift); called while waiting for children. */
  checkpoint?: () => Promise<void>;
}

export interface ToolExecution {
  value: unknown;
  /** Receipts the result rests on; the next model call inherits them. */
  dependencyVector: DependencyVector;
  observed?: ObservedReceipt;
}

export interface TeamTools {
  schemas(): ToolSchema[];
  execute(
    name: string,
    rawArgs: unknown,
    options: ExecuteOptions,
  ): Promise<unknown>;
  executeDetailed(
    name: string,
    rawArgs: unknown,
    options: ExecuteOptions,
  ): Promise<ToolExecution>;
}

/** A generous bag: explicit ports win, everything else is derived from `pool`. */
export interface TeamToolsDeps {
  pool?: pg.Pool;
  appPool?: pg.Pool;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
  coordinator?: ToolCoordinator;
  actions?: Pick<ActionAdmissionPort, 'propose'>;
  observer?: ObservationPort;
  reader?: TeamReader;
  runbooks?: RunbookLibrary;
  readers?: import('../contracts/index.js').SourceReaderPort;
  wait?: { timeoutMs?: number; pollMs?: number };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Unrecognised keys (adminUrl, appUrl, ...) are ignored. */
  [extra: string]: unknown;
}

const OUTPUT_CLIP = 2_000;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function holders(capability: Capability): string[] {
  return Object.entries(ROLE_CAPABILITIES)
    .filter(([, caps]) => (caps as readonly string[]).includes(capability))
    .map(([role]) => role);
}

function denied(context: AttemptContext, capability: Capability): ToolError {
  return new ToolError(
    'capability_denied',
    `this ${context.role} task does not hold the ${capability} capability. Kinds of task that hold it: ${holders(capability).join(', ') || 'none'}.`,
  );
}

function clip(value: unknown): unknown {
  const text = JSON.stringify(value) ?? 'null';
  return text.length <= OUTPUT_CLIP
    ? value
    : { truncated: true, text: text.slice(0, OUTPUT_CLIP) };
}

/**
 * The server-owned value domain of a configuration key (CONFIG_VALUE_DOMAINS),
 * as JSON Schema. The model learns what a valid proposal looks like from the
 * policy itself, not from prose in a runbook (finding D7).
 */
export function valueDomainOf(sourceKey: string): Record<string, unknown> | null {
  const key = sourceKey.slice('checkout.config/'.length);
  if (!sourceKey.startsWith('checkout.config/')) return null;
  if (!Object.hasOwn(CONFIG_VALUE_DOMAINS, key)) return null;
  const schema = z.toJSONSchema(
    CONFIG_VALUE_DOMAINS[key as keyof typeof CONFIG_VALUE_DOMAINS],
  ) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function observeResult(receipt: ObservedReceipt) {
  const value = stripActors(receipt.normalizedValue).value;
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const isMember =
    receipt.sourceKey.startsWith('checkout.config/') &&
    record !== null &&
    'value' in record;
  return {
    receiptId: receipt.receiptId,
    sourceKey: receipt.sourceKey,
    revision: receipt.sourceRevision,
    observedAt: receipt.observedAt,
    lastConfirmedAt: receipt.lastConfirmedAt,
    newRevision: receipt.newRevision,
    value,
    ...(isMember ? { valueDigest: digest(record!.value) } : {}),
    ...(isMember && valueDomainOf(receipt.sourceKey)
      ? { valueDomain: valueDomainOf(receipt.sourceKey) }
      : {}),
    ...(receipt.negative ? { negative: receipt.negative } : {}),
  };
}

function zodIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues
    .slice(0, 6)
    .map(
      (issue) =>
        `${issue.path.map(String).join('.') || '<arguments>'}: ${issue.message}`,
    );
}

export function createTeamTools(deps: TeamToolsDeps = {}): TeamTools {
  const pool = deps.pool ?? deps.appPool;
  const need = <T>(name: string, value: T | undefined): T => {
    if (value === undefined)
      throw new Error(`createTeamTools: ${name} or a pool is required`);
    return value;
  };
  const env = deps.env ?? {};
  const reader =
    deps.reader ?? need('reader', pool && createPgTeamReader(pool));
  const coordinator =
    deps.coordinator ??
    need(
      'coordinator',
      pool && createPublishingCoordinator(pool, { env, clock: deps.clock }),
    );
  const actions =
    deps.actions ?? need('actions', pool && createDefaultActions(pool));
  const observer =
    deps.observer ??
    need(
      'observer',
      pool &&
        createLedgerObserver({
          pool,
          readers: deps.readers ?? createAuthorityReader(pool),
          reader,
          events: createEventSink(),
          clock: deps.clock,
        }),
    );
  const runbooks = deps.runbooks ?? createRunbookLibrary();
  const sleep = deps.sleep ?? defaultSleep;
  const waitTimeoutMs = deps.wait?.timeoutMs ?? 90_000;
  const waitPollMs = deps.wait?.pollMs ?? 500;

  async function emittingVector(
    options: ExecuteOptions,
  ): Promise<DependencyVector> {
    if (options.snapshotVector) return options.snapshotVector;
    if (options.modelCallId === undefined || options.modelCallId === null)
      return [];
    const vector = await reader.snapshotVector(
      options.modelCallId,
      options.context,
    );
    if (!vector)
      throw new ToolError(
        'unknown_model_call',
        'the emitting model call is not part of this attempt',
      );
    return vector;
  }

  type Handler = (
    args: never,
    options: ExecuteOptions,
  ) => Promise<ToolExecution>;
  const plain = (value: unknown): ToolExecution => ({
    value,
    dependencyVector: [],
  });

  const handlers: Record<TeamToolName, Handler> = {
    async observe_source(args: { sourceKey: never }, options) {
      const { context, toolCallId } = options;
      const modelCallId = (options.modelCallId ?? null) as ModelCallId | null;
      const receipt = await observer.observe({
        context,
        sourceKey: args.sourceKey,
        toolCallId,
        modelCallId,
      });
      const entry: DependencyEntry = {
        sourceKey: receipt.sourceKey,
        sourceRevision: receipt.sourceRevision,
        receiptId: receipt.receiptId,
      };
      // Fenced and support-checked: a receipt superseded since registration
      // invalidates the attempt instead of joining its readset.
      await coordinator.addReadSet(context, [entry]);
      return {
        value: observeResult(receipt),
        dependencyVector: [entry],
        observed: receipt,
      };
    },

    async list_runbooks() {
      return plain({ runbooks: runbooks.list() });
    },

    async read_runbook(args: { id: string }) {
      try {
        const { id, title, text } = runbooks.read(args.id);
        return plain({ id, title, text });
      } catch (error) {
        if (error instanceof UnknownRunbookError)
          throw new ToolError(
            'unknown_runbook',
            'no runbook has that id; call list_runbooks',
          );
        throw error;
      }
    },

    async get_task_status(args: { taskId: TaskId }, { context }) {
      try {
        const view = await coordinator.getTaskStatus(
          context.missionId,
          args.taskId,
        );
        const task = view.task;
        let output: unknown = null;
        if (task.outputId) {
          const [found] = await reader.taskOutputs(context.missionId, [
            task.outputId,
          ]);
          if (found)
            output = {
              kind: found.kind,
              usable: found.usable,
              content: clip(found.content),
            };
        }
        return {
          value: {
            taskId: task.id,
            title: task.title,
            role: task.role,
            status: task.status,
            depth: task.depth,
            parentId: task.parentId,
            attemptCount: task.attemptCount,
            outputUsable: view.outputUsable,
            output,
          },
          dependencyVector: [],
        };
      } catch (error) {
        if (error instanceof TaskNotFoundError)
          throw new ToolError('task_not_found', 'no such task in this mission');
        throw error;
      }
    },

    async wait_for_children(_args: never, options) {
      const { context } = options;
      await coordinator.markWaiting(context);
      const deadline = Date.now() + waitTimeoutMs;
      for (;;) {
        const status = await coordinator.resumeFromWaiting(context);
        if (status.allTerminal || Date.now() >= deadline) {
          const outputIds = status.children.flatMap((child) =>
            child.outputId ? [child.outputId] : [],
          );
          const outputs = new Map(
            (await reader.taskOutputs(context.missionId, outputIds)).map(
              (output) => [output.id, output],
            ),
          );
          const vectors: DependencyVector[] = [];
          const children = status.children.map((child) => {
            const output = child.outputId
              ? outputs.get(child.outputId)
              : undefined;
            if (output?.usable) vectors.push(output.dependencyVector);
            return {
              taskId: child.id,
              role: child.role,
              status: child.status,
              output: output
                ? {
                    kind: output.kind,
                    usable: output.usable,
                    content: clip(output.content),
                  }
                : null,
            };
          });
          return {
            value: {
              allTerminal: status.allTerminal,
              children,
              ...(status.allTerminal
                ? {}
                : {
                    note: 'Some children have not finished yet; call wait_for_children again to keep waiting.',
                  }),
            },
            dependencyVector: unionDependencyVectors(...vectors),
          };
        }
        await sleep(waitPollMs, options.signal);
        if (options.checkpoint) await options.checkpoint();
      }
    },

    async delegate_task(
      args: {
        title: string;
        role: never;
        question: string;
        dependsOn: TaskId[];
        justification: string;
      },
      options,
    ) {
      const { context, toolCallId } = options;
      const facts = await reader.delegationFacts(context);
      const decision = checkDelegation(
        {
          role: args.role,
          title: args.title,
          question: args.question,
          justification: args.justification,
          dependsOn: args.dependsOn,
        },
        facts,
        randomUUID() as TaskId,
      );
      if (!decision.ok)
        throw new ToolError(
          'delegation_rejected',
          decision.issues.join('; '),
          decision.issues,
        );
      const vector = await emittingVector(options);
      try {
        const created = await coordinator.delegate(context, {
          title: args.title,
          role: args.role,
          question: args.question,
          dependsOn: args.dependsOn,
          justification: args.justification,
          dependencyVector: vector,
          createdByModelCallId: (options.modelCallId ??
            null) as ModelCallId | null,
          toolCallId,
        });
        return plain({
          taskId: created.taskId,
          created: created.created,
          role: args.role,
          capabilities: decision.capabilities,
          depth: decision.depth,
        });
      } catch (error) {
        if (error instanceof DelegationRejectedError)
          throw new ToolError(
            'delegation_rejected',
            error.issues.join('; '),
            error.issues,
          );
        if (error instanceof CapabilityDeniedError)
          throw denied(context, error.capability as Capability);
        throw error;
      }
    },

    async publish_finding(
      args: {
        claim: string;
        supportingReceiptIds: ReceiptId[];
        confidence: 'low' | 'medium' | 'high';
      },
      options,
    ) {
      const vector = await emittingVector(options);
      try {
        const published = await coordinator.publishFinding(options.context, {
          claim: args.claim,
          supportingReceiptIds: args.supportingReceiptIds,
          confidence: args.confidence,
          dependencyVector: vector,
        });
        return plain({ findingId: published.findingId, trust: 'model_claim' });
      } catch (error) {
        if (error instanceof CitationOutOfScopeError)
          throw new ToolError(
            'citation_out_of_scope',
            'a cited receipt is outside your context (not in your evidence, readset or inherited context)',
            error.receiptIds,
          );
        throw error;
      }
    },

    async propose_action(
      args: {
        action: keyof typeof ADAPTER_POLICY &
          ('set_config' | 'flush_cache_namespace');
        payload: unknown;
        supportingReceiptIds: ReceiptId[];
        rationale: string;
      },
      options,
    ) {
      const { context, toolCallId } = options;
      const capability = ADAPTER_POLICY[args.action].capability;
      if (!context.capabilities.includes(capability))
        throw denied(context, capability);
      if (!options.modelCallId)
        throw new ToolError(
          'unknown_model_call',
          'propose_action must come from a recorded model call',
        );
      try {
        const intent = await actions.propose(args as never, {
          ...context,
          modelCallId: options.modelCallId as ModelCallId,
          toolCallId,
        });
        return plain({
          actionId: intent.id,
          id: intent.id,
          status: intent.status,
          action: intent.action,
          target: intent.target.sourceKey,
          expectedTargetVersion: intent.expectedTargetVersion,
          requiredSources: intent.requiredSources,
          blockReason: intent.blockReason,
          blockDetail: intent.blockDetail,
          note:
            intent.status === 'blocked'
              ? 'The server blocked this proposal; it changed nothing.'
              : 'Proposed. The server admits it only while its evidence is still current and re-checks at commit; a later observation tells you whether it took effect.',
        });
      } catch (error) {
        if (error instanceof InvalidProposalError)
          throw new ToolError('invalid_proposal', error.message);
        throw error;
      }
    },

    async request_replan(args: { reason: string }, { context }) {
      try {
        const result = await coordinator.requestReplan(context, args.reason);
        return plain({
          scheduled: result.scheduled,
          ...(result.scheduled
            ? {}
            : {
                note: 'No replan was scheduled (the replan cap is reached or the planner has nothing to revise).',
              }),
        });
      } catch (error) {
        if (error instanceof CapabilityDeniedError)
          throw denied(context, 'request_replan');
        throw error;
      }
    },
  };

  const NEEDS: Partial<Record<TeamToolName, Capability>> = {
    observe_source: 'observe',
    list_runbooks: 'observe',
    read_runbook: 'observe',
    get_task_status: 'observe',
    wait_for_children: 'delegate',
    delegate_task: 'delegate',
    publish_finding: 'publish_finding',
    request_replan: 'request_replan',
  };

  async function executeDetailed(
    name: string,
    rawArgs: unknown,
    options: ExecuteOptions,
  ): Promise<ToolExecution> {
    if (!Object.hasOwn(TEAM_TOOL_INPUTS, name))
      throw new ToolError('unknown_tool', 'that tool does not exist');
    const tool = name as TeamToolName;
    const context = AttemptContextSchema.parse(options.context);
    const scoped: ExecuteOptions = { ...options, context };

    if (tool === 'propose_action') {
      if (
        !context.capabilities.includes('propose_config_change') &&
        !context.capabilities.includes('propose_cache_flush')
      )
        throw denied(context, 'propose_config_change');
    } else {
      const capability = NEEDS[tool];
      if (capability && !context.capabilities.includes(capability))
        throw denied(context, capability);
    }

    let args: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        throw new ToolError('invalid_json', 'the arguments are not valid JSON');
      }
    }
    const parsed = TEAM_TOOL_INPUTS[tool].safeParse(args);
    if (!parsed.success)
      throw new ToolError(
        'invalid_arguments',
        'the arguments do not match the tool schema',
        zodIssues(parsed.error),
      );
    return handlers[tool](parsed.data as never, scoped);
  }

  return {
    schemas: () => toolSchemas(),
    executeDetailed,
    async execute(name, rawArgs, options) {
      return (await executeDetailed(name, rawArgs, options)).value;
    },
  };
}
