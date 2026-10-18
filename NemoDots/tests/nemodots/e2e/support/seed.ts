// Drives a fixture mission through the REAL coordinator, ledger and action
// boundary, standing in only for the model. The built server owns the same
// PostgreSQL stack: it creates the mission, runs the outbox, the watcher, the
// action admission loop and the acceptance probe. This module plays the part
// the worker host plays in production (claim, start, observe, propose,
// publish) with authored text instead of Nemotron output, so everything the
// browser then shows is stored by production code and labelled FIXTURE.
//
// Authored here, and therefore fixture content: the plan, findings, handoff
// text, the rationale of the proposed action, and the model-call records. Token
// usage is left null (unknown) so no number is invented.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  digest,
  sha256Hex,
  sourceKeyFamily,
  type AttemptContext,
  type ContextSnapshot,
  type DependencyVector,
  type Mission,
  type ModelCallRecord,
  type ObservationReceipt,
  type Scope,
  type SourceKey,
  type SourceRef,
  type TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createActions } from '../../../../src/server/nemodots/actions/index.js';
import { createNemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  createSupportValidator,
  type RegistrationLedgerOptions,
  recordReadSet,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';

export interface ServerRef {
  url: string;
  ownerId: string;
  ownerToken?: string;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function sourceTypeOf(key: SourceKey): SourceRef['sourceType'] {
  switch (sourceKeyFamily(key)) {
    case 'checkout.config':
      return 'controlled_collection';
    case 'checkout.config/<key>':
      return 'controlled_config';
    case 'checkout.health':
    case 'checkout.metrics':
    case 'redis.stats':
      return 'observed_endpoint';
    default:
      return 'observed_store';
  }
}

export interface PlanTask {
  title: string;
  question: string;
  role: TaskRole;
  capabilities: string[];
  dependsOn: number[];
}

export interface Seeder {
  /** Restores the healthy configuration (repeatable). */
  restoreHealthy(): Promise<void>;
  /** POST /api/nemodots/missions through the built server, then start. */
  createMission(
    server: ServerRef,
    body: {
      goal: string;
      constraints?: string[];
      admission?: { minAgeMs: number };
    },
    start?: boolean,
  ): Promise<Mission>;
  /** Claims and runs the planner attempt; returns the task ids in plan order. */
  publishPlan(mission: Mission, tasks: PlanTask[]): Promise<string[]>;
  /** Runs one task the way a worker would; `script` plays the model's part. */
  runTask(
    mission: Mission,
    taskId: string,
    script: (step: TaskStep) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface TaskStep {
  context: AttemptContext;
  /** observe_source: read the live source and register a receipt on the readset. */
  observe(key: string): Promise<ObservationReceipt>;
  /** Records the model call that read `receipts` and emitted tool call `toolCallId`. */
  modelCall(
    receipts: readonly ObservationReceipt[],
    toolCallId?: string,
  ): Promise<{
    modelCallId: string;
    toolCallId: string;
    vector: DependencyVector;
  }>;
  propose(input: {
    action: 'set_config' | 'flush_cache_namespace';
    payload: Record<string, unknown>;
    supportingReceiptIds: string[];
    rationale: string;
    call: { modelCallId: string; toolCallId: string };
  }): Promise<{ id: string }>;
  finding(input: {
    claim: string;
    supportingReceiptIds: string[];
    confidence: 'low' | 'medium' | 'high';
    vector: DependencyVector;
  }): Promise<void>;
  /** Publishes the task's output; this completes the attempt. */
  finish(
    content: Record<string, unknown>,
    vector: DependencyVector,
  ): Promise<void>;
  liveConfig(key: string): Promise<{ value: unknown; version: number }>;
}

export async function openSeeder(options: {
  ownerId: string;
  fixturePath: string;
}): Promise<Seeder> {
  const url = process.env.NEMODOTS_PG_URL_APP;
  const adminUrl = process.env.NEMODOTS_PG_URL_ADMIN;
  if (!url || !adminUrl)
    throw new Error(
      'BLOCKED: the role URLs are missing; run through npm run test:nemodots:e2e',
    );
  const app: pg.Pool = createRolePool('app', url, { max: 4 });
  const admin: pg.Pool = createRolePool('admin', adminUrl, { max: 2 });
  const events = createEventSink();
  const ledger: RegistrationLedgerOptions = { events };
  const nemodots = createNemoDots(
    {
      ...(process.env as Record<string, string | undefined>),
      NEMODOTS_INFERENCE_MODE: 'fixture',
      NEMODOTS_FIXTURE_PATH: options.fixturePath,
      OPENAI_MODEL: 'fixture-model',
      NEMODOTS_WORKERS: '0',
    },
    { workspace: { ownerId: options.ownerId }, autoWorkers: false },
  );
  const coordinator = nemodots.coordinator;
  if (!coordinator) throw new Error('the coordinator is not configured');
  const redisPrefix = process.env.NEMODOTS_REDIS_PREFIX ?? 'nemodots:ci-e2e';
  const actions = createActions({
    pool: app,
    validator: createSupportValidator(ledger),
    events,
    redis: null,
    redisPrefix,
    dispatchLeaseMs: 30_000,
  });
  const readers = createSourceReaders({
    pg: app,
    redis: null as never,
    redisPrefix,
    checkoutUrl: process.env.NEMODOTS_CHECKOUT_URL ?? '',
  });
  const scopeOf = (mission: Mission): Scope => mission.scope as Scope;

  async function workerClaim(
    mission: Mission,
    options: { taskId?: string },
  ): Promise<AttemptContext> {
    const claimed = await coordinator!.claimAttempt({
      workerId: 'e2e-seed-worker',
      missionId: mission.id,
      ...(options.taskId ? { taskId: options.taskId as never } : {}),
    });
    if (!claimed) throw new Error('no attempt was claimable');
    await coordinator!.startAttempt(claimed.context);
    return claimed.context;
  }

  function stepFor(mission: Mission, context: AttemptContext): TaskStep {
    const scope = scopeOf(mission);
    const readVector: DependencyVector = [];
    return {
      context,
      async observe(key) {
        const sourceKey = key as SourceKey;
        const read = await readers.read(sourceKey, scope);
        const sourceType = sourceTypeOf(sourceKey);
        const receipt = await withTransaction(app, async (client) => {
          const registered = await registerObservation(
            client,
            {
              source: {
                key: sourceKey,
                sourceType,
                authority: sourceType.startsWith('controlled')
                  ? 'controlled'
                  : 'observed',
                scope,
              } as SourceRef,
              normalizedValue: read.normalizedValue,
              provenance: {
                kind: 'tool_call',
                toolCallId: `call_${randomUUID().slice(0, 8)}`,
                attemptId: context.attemptId,
              } as never,
            },
            { ledger },
          );
          await recordReadSet(client, {
            missionId: context.missionId,
            taskId: context.taskId,
            attemptId: context.attemptId,
            receiptIds: [registered.receipt.id],
          });
          return registered.receipt as ObservationReceipt;
        });
        readVector.push({
          sourceKey: receipt.source.key,
          sourceRevision: receipt.sourceRevision,
          receiptId: receipt.id,
        } as never);
        await coordinator!.addReadSet(context, [
          {
            sourceKey: receipt.source.key,
            sourceRevision: receipt.sourceRevision,
            receiptId: receipt.id,
          },
        ] as never);
        return receipt;
      },
      async modelCall(
        receipts,
        toolCallId = `call_${randomUUID().slice(0, 8)}`,
      ) {
        const sorted = [...receipts].sort((a, b) =>
          a.source.key < b.source.key
            ? -1
            : a.source.key > b.source.key
              ? 1
              : 0,
        );
        const vector = sorted.map((r) => ({
          sourceKey: r.source.key,
          sourceRevision: r.sourceRevision,
          receiptId: r.id,
        })) as DependencyVector;
        const snapshot = {
          id: randomUUID(),
          contextSchemaVersion: 'v1',
          layout: 'cache_aware',
          prefixDigest: sha256Hex('e2e-prefix'),
          prefixLength: 0,
          contextDigest: sha256Hex(`e2e-context-${randomUUID()}`),
          contextLength: 0,
          toolSchemaHash: sha256Hex('e2e-tools'),
          injected: {
            receipts: sorted.map((r) => ({
              id: r.id,
              sourceKey: r.source.key,
              sourceRevision: r.sourceRevision,
              contentDigest: r.contentDigest,
            })),
            inheritedArtifacts: [],
            runbooks: [],
            pageSnapshots: [],
            memories: [],
            invalidationEvents: [],
            historyItems: [],
          },
          dependencyVector: vector,
          volatile: { nowIso: iso() },
        } as unknown as ContextSnapshot;
        const modelCallId = randomUUID();
        const record = {
          id: modelCallId,
          scope,
          taskId: context.taskId,
          attemptId: context.attemptId,
          role: 'worker',
          model: { requested: 'fixture-model', returned: null },
          provider: { host: mission.provider.host, mode: 'fixture' },
          contextSnapshotId: snapshot.id,
          attempts: [
            {
              n: 1,
              startedAt: iso(-1000),
              headersAt: null,
              firstContentAt: null,
              finishedAt: iso(),
              httpStatus: null,
              usage: {
                promptTokens: null,
                completionTokens: null,
                cachedTokens: null,
                reasoningTokens: null,
              },
              finishReason: 'tool_calls',
              error: null,
              retryAfterMs: null,
              streamed: false,
              outcome: 'recorded',
            },
          ],
          outcome: 'tool_calls',
          outputDigest: sha256Hex('e2e-output'),
          outputDependencyVector: vector,
          toolCalls: [
            {
              toolCallId,
              name: 'propose_action',
              argumentsDigest: sha256Hex('{}'),
            },
          ],
          createdAt: iso(),
        } as unknown as ModelCallRecord;
        await coordinator!.recordModelCall(context, { record, snapshot });
        return { modelCallId, toolCallId, vector };
      },
      async propose(input) {
        const intent = await actions.propose(
          {
            action: input.action,
            payload: input.payload,
            supportingReceiptIds: input.supportingReceiptIds,
            rationale: input.rationale,
          } as never,
          { ...context, ...input.call } as never,
        );
        return { id: intent.id };
      },
      async finding(input) {
        await coordinator!.publishFinding(context, {
          claim: input.claim,
          supportingReceiptIds: input.supportingReceiptIds as never,
          confidence: input.confidence,
          dependencyVector: input.vector,
        });
      },
      async finish(content, vector) {
        await coordinator!.publishOutput(context, {
          kind: 'handoff',
          content,
          dependencyVector: vector,
        });
      },
      async liveConfig(key) {
        const { rows } = await app.query<{ value: unknown; version: string }>(
          'SELECT value, version FROM checkout.config_entries WHERE key = $1',
          [key],
        );
        if (!rows[0]) throw new Error(`no config row ${key}`);
        return { value: rows[0].value, version: Number(rows[0].version) };
      },
    };
  }

  return {
    async restoreHealthy() {
      await seedCheckout(admin, { restoreConfig: true });
    },
    async createMission(server, body, start = true) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(server.ownerToken
          ? { authorization: `Bearer ${server.ownerToken}` }
          : {}),
      };
      const created = await fetch(`${server.url}/api/nemodots/missions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (created.status !== 201)
        throw new Error(`mission create answered ${created.status}`);
      let mission = (await created.json()) as Mission;
      if (start) {
        const started = await fetch(
          `${server.url}/api/nemodots/missions/${mission.id}/start`,
          { method: 'POST', headers, body: '{}' },
        );
        if (!started.ok)
          throw new Error(`mission start answered ${started.status}`);
        mission = (await started.json()) as Mission;
      }
      return mission;
    },
    async publishPlan(mission, tasks) {
      const context = await workerClaim(mission, {});
      const published = await coordinator.publishPlan(context, {
        plan: { tasks },
        createdByModelCallId: null,
      });
      return published.taskIds as string[];
    },
    async runTask(mission, taskId, script) {
      const context = await workerClaim(mission, { taskId });
      await script(stepFor(mission, context));
    },
    async close() {
      await nemodots.stop().catch(() => undefined);
      await Promise.all([app.end(), admin.end()]);
    },
  };
}

export { digest };
