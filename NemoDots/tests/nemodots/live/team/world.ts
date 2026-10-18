// World for the live team suites: a fresh migrated test database on the
// NemoDots PostgreSQL instance with the REAL coordinator, ledger, support
// validator, action service (propose only; the outbox is not started, so
// nothing is admitted or committed) and tools.
//
// LABELLED STUB: the checkout API is not running against the test database, so
// the OBSERVED sources (checkout.health, checkout.metrics) are produced by
// `SimulatedCheckoutReaders`, a deterministic function of the test database's
// configuration rows with the same normalized shape as sandbox/readers.ts.
// Configuration sources (checkout.config, checkout.config/<key>) are read from
// the real authority tables. The model, its tool calls and every ledger and
// coordinator write are real; the checkout symptoms are simulated.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  SourceKey,
  SourceReaderPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createActionService } from '../../../../src/server/nemodots/actions/service.js';
import {
  createIntentReader,
  readActionSnapshot,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  createCoordinator,
  type Coordinator,
  type CoordinatorConfig,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { createSupportValidator } from '../../../../src/server/nemodots/ledger/index.js';
import {
  createAuthorityReader,
  createDefaultActions,
  createLedgerWriter,
  createPgTeamReader,
  createLedgerObserver,
  createTeamTools,
  createTeamHandler,
  type TeamInference,
} from '../../../../src/server/nemodots/team/index.js';
import { recordOrphanedAttempt } from '../../../../src/server/nemodots/ledger/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';

export const SEEDED_CONFIG: [string, string][] = [
  ['cache.namespace', '"ns-main"'],
  ['cache.schema_version', '2'],
  ['db.pool_max', '1'],
  ['db.statement_timeout_ms', '5000'],
  ['routing.inventory_source', '"primary"'],
  ['orders.write_enabled', 'true'],
  ['ui.banner_text', '"Welcome"'],
];

export function simulatedCheckoutReaders(pool: pg.Pool): SourceReaderPort {
  const authority = createAuthorityReader(pool);
  async function poolMax(): Promise<number> {
    const { rows } = await pool.query<{ value: number }>(
      "SELECT value FROM checkout.config_entries WHERE key = 'db.pool_max'",
    );
    return Number(rows[0]?.value ?? 0);
  }
  return {
    async read(key: SourceKey, scope) {
      if (key === 'checkout.health') {
        const starved = (await poolMax()) <= 2;
        const value = {
          status: starved ? 'degraded' : 'ok',
          checks: {
            postgres: true,
            redis: true,
            config_parse: true,
            writes: true,
            cache: true,
            pool: !starved,
          },
          errors: starved ? ['pool_timeout'] : [],
        };
        return { normalizedValue: value, raw: value, revisionHint: null };
      }
      if (key === 'checkout.metrics') {
        const starved = (await poolMax()) <= 2;
        const value = {
          errorClasses: starved ? ['pool_timeout'] : [],
          cacheDecodeError: null,
          cacheHitRatioDecile: 7,
          errorRateDecile: starved ? 4 : 0,
        };
        return { normalizedValue: value, raw: value, revisionHint: null };
      }
      if (key === 'redis.stats') {
        const value = {
          reachable: true,
          activeNamespace: 'ns-main',
          keyCounts: { 'ns-main:v2': 12 },
        };
        return { normalizedValue: value, raw: value, revisionHint: null };
      }
      if (key === 'checkout.orders.recent') {
        const value = { countBucket: '1-10', statuses: ['confirmed'] };
        return { normalizedValue: value, raw: value, revisionHint: null };
      }
      if (key.startsWith('checkout.inventory/')) {
        const value = {
          sku: key.slice('checkout.inventory/'.length),
          authorityQuantity: 40,
          apiQuantity: 40,
          consistent: true,
        };
        return { normalizedValue: value, raw: value, revisionHint: null };
      }
      return authority.read(key, scope);
    },
  };
}

export interface LiveWorld {
  db: TestDatabase;
  admin: pg.Pool;
  app: pg.Pool;
  coordinator: Coordinator;
  inFlight: { current: number; max: number };
  handlerFor(
    inference: TeamInference,
    models: { planner: string; worker: string },
  ): ReturnType<typeof createTeamHandler>;
  tools: ReturnType<typeof createTeamTools>;
  /** A running mission with `goal`; the planner task is left unclaimed unless a host takes it. */
  newMission(goal: string): Promise<string>;
  /** A root-level investigator task under the mission's planner task (depth 1), runnable. */
  seedInvestigator(missionId: string, question: string): Promise<string>;
}

const BUDGETS = {
  maxTasks: 24,
  maxDepth: 3,
  maxBreadth: 4,
  maxTokens: 3_000_000,
  maxInferenceCalls: 200,
  maxWallClockMs: 900_000,
};

export async function withLiveWorld<T>(
  model: string,
  host: string,
  fn: (world: LiveWorld) => Promise<T>,
): Promise<T> {
  return withTestDatabase(async (db) => {
    const admin = new pg.Pool({ connectionString: db.urls.admin, max: 3 });
    const app = createRolePool('app', db.urls.app);
    try {
      for (const [key, value] of SEEDED_CONFIG) {
        await admin.query(
          `INSERT INTO checkout.config_entries (key, value, version, caused_by_actor)
           VALUES ($1, $2::jsonb, 1, 'seed') ON CONFLICT (key) DO NOTHING`,
          [key, value],
        );
        await admin.query(
          `INSERT INTO checkout.config_versions (key, version, value, caused_by_actor)
           VALUES ($1, 1, $2::jsonb, 'seed') ON CONFLICT (key, version) DO NOTHING`,
          [key, value],
        );
      }
      const config: CoordinatorConfig = {
        ownerId: 'owner-live-team',
        spaceId: null,
        environment: 'test',
        resource: 'checkout',
        mode: 'live',
        provider: { host, plannerModel: model, workerModel: model },
        budgets: BUDGETS,
        leaseMs: 90_000,
        taskDefaults: { maxAttempts: 2, maxIterations: 12, maxTokens: 400_000 },
        replanCap: 3,
      };
      const actions = createActionService({ pool: app });
      const coordinator = createCoordinator(
        {
          pool: app,
          config,
          supportValidator: createSupportValidator(),
          ledger: createLedgerWriter(),
          recordOrphanedAttempt: async ({ record }) => {
            await recordOrphanedAttempt(app, {
              modelCallId: record.id,
              scope: record.scope,
              taskId: record.taskId,
              attemptId: record.attemptId,
              role: record.role,
              model: record.model,
              provider: record.provider,
              attempts: record.attempts,
            });
          },
          intents: createIntentReader(),
          actions: actions.coordinatorPort('live-team'),
          snapshotReader: {
            async read(client, missionId) {
              return {
                receipts: [],
                confirmations: [],
                ...(await readActionSnapshot(client, missionId)),
                probe: null,
                telemetry: {
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
                },
              };
            },
          },
          probe: null,
          providerHealthy: async () => true,
        },
        { workerId: 'live-team' },
      );
      const reader = createPgTeamReader(app);
      const observer = createLedgerObserver({
        pool: app,
        readers: simulatedCheckoutReaders(app),
        reader,
        events: createEventSink(),
      });
      const tools = createTeamTools({
        coordinator,
        reader,
        observer,
        actions: createDefaultActions(app),
        wait: { timeoutMs: 240_000, pollMs: 500 },
      });
      const inFlight = { current: 0, max: 0 };
      const world: LiveWorld = {
        db,
        admin,
        app,
        coordinator,
        inFlight,
        tools,
        handlerFor(inference, models) {
          const counted: TeamInference = {
            mode: inference.mode,
            host: () => inference.host(),
            listModels: () => inference.listModels(),
            async complete(req, ctx) {
              inFlight.current += 1;
              inFlight.max = Math.max(inFlight.max, inFlight.current);
              try {
                return await inference.complete(req, ctx);
              } finally {
                inFlight.current -= 1;
              }
            },
          };
          return createTeamHandler({
            inference: counted,
            coordinator,
            reader,
            observer,
            tools,
            models,
          });
        },
        async newMission(goal) {
          const mission = await coordinator.control.create({ goal });
          await coordinator.control.start(mission.id);
          return mission.id;
        },
        async seedInvestigator(missionId, question) {
          const planner = await admin.query<{ id: string }>(
            `SELECT id FROM coordinator.tasks WHERE mission_id = $1 AND role = 'planner'`,
            [missionId],
          );
          const id = randomUUID();
          await admin.query(
            `INSERT INTO coordinator.tasks (id, mission_id, parent_id, depth, ordinal, title, question, role, capabilities, status, generation,
                                            prerequisites, fence_seq, attempt_count, budget, justification)
             VALUES ($1, $2, $3, 1, 100, 'Investigate checkout', $4, 'investigator',
                     ARRAY['observe','delegate','publish_finding','request_replan'], 'runnable', 0, '{}', 0, 0,
                     '{"maxIterations":12,"maxTokens":400000,"maxChildren":4}'::jsonb, 'seeded by the live suite')`,
            [id, missionId, planner.rows[0].id, question],
          );
          return id;
        },
      };
      return await fn(world);
    } finally {
      await admin.end().catch(() => undefined);
      await app.end().catch(() => undefined);
    }
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

export const randomName = () => randomBytes(4).toString('hex');
