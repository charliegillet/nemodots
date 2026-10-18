// Shared fixture for the coordinator integration suites: a fresh migrated test
// database, an `app`-role pool and a real coordinator wired to labelled port
// doubles. The doubles replace packages owned by other waves (ledger,
// actions, probe); they are NOT fixtures for coordinator behaviour: every
// coordinator transition below runs against real PostgreSQL.
//
//   StubValidator  SupportValidator that records calls (ids, lockMode) and can
//                  throw a SupportError or park inside the publication
//                  transaction on a latch (the transaction holds FOR SHARE on
//                  the mission row while parked).
//   StubLedger     LedgerWriterPort writing rows into public.coord_test_ledger
//                  inside the publication transaction, so a rolled-back
//                  publication leaves no row.
//   orphans        recordOrphanedAttempt writing public.coord_test_orphans
//                  through a separate connection (an unfenced autonomous write).
//   FakeIntents    in-memory IntentReader / ActionAdmissionPort.admit.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createCoordinator,
  SupportError,
  type Coordinator,
  type CoordinatorConfig,
  type CoordinatorOptions,
  type ForeignSnapshotReader,
  type IntentReader,
  type IntentRecord,
  type LedgerWriterPort,
  type OrphanedAttemptInfo,
} from '../../../../src/server/nemodots/coordinator/index.js';
import {
  InvalidationEventSchema,
  LIVE_STATUSES,
  invalidationEventId,
} from '../../../../src/server/nemodots/contracts/index.js';
import type {
  ActionId,
  ActionStatus,
  AttemptContext,
  InvalidationEvent,
  InvalidationReason,
  CreateMissionRequest,
  DependencyVector,
  MissionId,
  ObservationReceipt,
  PgClient,
  ProbePort,
  ReceiptId,
  SourceKey,
  SupportValidator,
  TaskId,
  TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

export class StubValidator implements SupportValidator {
  calls: { ids: string[]; lockMode: 'share' | 'update' }[] = [];
  /** When set, assertCurrent throws it (after recording the call). */
  failWith: Error | null = null;
  /** Awaited inside assertCurrent: the publication transaction is parked here. */
  hold: (() => Promise<void>) | null = null;
  async assertCurrent(
    _client: PgClient,
    receiptIds: ReceiptId[],
    opts: { lockMode: 'share' | 'update' },
  ) {
    this.calls.push({ ids: [...receiptIds], lockMode: opts.lockMode });
    if (this.hold) await this.hold();
    if (this.failWith) throw this.failWith;
    return [];
  }
}

export class StubLedger implements LedgerWriterPort {
  constructor(private readonly pool: pg.Pool) {}
  async recordModelCall(
    client: PgClient,
    input: Parameters<LedgerWriterPort['recordModelCall']>[1],
  ) {
    await client.query(
      `INSERT INTO public.coord_test_ledger (kind, id, mission_id, body)
       VALUES ('model_call', $1, $2, $3::jsonb)`,
      [input.record.id, input.context.missionId, JSON.stringify(input.record)],
    );
  }
  async recordArtifact(
    client: PgClient,
    artifact: Parameters<LedgerWriterPort['recordArtifact']>[1],
  ) {
    await client.query(
      `INSERT INTO public.coord_test_ledger (kind, id, mission_id, body)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        `artifact:${artifact.kind}`,
        artifact.id,
        artifact.missionId,
        JSON.stringify(artifact),
      ],
    );
  }
  async rows(kind?: string) {
    const { rows } = await this.pool.query<{
      kind: string;
      id: string;
      body: unknown;
    }>(
      `SELECT kind, id, body FROM public.coord_test_ledger
        ${kind ? 'WHERE kind = $1' : ''} ORDER BY seq`,
      kind ? [kind] : [],
    );
    return rows;
  }
}

export class FakeIntents implements IntentReader {
  intents = new Map<string, IntentRecord>();
  committed = new Map<string, ActionId[]>();
  add(intent: IntentRecord) {
    this.intents.set(intent.id, intent);
  }
  setStatus(id: string, status: ActionStatus) {
    const intent = this.intents.get(id);
    if (intent) intent.status = status;
  }
  async find(_client: PgClient, actionId: ActionId) {
    return this.intents.get(actionId) ?? null;
  }
  async statuses(_client: PgClient, ids: readonly string[]) {
    return ids.flatMap((id) => {
      const intent = this.intents.get(id);
      return intent ? [{ id, status: intent.status }] : [];
    });
  }
  async committedEffects(_client: PgClient, missionId: MissionId) {
    return this.committed.get(missionId) ?? [];
  }
  async liveIntents(_client: PgClient, missionId: MissionId) {
    return [...this.intents.values()]
      .filter(
        (intent) =>
          intent.missionId === missionId &&
          (LIVE_STATUSES as readonly string[]).includes(intent.status),
      )
      .map((intent) => intent.id as ActionId);
  }
}

export interface AdmitCall {
  actionId: string;
  dispatcher: string;
  at: number;
}

export const emptyTelemetry = {
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

export interface Harness {
  db: TestDatabase;
  /** nemodots_app pool (what the server uses). */
  pool: pg.Pool;
  /** nemodots_admin pool (test setup and out-of-band writers such as the ledger closure). */
  admin: pg.Pool;
  coordinator: Coordinator;
  validator: StubValidator;
  ledger: StubLedger;
  intents: FakeIntents;
  orphans: OrphanedAttemptInfo[];
  admits: AdmitCall[];
  cancelQueued: {
    ids: ActionId[];
    calls: { missionId: string; generation: number }[];
  };
  health: { healthy: boolean };
  probe: { receipt: ObservationReceipt | null };
  config: CoordinatorConfig;
}

export interface HarnessOptions {
  config?: Partial<CoordinatorConfig>;
  coordinator?: CoordinatorOptions;
  maxPoolConnections?: number;
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  ownerId: 'owner',
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
  mode: 'fixture',
  provider: {
    host: 'fixture.invalid',
    plannerModel: 'fixture-planner',
    workerModel: 'fixture-worker',
  },
  budgets: {
    maxTasks: 24,
    maxDepth: 3,
    maxBreadth: 4,
    maxTokens: 200_000,
    maxInferenceCalls: 200,
    maxWallClockMs: 600_000,
  },
  leaseMs: 30_000,
  taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 20_000 },
  replanCap: 3,
};

export async function withHarness<T>(
  fn: (harness: Harness) => Promise<T>,
  options: HarnessOptions = {},
): Promise<T> {
  return withTestDatabase(async (db) => {
    const admin = createRolePool('admin', db.urls.admin);
    await admin.query(`
      CREATE TABLE public.coord_test_ledger (
        seq bigserial PRIMARY KEY, kind text NOT NULL, id text NOT NULL,
        mission_id uuid, body jsonb NOT NULL);
      CREATE TABLE public.coord_test_orphans (
        seq bigserial PRIMARY KEY, attempt_id uuid NOT NULL, model_call_id uuid NOT NULL,
        reason text NOT NULL, outcomes text[] NOT NULL);
      GRANT SELECT, INSERT ON public.coord_test_ledger, public.coord_test_orphans TO nemodots_app;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO nemodots_app;`);
    const pool = createRolePool('app', db.urls.app, {
      max: options.maxPoolConnections ?? 8,
    });
    const validator = new StubValidator();
    const ledger = new StubLedger(pool);
    const intents = new FakeIntents();
    const orphans: OrphanedAttemptInfo[] = [];
    const admits: AdmitCall[] = [];
    const cancelQueued: Harness['cancelQueued'] = { ids: [], calls: [] };
    const health = { healthy: true };
    const probeState: Harness['probe'] = { receipt: null };
    const config: CoordinatorConfig = { ...DEFAULT_CONFIG, ...options.config };
    const probe: ProbePort = {
      async run() {
        if (!probeState.receipt) throw new Error('no probe receipt configured');
        return probeState.receipt;
      },
    };
    const coordinator = createCoordinator(
      {
        pool,
        config,
        supportValidator: validator,
        ledger,
        async recordOrphanedAttempt(info) {
          orphans.push(info);
          await pool.query(
            `INSERT INTO public.coord_test_orphans (attempt_id, model_call_id, reason, outcomes)
             VALUES ($1, $2, $3, $4::text[])`,
            [
              info.context.attemptId,
              info.record.id,
              info.fenceReason,
              info.record.attempts.map((attempt) => attempt.outcome),
            ],
          );
        },
        intents,
        actions: {
          async admit(actionId, dispatcher) {
            admits.push({ actionId, dispatcher, at: Date.now() });
            return {} as never;
          },
          async cancelQueued(missionId, generation) {
            cancelQueued.calls.push({ missionId, generation });
            return cancelQueued.ids;
          },
        },
        snapshotReader,
        probe,
        providerHealthy: async () => health.healthy,
      },
      options.coordinator,
    );
    try {
      return await fn({
        db,
        pool,
        admin,
        coordinator,
        validator,
        ledger,
        intents,
        orphans,
        admits,
        cancelQueued,
        health,
        probe: probeState,
        config,
      });
    } finally {
      await coordinator.outbox.stop();
      await pool.end();
      await admin.end();
    }
  });
}

// ------------------------------------------------------------------ builders

export const receipt = (): ReceiptId => randomUUID() as ReceiptId;

export function vectorOf(
  entries: {
    sourceKey: string;
    sourceRevision: number;
    receiptId?: ReceiptId;
  }[],
): DependencyVector {
  return entries
    .map((entry) => ({
      sourceKey: entry.sourceKey as SourceKey,
      sourceRevision: entry.sourceRevision,
      receiptId: entry.receiptId ?? receipt(),
    }))
    .sort(
      (a, b) =>
        (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0) ||
        a.sourceRevision - b.sourceRevision ||
        (a.receiptId < b.receiptId ? -1 : 1),
    );
}

export async function createRunningMission(
  h: Harness,
  request: Partial<CreateMissionRequest> = {},
) {
  const mission = await h.coordinator.control.create({
    goal: 'restore the checkout',
    ...request,
  });
  return h.coordinator.control.start(mission.id);
}

export interface PlanSpec {
  title?: string;
  role: TaskRole;
  capabilities?: AttemptContext['capabilities'];
  dependsOn?: number[];
}

/**
 * Starts a mission, runs the planner attempt through the real claim / start /
 * publishPlan path, and returns the created root tasks in plan order.
 */
export async function plannedMission(
  h: Harness,
  plan: PlanSpec[],
  request: Partial<CreateMissionRequest> = {},
) {
  const mission = await createRunningMission(h, request);
  const planner = await h.coordinator.claimAttempt({
    workerId: 'planner-worker',
    missionId: mission.id,
  });
  if (!planner) throw new Error('no planner task was claimable');
  await h.coordinator.startAttempt(planner.context);
  const published = await h.coordinator.publishPlan(planner.context, {
    plan: {
      tasks: plan.map((task, i) => ({
        title: task.title ?? `task ${i}`,
        question: `question ${i}`,
        role: task.role,
        capabilities: task.capabilities ?? [],
        dependsOn: task.dependsOn ?? [],
      })),
    },
    createdByModelCallId: randomUUID() as never,
  });
  return {
    missionId: mission.id,
    plannerContext: planner.context,
    taskIds: published.taskIds as TaskId[],
  };
}

export async function claimStart(
  h: Harness,
  options: {
    taskId?: TaskId;
    missionId?: MissionId;
    workerId?: string;
    leaseMs?: number;
  } = {},
) {
  const claimed = await h.coordinator.claimAttempt({
    workerId: options.workerId ?? 'worker-a',
    taskId: options.taskId,
    missionId: options.missionId,
    leaseMs: options.leaseMs,
  });
  if (!claimed) throw new Error('nothing was claimable');
  await h.coordinator.startAttempt(claimed.context);
  return claimed;
}

export async function expireLease(h: Harness, attemptId: string) {
  await h.admin.query(
    `UPDATE coordinator.task_attempts
        SET lease_expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [attemptId],
  );
}

export async function taskRow(h: Harness, taskId: string) {
  const { rows } = await h.admin.query(
    `SELECT * FROM coordinator.tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function attemptRow(h: Harness, attemptId: string) {
  const { rows } = await h.admin.query(
    `SELECT * FROM coordinator.task_attempts WHERE id = $1`,
    [attemptId],
  );
  return rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function count(
  h: Harness,
  table: string,
  where = 'true',
  params: unknown[] = [],
) {
  const { rows } = await h.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0].n);
}

export async function eventKinds(h: Harness, missionId: string) {
  const { rows } = await h.admin.query<{ kind: string }>(
    `SELECT kind FROM coordinator.events WHERE mission_id = $1 ORDER BY id`,
    [missionId],
  );
  return rows.map((row) => row.kind);
}

export async function recoveryKinds(h: Harness, missionId: string) {
  const { rows } = await h.admin.query<{
    kind: string;
    task_id: string | null;
    attempt_id: string | null;
  }>(
    `SELECT kind, task_id, attempt_id FROM coordinator.recovery_events
      WHERE mission_id = $1 ORDER BY created_at, id`,
    [missionId],
  );
  return rows;
}

export function staleVersion(receiptId?: string) {
  return new SupportError(
    'stale_version',
    'recorded revision 3, live 4',
    receiptId,
  );
}

/** A probe receipt shaped like checkout.acceptance (ARCHITECTURE 9.4/9.5). */
export function probeReceipt(
  missionId: MissionId,
  verdict: 'pass' | 'fail',
  overrides: Partial<ObservationReceipt> = {},
): ObservationReceipt {
  return {
    id: randomUUID() as ReceiptId,
    source: {
      key: 'checkout.acceptance' as SourceKey,
      sourceType: 'probe',
      authority: 'observed',
      scope: {
        ownerId: 'owner',
        missionId,
        spaceId: null,
        environment: 'test',
        resource: 'checkout',
      },
    },
    sourceRevision: 1,
    collectionRevision: null,
    observedAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString(),
    contentDigest: 'a'.repeat(64),
    normalizedValue: { verdict, invariants: [] },
    rawRef: null,
    status: 'supported',
    statusVersion: 0,
    supersedes: null,
    supersededBy: null,
    trust: 'probe',
    provenance: {
      kind: 'probe',
      toolCallId: null,
      modelCallId: null,
      attemptId: null,
      causedByActionId: null,
      selfWrite: 'none',
    },
    negative: null,
    expiresAt: null,
    ...overrides,
  } as ObservationReceipt;
}

/**
 * A hand-enumerated InvalidationEvent for one mission: exactly the affected and
 * preserved sets the test names (the ledger's closure computes these in
 * production; recovery trusts them).
 */
export function invalidationFor(input: {
  missionId: MissionId;
  sourceKey?: string;
  oldReceiptId?: ReceiptId;
  attemptIds?: string[];
  taskIds?: string[];
  outputIds?: string[];
  actionIds?: string[];
  preserved?: string[];
  selfWrite?: 'none' | 'verified' | 'mismatch';
  reason?: InvalidationReason;
  capped?: boolean;
}): InvalidationEvent {
  const sourceKey = (input.sourceKey ??
    'checkout.config/cache.namespace') as SourceKey;
  const oldReceiptId = input.oldReceiptId ?? receipt();
  const newReceiptId = receipt();
  const reason = input.reason ?? 'newer_observation';
  const affected = {
    modelCallIds: [],
    attemptIds: input.attemptIds ?? [],
    outputIds: input.outputIds ?? [],
    actionIds: input.actionIds ?? [],
    taskIds: input.taskIds ?? [],
  };
  return InvalidationEventSchema.parse({
    id: invalidationEventId(sourceKey, oldReceiptId, newReceiptId, reason),
    missionIds: [input.missionId],
    sourceKey,
    oldReceiptId,
    newReceiptId,
    reason,
    selfWrite: input.selfWrite ?? 'none',
    graphVersion: 1,
    affected,
    perMission: [
      {
        missionId: input.missionId,
        affected,
        preserved: { taskIds: input.preserved ?? [] },
      },
    ],
    closure: { depth: 1, nodes: 3, capped: input.capped ?? false },
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  });
}
