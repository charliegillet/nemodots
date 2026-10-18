import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import {
  digest,
  PlanShapeSchema,
  TEAM_TOOL_INPUTS,
  unionDependencyVectors,
  type AttemptContext,
  type ChatMessage,
  type DependencyVector,
  type EventSinkPort,
  type InferencePort,
  type ModelCallId,
  type ModelCallRecord,
  type ProposeInput,
  type Scope,
  type SourceKey,
  type TaskId,
  type TeamToolName,
} from '../contracts/index.js';
import { compileContext, type HistoryItemInput } from '../context/index.js';
import type {
  AttemptHandler,
  ClaimedAttempt,
  Coordinator,
} from '../coordinator/index.js';
import { withTransaction } from '../db/tx.js';
import {
  getReceipt,
  recordReadSet,
  registerObservation,
} from '../ledger/index.js';
import { configValueDigest } from '../sandbox/version-authority.js';
import type { SourceReaderPort } from '../contracts/index.js';
import type { Actions } from './actions.js';
import { emitReceipt } from './watcher.js';

// Demo Nemotron team (simplified W4.1). Every decision below is a live model
// call on Crusoe: the planner's plan, every tool call and its arguments, every
// delegation and the remediation proposal. The code only executes the typed
// tools the model calls and enforces capabilities through the coordinator.

const RUNBOOK_DIR = path.resolve(
  process.cwd(),
  'src/server/nemodots/runtime/runbooks',
);
const RUNBOOKS: Record<string, { title: string; file: string }> = {
  'checkout-system': {
    title: 'Checkout system: components, sources and config keys',
    file: 'checkout-system.md',
  },
  'remediation-policy': {
    title: 'Remediation policy: bounded actions, verification, customer data',
    file: 'remediation-policy.md',
  },
};
const runbookText = (id: string) =>
  readFileSync(path.join(RUNBOOK_DIR, RUNBOOKS[id].file), 'utf8');

const COMMON = `You are part of NemoDots, a team of NVIDIA Nemotron agents restoring a broken checkout service while keeping a typed evidence ledger.
Rules:
- Ground every claim in sources you observed with observe_source (each returns a receipt id). Never invent values or receipt ids.
- Use only the tools you are given. Keep tool arguments exactly to their schema.
- Be efficient: a few targeted observations, then act or report.
- When your task is done, reply with a short plain-text summary (no tool call). That summary is your task output.`;

const ROLE_TEXT: Record<string, string> = {
  planner: `You are the planner. Split the mission into 2 to 4 independent root tasks for other agents.
Roles you can use: investigator (observe, delegate, publish_finding), cache_specialist / database_specialist / routing_specialist (observe, delegate to a verifier, propose bounded config changes or cache flushes), verifier (observe, publish_finding).
Give each task only the capabilities its role allows (subset of: observe, delegate, publish_finding, request_replan, propose_config_change, propose_cache_flush). Prefer investigators for root tasks: they diagnose and delegate fixes to specialists. One root task should diagnose and restore the failing checkout path; another should independently check that customer data (orders, inventory) stays intact. Use dependsOn only when a task truly needs another's output (indices into the list). Reply with the JSON plan only.`,
  investigator: `You are an investigator. Diagnose your task's question from live sources (health, metrics, config, cache stats). You cannot change anything yourself. If the evidence shows the checkout is degraded or failing and the cause is in your area, your task is NOT done until a specialist has handled it: call delegate_task with role cache_specialist, database_specialist or routing_specialist and a precise question naming the sources and receipt ids, then call wait_for_children, then report what the specialist and its verifier found. Only report without delegating when your area shows no fault.`,
  cache_specialist: `You are the cache specialist and the only agent allowed to change cache configuration. Steps, in order:
1. Observe the evidence you need (checkout.metrics, redis.stats, and the checkout.config/<key> you will change). Do not delegate yet.
2. Read the remediation-policy runbook, then call propose_action with the smallest bounded remediation that fixes the diagnosed fault (set_config on one key, or flush_cache_namespace). For set_config copy valueDigest from your latest observe_source of that key into expectedCurrentValueDigest. Publishing a finding is NOT a fix.
3. If the result is "blocked", the evidence changed: re-observe the key and propose again based on the new value.
4. Only after an action is "committed" or "verified": delegate_task to a verifier asking it to confirm checkout health from live sources, call wait_for_children, then reply with your summary.`,
  database_specialist: `You are the database specialist. Confirm from live sources, propose_action only if a config change is clearly needed (copy valueDigest from observe_source into expectedCurrentValueDigest), and after a committed action delegate_task to a verifier, wait_for_children, then report.`,
  routing_specialist: `You are the routing specialist. Confirm from live sources, propose_action only if a config change is clearly needed (copy valueDigest from observe_source into expectedCurrentValueDigest), and after a committed action delegate_task to a verifier, wait_for_children, then report.`,
  verifier: `You are a verifier. Independently observe the live sources needed to answer your question (health, metrics, recent orders, inventory). Publish a finding with the receipt ids that support it, then report pass or fail with reasons.`,
  postcondition: `You are a postcondition checker. Observe live sources and report.`,
};

const CAPABILITY_TOOLS: Record<string, TeamToolName[]> = {
  observe: ['observe_source', 'list_runbooks', 'read_runbook'],
  delegate: ['delegate_task', 'get_task_status', 'wait_for_children'],
  publish_finding: ['publish_finding'],
  propose_config_change: ['propose_action'],
  propose_cache_flush: ['propose_action'],
  request_replan: ['request_replan'],
};

function toolsFor(capabilities: readonly string[]): TeamToolName[] {
  const set = new Set<TeamToolName>();
  for (const capability of capabilities)
    for (const tool of CAPABILITY_TOOLS[capability] ?? []) set.add(tool);
  return [...set];
}

function sourceRef(key: string) {
  if (key.startsWith('checkout.config/'))
    return { sourceType: 'controlled_config', authority: 'controlled' } as const;
  if (key === 'checkout.config')
    return {
      sourceType: 'controlled_collection',
      authority: 'controlled',
    } as const;
  if (key === 'checkout.health' || key === 'checkout.metrics')
    return { sourceType: 'observed_endpoint', authority: 'observed' } as const;
  return { sourceType: 'observed_store', authority: 'observed' } as const;
}

export interface TeamDeps {
  pool: pg.Pool;
  coordinator: Coordinator;
  inference: InferencePort & { mode: 'live' | 'fixture' };
  readers: SourceReaderPort;
  actions: Actions;
  events: EventSinkPort;
  plannerModel: string;
  workerModel: string;
  scopeFor: (missionId: string) => Scope;
  log: (message: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function createTeamHandler(deps: TeamDeps): AttemptHandler {
  const { coordinator } = deps;

  async function callModel(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
    input: {
      role: string;
      tools: TeamToolName[];
      history: HistoryItemInput[];
      readSet: DependencyVector;
      responseFormat?: { name: string; schema: Record<string, unknown> };
    },
  ) {
    const context = claimed.context;
    const inherited = claimed.attempt.inheritedDependencyVector;
    const receipts = [];
    for (const entry of inherited) {
      try {
        const receipt = await getReceipt(deps.pool, entry.receiptId);
        receipts.push(receipt);
      } catch {
        /* missing receipts are simply not injected */
      }
    }
    const repairNote = claimed.attempt.repairOf
      ? '\nThis is a REPAIR attempt: evidence your earlier attempt relied on has changed. Re-observe the sources before acting again.'
      : '';
    const compiled = compileContext({
      snapshotId: randomUUID() as never,
      layout: 'cache_aware',
      nowIso: new Date().toISOString(),
      commonInstructions: COMMON,
      roleInstructions: (ROLE_TEXT[input.role] ?? '') + repairNote,
      toolNames: input.tools,
      mission: claimed.mission,
      task: { title: claimed.task.title, question: claimed.task.question },
      runbooks: [],
      receipts: receipts as never,
      inheritedArtifacts: [],
      pageSnapshots: [],
      memories: [],
      invalidations: [],
      history: input.history,
      readSetVector: input.readSet,
      inheritedVector: inherited,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: compiled.system },
      ...compiled.messages.map((m): ChatMessage => {
        if (m.role === 'assistant')
          return {
            role: 'assistant',
            content: m.content || null,
            toolCalls: (m.toolCalls ?? []).map((call) => ({
              toolCallId: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          };
        if (m.role === 'tool')
          return { role: 'tool', toolCallId: m.toolCallId, content: m.content };
        return { role: 'user', content: m.content };
      }),
    ];
    const modelCallId = randomUUID() as ModelCallId;
    const model =
      input.role === 'planner' ? deps.plannerModel : deps.workerModel;
    const modelRole =
      input.role === 'planner'
        ? 'planner'
        : claimed.attempt.kind === 'repair'
          ? 'repair'
          : 'worker';
    const result = await deps.inference.complete(
      {
        model,
        messages,
        tools: compiled.tools,
        toolSchemaHash: compiled.tools.length ? digest(compiled.tools) : null,
        maxTokens: 4096,
        reasoningEffort: 'none',
        responseFormat: input.responseFormat ?? null,
        stream: true,
      },
      { signal, modelCallId, role: modelRole },
    );
    const record: ModelCallRecord = {
      id: modelCallId,
      scope: deps.scopeFor(context.missionId),
      taskId: context.taskId,
      attemptId: context.attemptId,
      role: modelRole,
      model: { requested: model, returned: result.modelReturned },
      provider: {
        host: deps.inference.host(),
        mode: deps.inference.mode,
      },
      contextSnapshotId: compiled.snapshot.id,
      attempts: result.attempts,
      outcome: result.outcome,
      outputDigest: result.content ? digest(result.content) : null,
      outputDependencyVector: compiled.snapshot.dependencyVector,
      toolCalls: result.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        name: call.name,
        argumentsDigest: digest(call.arguments),
      })),
      createdAt: new Date().toISOString(),
    } as ModelCallRecord;
    await coordinator.recordModelCall(context, {
      record,
      snapshot: compiled.snapshot,
    });
    return { result, modelCallId, vector: compiled.snapshot.dependencyVector };
  }

  async function runPlanner(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
  ) {
    const schema = z.toJSONSchema(PlanShapeSchema, {
      target: 'draft-2020-12',
    }) as Record<string, unknown>;
    delete schema.$schema;
    const history: HistoryItemInput[] = [];
    for (let tries = 0; tries < 3; tries += 1) {
      const { result, modelCallId } = await callModel(claimed, signal, {
        role: 'planner',
        tools: [],
        history,
        readSet: [],
        responseFormat: { name: 'plan', schema },
      });
      const text = (result.content ?? '').trim();
      try {
        const json = JSON.parse(
          text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
        );
        const parsed = PlanShapeSchema.parse(json);
        deps.log(
          `planner: ${parsed.tasks.length} tasks: ${parsed.tasks.map((t) => `${t.role}:${t.title}`).join(' | ')}`,
        );
        return {
          type: 'plan' as const,
          plan: parsed,
          createdByModelCallId: modelCallId,
        };
      } catch (error) {
        history.push(
          { role: 'assistant', content: text || '(empty)', dependencyVector: [] },
          {
            role: 'user',
            content: `That plan was invalid: ${(error as Error).message.slice(0, 600)}. Reply with a corrected JSON plan only.`,
            dependencyVector: [],
          },
        );
      }
    }
    return { type: 'failed' as const, reason: 'planner produced no valid plan' };
  }

  return async (claimed, helpers) => {
    const context = claimed.context;
    deps.log(
      `attempt ${context.role} "${claimed.task.title}" (${claimed.attempt.kind} #${claimed.attempt.n})`,
    );
    if (context.role === 'planner') return runPlanner(claimed, helpers.signal);

    const tools = toolsFor(context.capabilities);
    const history: HistoryItemInput[] = [];
    let readSet: DependencyVector = [];
    let lastVector: DependencyVector = claimed.attempt.inheritedDependencyVector;
    const children: TaskId[] = [];
    const maxIterations = Math.min(claimed.task.maxIterations, 14);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      await helpers.checkpoint();
      if (iteration === maxIterations - 1)
        history.push({
          role: 'user',
          content:
            'Iteration budget nearly exhausted: give your final summary now without calling tools.',
          dependencyVector: [],
        });
      const { result, modelCallId, vector } = await callModel(
        claimed,
        helpers.signal,
        {
          role: context.role,
          tools: iteration === maxIterations - 1 ? [] : tools,
          history,
          readSet,
        },
      );
      lastVector = unionDependencyVectors(lastVector, vector);
      await helpers.checkpoint();
      if (result.outcome === 'failed' || result.outcome === 'aborted')
        return { type: 'failed', reason: `model call ${result.outcome}` };
      if (result.toolCalls.length === 0) {
        const summary = (result.content ?? '').trim() || '(no summary)';
        deps.log(`done ${context.role}: ${summary.slice(0, 160)}`);
        return {
          type: 'output',
          output: {
            kind: context.role === 'verifier' ? 'verification' : 'finding',
            content: { summary: summary.slice(0, 8000) },
            dependencyVector: unionDependencyVectors(lastVector, readSet),
          },
        };
      }
      history.push({
        role: 'assistant',
        content: result.content ?? '',
        toolCalls: result.toolCalls.map((call) => ({
          id: call.toolCallId,
          name: call.name,
          arguments: call.arguments,
        })),
        dependencyVector: [],
      });
      for (const call of result.toolCalls) {
        const started = Date.now();
        let output: unknown;
        let entries: DependencyVector = [];
        try {
          const tool = call.name as TeamToolName;
          if (!tools.includes(tool))
            throw new Error(`tool ${call.name} is not available to you`);
          const raw = JSON.parse(call.arguments || '{}');
          // Children run independently in the demo: dependsOn is not used.
          if (tool === 'delegate_task' && raw && typeof raw === 'object')
            raw.dependsOn = [];
          const args = TEAM_TOOL_INPUTS[tool].parse(raw);
          const ran = await runTool(tool, args, {
            claimed,
            modelCallId,
            toolCallId: call.toolCallId,
            readSet,
            vector: unionDependencyVectors(lastVector, readSet),
            children,
            checkpoint: helpers.checkpoint,
          });
          output = ran.output;
          entries = ran.entries;
          if (entries.length)
            readSet = unionDependencyVectors(readSet, entries);
        } catch (error) {
          if ((error as Error).name === 'AttemptAbortedError') throw error;
          output = { error: (error as Error).message.slice(0, 800) };
        }
        deps.log(
          `  ${context.role} ${call.name}(${call.arguments.slice(0, 120)}) ${Date.now() - started}ms -> ${JSON.stringify(output).slice(0, 160)}`,
        );
        history.push({
          role: 'tool',
          toolCallId: call.toolCallId,
          toolName: call.name,
          content: JSON.stringify(output).slice(0, 6000),
          dependencyVector: entries,
        });
      }
    }
    return { type: 'failed', reason: 'iteration budget exhausted' };
  };

  async function runTool(
    tool: TeamToolName,
    args: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    ctx: {
      claimed: ClaimedAttempt;
      modelCallId: ModelCallId;
      toolCallId: string;
      readSet: DependencyVector;
      vector: DependencyVector;
      children: TaskId[];
      checkpoint: () => Promise<void>;
    },
  ): Promise<{ output: unknown; entries: DependencyVector }> {
    const context: AttemptContext = ctx.claimed.context;
    switch (tool) {
      case 'observe_source': {
        const key = args.sourceKey as SourceKey;
        if (key === 'checkout.acceptance' || key.startsWith('runbook/'))
          throw new Error('that source is not observable with this tool');
        const scope = deps.scopeFor(context.missionId);
        const read = await deps.readers.read(key, scope);
        const controlled = sourceRef(key).authority === 'controlled';
        const registered = await withTransaction(deps.pool, async (client) => {
          const result = await registerObservation(
            client,
            {
              source: { key, ...sourceRef(key), scope },
              normalizedValue: read.normalizedValue,
              provenance: {
                kind: 'tool_call',
                toolCallId: ctx.toolCallId,
                modelCallId: ctx.modelCallId,
                attemptId: context.attemptId,
              },
            },
            // Demo: observed endpoints are context, not dependencies; only
            // controlled config receipts drive invalidation closures.
            controlled ? {} : { marker: null },
          );
          if (controlled)
            await recordReadSet(client, {
              missionId: context.missionId,
              taskId: context.taskId,
              attemptId: context.attemptId,
              receiptIds: [result.receipt.id],
            });
          await emitReceipt(deps.events, client, context.missionId, result);
          return result;
        });
        const receipt = registered.receipt;
        const entry = {
          sourceKey: key,
          sourceRevision: receipt.sourceRevision,
          receiptId: receipt.id,
        };
        if (controlled) await coordinator.addReadSet(context, [entry]);
        const value = read.normalizedValue as { value?: unknown };
        return {
          output: {
            receiptId: receipt.id,
            sourceKey: key,
            revision: receipt.sourceRevision,
            value: read.normalizedValue,
            ...(key.startsWith('checkout.config/') && value?.value !== undefined
              ? { valueDigest: configValueDigest(value.value as never) }
              : {}),
          },
          entries: controlled ? [entry] : [],
        };
      }
      case 'list_runbooks':
        return {
          output: Object.entries(RUNBOOKS).map(([id, r]) => ({
            id,
            title: r.title,
          })),
          entries: [],
        };
      case 'read_runbook': {
        if (!RUNBOOKS[args.id]) throw new Error('unknown runbook id');
        return { output: { id: args.id, text: runbookText(args.id) }, entries: [] };
      }
      case 'delegate_task': {
        const created = await coordinator.delegate(context, {
          title: args.title,
          role: args.role,
          question: args.question,
          dependsOn: [],
          justification: args.justification,
          dependencyVector: ctx.vector,
          createdByModelCallId: ctx.modelCallId,
          toolCallId: ctx.toolCallId,
        });
        ctx.children.push(created.taskId);
        deps.log(`  delegated ${args.role}: ${args.title}`);
        return {
          output: { taskId: created.taskId, role: args.role, status: 'created' },
          entries: [],
        };
      }
      case 'get_task_status': {
        const status = await coordinator.getTaskStatus(
          context.missionId,
          args.taskId,
        );
        return {
          output: { taskId: args.taskId, status: status.task.status },
          entries: [],
        };
      }
      case 'wait_for_children': {
        if (ctx.children.length === 0)
          return { output: { children: [] }, entries: [] };
        const deadline = Date.now() + 8 * 60_000;
        for (;;) {
          await ctx.checkpoint();
          const { rows } = await deps.pool.query<{
            id: string;
            title: string;
            role: string;
            status: string;
            content: unknown;
            usable: boolean | null;
          }>(
            `SELECT t.id, t.title, t.role, t.status, o.content, o.usable
               FROM coordinator.tasks t LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
              WHERE t.id = ANY($1::uuid[])`,
            [ctx.children],
          );
          if (
            rows.every((row) => TERMINAL.has(row.status)) ||
            Date.now() > deadline
          )
            return {
              output: {
                children: rows.map((row) => ({
                  taskId: row.id,
                  title: row.title,
                  role: row.role,
                  status: row.status,
                  output: row.usable === false ? null : row.content,
                })),
              },
              entries: [],
            };
          await sleep(1000);
        }
      }
      case 'publish_finding': {
        const published = await coordinator.publishFinding(context, {
          claim: args.claim,
          supportingReceiptIds: args.supportingReceiptIds.filter((id: string) =>
            ctx.vector.some((entry) => entry.receiptId === id),
          ),
          confidence: args.confidence,
          dependencyVector: ctx.vector,
        });
        return { output: { findingId: published.findingId }, entries: [] };
      }
      case 'propose_action': {
        const { admitted, final } = await deps.actions.proposeAndCommit(
          args as ProposeInput,
          {
            ...context,
            modelCallId: ctx.modelCallId,
            toolCallId: ctx.toolCallId,
          },
          ctx.readSet,
        );
        deps.log(
          `  action ${final.id.slice(0, 8)} ${admitted.status} -> ${final.status}${final.blockReason ? ` (${final.blockReason}: ${final.blockDetail})` : ''}`,
        );
        return {
          output: {
            actionId: final.id,
            status: final.status,
            blockReason: final.blockReason,
            blockDetail: final.blockDetail,
          },
          entries: [],
        };
      }
      case 'request_replan': {
        await coordinator.requestReplan(context, args.reason);
        return { output: { requested: true }, entries: [] };
      }
    }
  }
}
