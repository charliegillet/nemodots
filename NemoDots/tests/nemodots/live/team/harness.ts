// Live-suite fixture for the Nemotron team. Real: PostgreSQL (migrated test
// database), Redis, the checkout app (in-process), the injector, the ledger
// (observations and readset edges), the coordinator (leases, delegation,
// publication) and the Crusoe inference adapter. Stubbed and labelled: the
// SupportValidator (always current), the ledger's model-call writer (kept in
// memory so the suite can assert on every record), the action boundary
// (proposals are recorded, not admitted), the acceptance probe.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  createCoordinator,
  type Coordinator,
  type CoordinatorConfig,
  type ForeignSnapshotReader,
  type IntentReader,
} from '../../../../src/server/nemodots/coordinator/index.js';
import {
  sourceKeyFamily,
  type AttemptContext,
  type ChatRequest,
  type ModelCallRecord,
  type ObservationReceipt,
  type Scope,
  type SourceKey,
  type SourceRef,
  type TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  recordReadSet,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import type {
  ChildOutput,
  MissionTaskView,
  SourceObserver,
  TeamReads,
} from '../../../../src/server/nemodots/team/index.js';
import { DEFAULT_CONFIG } from '../../integration/coordinator/harness.js';
import {
  withSandbox,
  type Sandbox,
} from '../../integration/sandbox/harness.js';
import type { StampedChatResult } from '../../../../src/server/nemodots/inference/types.js';

const emptyTelemetry = {
  calls: 0,
  orphanedCalls: 0,
  tokens: {
    prompt: 0,
    completion: 0,
    cached: { available: false, total: null },
  },
  byModel: [],
  byRole: [],
  retries: 0,
  errors: 0,
  ttftMs: null,
  prefixGroups: [],
};
const snapshotReader: ForeignSnapshotReader = {
  async read() {
    return {
      receipts: [],
      confirmations: [],
      actions: [],
      authorizations: [],
      results: [],
      probe: null,
      telemetry: emptyTelemetry,
    };
  },
};
const noIntents: IntentReader = {
  async find() {
    return null;
  },
  async statuses() {
    return [];
  },
  async committedEffects() {
    return [];
  },
};

export interface LiveRig {
  sandbox: Sandbox;
  coordinator: Coordinator;
  /** Every ModelCallRecord the coordinator accepted (stub ledger writer). */
  modelCalls: ModelCallRecord[];
  observer: SourceObserver;
  reads: TeamReads;
  scope(missionId: string): Scope;
  proposals: { input: unknown; modelCallId: string; toolCallId: string }[];
}

export async function withLiveRig<T>(
  fn: (rig: LiveRig) => Promise<T>,
): Promise<T> {
  return withSandbox(async (sandbox) => {
    const modelCalls: ModelCallRecord[] = [];
    const config: CoordinatorConfig = {
      ...DEFAULT_CONFIG,
      mode: 'live',
      provider: {
        host: new URL(process.env.OPENAI_BASE_URL!).host,
        plannerModel: process.env.OPENAI_MODEL!,
        workerModel: process.env.OPENAI_MODEL!,
      },
    };
    const coordinator = createCoordinator({
      pool: sandbox.pools.app,
      config,
      supportValidator: {
        async assertCurrent() {
          return [];
        },
      },
      ledger: {
        async recordModelCall(_client, input) {
          modelCalls.push(input.record);
        },
        async recordArtifact() {},
      },
      async recordOrphanedAttempt() {},
      intents: noIntents,
      actions: {
        async admit() {
          return {} as never;
        },
        async cancelQueued() {
          return [];
        },
      },
      snapshotReader,
      probe: null,
      providerHealthy: async () => true,
    });
    const readers = createSourceReaders({
      pg: sandbox.pools.app,
      redis: sandbox.redis.client,
      redisPrefix: sandbox.redis.prefix,
      checkoutUrl: 'http://checkout.invalid',
      fetch: sandbox.fetch,
      now: sandbox.clock.now,
    });
    const scope = (missionId: string): Scope => ({
      ownerId: config.ownerId,
      missionId: missionId as never,
      spaceId: null,
      environment: 'test',
      resource: config.resource,
    });

    const observer: SourceObserver = {
      async observe(context: AttemptContext, input) {
        const key = input.sourceKey as SourceKey;
        const read = await readers.read(key, scope(context.missionId));
        const family = sourceKeyFamily(key);
        const sourceType: SourceRef['sourceType'] =
          family === 'checkout.config'
            ? 'controlled_collection'
            : family === 'checkout.config/<key>'
              ? 'controlled_config'
              : family === 'checkout.health' ||
                  family === 'checkout.metrics' ||
                  family === 'redis.stats'
                ? 'observed_endpoint'
                : 'observed_store';
        const ref = {
          key,
          sourceType,
          authority: sourceType.startsWith('controlled')
            ? 'controlled'
            : 'observed',
          scope: scope(context.missionId),
        } as SourceRef;
        const client = await sandbox.pools.app.connect();
        try {
          await client.query('BEGIN');
          const registered = await registerObservation(
            client,
            {
              source: ref,
              normalizedValue: read.normalizedValue,
              provenance: {
                kind: 'tool_call',
                toolCallId: input.toolCallId,
                attemptId: context.attemptId,
              },
            } as never,
            { ledger: { events: coordinator.events.sink } },
          );
          await recordReadSet(client, {
            missionId: context.missionId,
            taskId: context.taskId,
            attemptId: context.attemptId,
            receiptIds: [registered.receipt.id],
          });
          await client.query('COMMIT');
          return registered.receipt as ObservationReceipt;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    };

    const q = (text: string, values: unknown[]) =>
      sandbox.pools.app.query(text, values);
    const reads: TeamReads = {
      scope: (context) => scope(context.missionId),
      async outputsOf(context, taskIds): Promise<ChildOutput[]> {
        if (taskIds.length === 0) return [];
        const { rows } = await q(
          `SELECT t.id, t.role, t.status, o.id AS output_id, o.usable, o.content, o.digest,
                  o.dependency_vector
             FROM coordinator.tasks t LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
            WHERE t.mission_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.ordinal`,
          [context.missionId, [...taskIds]],
        );
        return rows.map((row) => ({
          taskId: row.id as TaskId,
          role: row.role,
          status: row.status,
          usable: row.output_id !== null && row.usable === true,
          text: String(
            (row.content as { summary?: string } | null)?.summary ?? '',
          ).slice(0, 3000),
          digest: row.digest ?? null,
          dependencyVector: row.dependency_vector ?? [],
        }));
      },
      async prerequisiteOutputs(context) {
        const { rows } = await q(
          `SELECT o.id, o.kind, o.usable, o.content, o.digest, o.dependency_vector
             FROM coordinator.tasks t
             JOIN coordinator.tasks p ON p.id = ANY (t.prerequisites)
             JOIN coordinator.task_outputs o ON o.id = p.output_id
            WHERE t.id = $1 AND o.kind <> 'plan'`,
          [context.taskId],
        );
        return rows.map((row) => ({
          kind: 'task_output' as const,
          id: row.id,
          digest: row.digest,
          text: String((row.content as { summary?: string })?.summary ?? ''),
          usable: row.usable === true,
          dependencyVector: row.dependency_vector ?? [],
        }));
      },
      async invalidationSummaries() {
        return [];
      },
      async missionTasks(context): Promise<MissionTaskView[]> {
        const { rows } = await q(
          `SELECT id, title, role, status, parent_id FROM coordinator.tasks
            WHERE mission_id = $1 ORDER BY ordinal`,
          [context.missionId],
        );
        return rows.map((row) => ({
          id: row.id,
          title: row.title,
          role: row.role,
          status: row.status,
          parentId: row.parent_id,
        }));
      },
    };
    const proposals: LiveRig['proposals'] = [];
    return fn({
      sandbox,
      coordinator,
      modelCalls,
      observer,
      reads,
      scope,
      proposals,
    });
  });
}

/** Wraps the live adapter to count requests in flight and keep provider stamps. */
export function instrument<
  A extends {
    complete(
      req: ChatRequest,
      ctx: Parameters<
        import('../../../../src/server/nemodots/contracts/index.js').InferencePort['complete']
      >[1],
    ): Promise<StampedChatResult>;
  },
>(adapter: A) {
  const stats = {
    inFlight: 0,
    maxInFlight: 0,
    requests: 0,
    outcomes: [] as string[],
    hosts: new Set<string>(),
    models: new Set<string>(),
  };
  const wrapped = Object.create(adapter) as A;
  wrapped.complete = async (req, ctx) => {
    stats.inFlight += 1;
    stats.requests += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      const result = await adapter.complete(req, ctx);
      stats.outcomes.push(result.outcome);
      stats.hosts.add(result.provider.host);
      if (result.modelReturned) stats.models.add(result.modelReturned);
      return result;
    } finally {
      stats.inFlight -= 1;
    }
  };
  return { adapter: wrapped, stats };
}

export type { pg };
export const newId = () => randomUUID();
