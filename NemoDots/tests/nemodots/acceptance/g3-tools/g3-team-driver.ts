// Gate 3 driver for the NemoDots team-tool executors (TOOL_COVERAGE section 1).
//
// What is REAL here: the acc3_ PostgreSQL database (migrated with the production migrations), the seeded
// mission / task / attempt / receipt / model-call rows (written with SQL as claimAttempt and the watcher would
// have left them, exactly like tests/nemodots/acceptance/g1-ledger/compose.ts), and every assertion over the
// resulting rows. The seeding is proven by g3-09's self-check, which passes without any production tool code.
//
// What is BOUND LATER: `bindTeamExecutor`. It resolves src/server/nemodots/team/tools.ts and expects the
// convention documented in docs/nemodots/ACCEPTANCE_CONTRACT.md section 10 (gate 3 team executors):
//
//   export function createTeamTools(deps: {
//     pool, appPool, adminUrl, env, clock, ...                       // generous bag; unused keys are ignored
//   }): { execute(name: string, rawArgs: unknown,
//                 options: { context: AttemptContext; toolCallId: string; modelCallId?: string }): Promise<unknown> }
//
// A missing module or export is "ENTRY POINT MISSING"; a module present with another shape is
// "DRIVER WIRING PENDING" naming this convention. Neither is ever a skip.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  APP_ROOT,
  DriverWiringPendingError,
  EntryPointMissingError,
  adminQuery,
  createAcc3Database,
  seedConfigRows,
  type Acc3Database,
} from './g3-support.js';

export const OWNER_ID = 'acc3-owner';
export const TEAM_TOOLS_MODULE = 'src/server/nemodots/team/tools.ts';

export const BUDGETS = {
  maxTasks: 24,
  maxDepth: 3,
  maxBreadth: 4,
  maxTokens: 200_000,
  maxInferenceCalls: 200,
  maxWallClockMs: 600_000,
};

// Hand-written role capability sets (ARCHITECTURE section 11 table).
export const CAPS = {
  investigator: ['observe', 'delegate', 'publish_finding', 'request_replan'],
  cache_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
    'propose_cache_flush',
  ],
  verifier: ['observe', 'publish_finding'],
} as const;

export interface AttemptCtx {
  missionId: string;
  taskId: string;
  attemptId: string;
  fencingToken: number;
  generation: number;
  capabilities: string[];
  role: string;
}

export interface Seeded {
  mission: string;
  task: string;
  attempt: string;
  ctx: AttemptCtx;
  /** emitting model call, whose snapshot vector holds the member and health receipts */
  modelCallId: string;
  health: { id: string; key: string; revision: number };
  member: { id: string; key: string; revision: number };
  /** a receipt of ANOTHER mission, in no vector or readset of this attempt */
  foreign: { id: string; key: string; revision: number };
  /** a receipt of this mission the attempt never saw */
  unseen: { id: string; key: string; revision: number };
}

export interface Counts {
  tasks: number;
  findings: number;
  intents: number;
  authorizations: number;
  receipts: number;
  confirmations: number;
  edges: number;
  events: number;
  toolCallEvents: number;
  readSet: number;
  config: string;
}

export interface Outcome {
  ok: boolean;
  value: unknown;
  /** thrown message, or the serialized result */
  text: string;
}

export type Exec = (
  name: string,
  rawArgs: unknown,
  options: { context: AttemptCtx; toolCallId: string; modelCallId?: string },
) => Promise<Outcome>;

export class TeamWorld {
  readonly seeds: Seeded[] = [];
  private constructor(
    readonly db: Acc3Database,
    private readonly dropDb: () => Promise<void>,
    readonly admin: pg.Pool,
    readonly app: pg.Pool,
  ) {}

  static async open(): Promise<TeamWorld> {
    const created = await createAcc3Database();
    const admin = new pg.Pool({
      connectionString: created.db.admin,
      max: 4,
      application_name: 'acc3-g3-team-admin',
    });
    const app = new pg.Pool({
      connectionString: created.db.app,
      max: 4,
      application_name: 'acc3-g3-team-app',
    });
    await seedConfigRows(created.db.admin);
    return new TeamWorld(created.db, created.drop, admin, app);
  }

  async close() {
    await this.admin.end().catch(() => undefined);
    await this.app.end().catch(() => undefined);
    await this.dropDb();
  }

  async q<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.admin.query(text, values)).rows as T[];
  }

  async seedMission(over: { generation?: number } = {}): Promise<string> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO coordinator.missions (id, owner_id, space_id, environment, resource, goal, mode, status, generation, budgets, provider)
       VALUES ($1, $2, NULL, 'test', 'checkout', 'acc3 goal', 'fixture', 'running', $3, $4::jsonb, $5::jsonb)`,
      [
        id,
        OWNER_ID,
        over.generation ?? 0,
        JSON.stringify(BUDGETS),
        JSON.stringify({
          host: 'fixture.local',
          plannerModel: 'fx',
          workerModel: 'fx',
        }),
      ],
    );
    return id;
  }

  async seedTask(
    missionId: string,
    o: {
      role?: keyof typeof CAPS;
      status?: string;
      parentId?: string | null;
      depth?: number;
      fenceSeq?: number;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const role = o.role ?? 'investigator';
    const parentId = o.parentId ?? null;
    const ordinal = Number(
      (
        await this.q<{ n: string }>(
          `SELECT coalesce(max(ordinal), -1) + 1 AS n FROM coordinator.tasks WHERE mission_id = $1`,
          [missionId],
        )
      )[0].n,
    );
    await this.q(
      `INSERT INTO coordinator.tasks (id, mission_id, parent_id, depth, ordinal, title, question, role, capabilities, status, generation,
                                      prerequisites, fence_seq, attempt_count, budget, justification)
       VALUES ($1, $2, $3, $4, $5, 'acc3 task', 'acc3 question', $6, $7::text[], $8, 0, '{}', $9, 1,
               '{"maxIterations":8,"maxTokens":20000,"maxChildren":4}'::jsonb, $10)`,
      [
        id,
        missionId,
        parentId,
        o.depth ?? (parentId ? 1 : 0),
        ordinal,
        role,
        [...CAPS[role]],
        o.status ?? 'running',
        o.fenceSeq ?? 1,
        parentId ? 'acc3 justification' : null,
      ],
    );
    return id;
  }

  async seedAttemptRow(missionId: string, taskId: string): Promise<string> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at)
       VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'acc3-worker', 1, now() + interval '1 hour', now())`,
      [id, taskId, missionId],
    );
    return id;
  }

  /** A source (idempotent) and one supported receipt for it, with its source_revisions row. */
  async seedReceipt(
    missionId: string,
    key: string,
    revision: number,
    value: unknown,
    type = 'observed_endpoint',
  ): Promise<{ id: string; key: string; revision: number }> {
    const authority = /^controlled/.test(type) ? 'controlled' : 'observed';
    const source = await this.q<{ id: string }>(
      `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
       VALUES ($1, $2, 'test', 'checkout', $3, $4, $5)
       ON CONFLICT (owner_id, environment, resource, key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
      [randomUUID(), OWNER_ID, key, type, authority],
    );
    const id = randomUUID();
    const body = JSON.stringify(value);
    await this.q(
      `INSERT INTO ledger.observation_receipts (id, source_id, source_revision, mission_id, content_digest, normalized_value, status, trust, provenance_kind)
       VALUES ($1, $2, $3, $4, encode(sha256($5::bytea), 'hex'), $6::jsonb, 'supported', $7, 'watcher')`,
      [
        id,
        source[0].id,
        revision,
        missionId,
        Buffer.from(body),
        body,
        authority === 'controlled' ? 'controlled_authority' : 'observed_tool',
      ],
    );
    await this.q(
      `INSERT INTO ledger.source_revisions (source_id, source_revision, receipt_id, content_digest)
       VALUES ($1, $2, $3, encode(sha256($4::bytea), 'hex'))`,
      [source[0].id, revision, id, Buffer.from(body)],
    );
    return { id, key, revision };
  }

  /** The emitting model call and its context snapshot, whose dependency vector holds `vector`. */
  async seedModelCall(
    ctx: AttemptCtx,
    vector: { id: string; key: string; revision: number }[],
  ): Promise<string> {
    const snapshotId = randomUUID();
    const hex = (seed: string) =>
      // 64 lowercase hex characters derived from a label (setup only, not an oracle value)
      Buffer.from(seed.padEnd(32, '0').slice(0, 32)).toString('hex');
    await this.q(
      `INSERT INTO ledger.context_snapshots (id, mission_id, context_schema_version, layout, prefix_digest, prefix_length, context_digest, context_length,
                                             tool_schema_hash, injected, dependency_vector, volatile_now)
       VALUES ($1, $2, 'v1', 'cache_aware', $3, 10, $4, 20, $5, '{}'::jsonb, $6::jsonb, now())`,
      [
        snapshotId,
        ctx.missionId,
        hex('prefix'),
        hex('context'),
        hex('tools'),
        JSON.stringify(
          vector.map((v) => ({
            sourceKey: v.key,
            sourceRevision: v.revision,
            receiptId: v.id,
          })),
        ),
      ],
    );
    const callId = randomUUID();
    await this.q(
      `INSERT INTO ledger.model_call_records (id, scope, mission_id, task_id, attempt_id, role, model_requested, provider_host, provider_mode,
                                              context_snapshot_id, outcome, output_digest, output_dependency_vector, tool_calls, created_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, 'worker', 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B', 'fixture.local', 'fixture',
               $6, 'tool_calls', $7, '[]'::jsonb, '[]'::jsonb, now())`,
      [
        callId,
        JSON.stringify({
          ownerId: OWNER_ID,
          missionId: ctx.missionId,
          spaceId: null,
          environment: 'test',
          resource: 'checkout',
        }),
        ctx.missionId,
        ctx.taskId,
        ctx.attemptId,
        snapshotId,
        hex('output'),
      ],
    );
    await this.q(
      `UPDATE coordinator.task_attempts SET model_call_ids = array_append(model_call_ids, $2::uuid) WHERE id = $1`,
      [ctx.attemptId, callId],
    );
    return callId;
  }

  /**
   * A running attempt (fencing token 1, generation 0) of an investigator or cache specialist, with an emitting
   * model call whose snapshot vector holds exactly {member, health}; `unseen` is a receipt of the same mission
   * the attempt never saw and `foreign` belongs to another mission.
   */
  async seedAttempt(
    role: keyof typeof CAPS = 'cache_specialist',
  ): Promise<Seeded> {
    const mission = await this.seedMission();
    const other = await this.seedMission();
    const parent = await this.seedTask(mission, {
      role: 'investigator',
      status: 'waiting',
      fenceSeq: 0,
    });
    const task = await this.seedTask(mission, { role, parentId: parent });
    const attempt = await this.seedAttemptRow(mission, task);
    const ctx: AttemptCtx = {
      missionId: mission,
      taskId: task,
      attemptId: attempt,
      fencingToken: 1,
      generation: 0,
      capabilities: [...CAPS[role]],
      role,
    };
    const health = await this.seedReceipt(mission, 'checkout.health', 3, {
      status: 'degraded',
    });
    const member = await this.seedReceipt(
      mission,
      'checkout.config/db.pool_max',
      1,
      2,
      'controlled_config',
    );
    const unseen = await this.seedReceipt(
      mission,
      'redis.stats',
      2,
      { hitRate: 0.4 },
      'observed_store',
    );
    const foreign = await this.seedReceipt(other, 'checkout.metrics', 5, {
      p95: 900,
    });
    const modelCallId = await this.seedModelCall(ctx, [member, health]);
    const seeded: Seeded = {
      mission,
      task,
      attempt,
      ctx,
      modelCallId,
      health,
      member,
      foreign,
      unseen,
    };
    this.seeds.push(seeded);
    return seeded;
  }

  async tableExists(qualified: string): Promise<boolean> {
    const [schema, name] = qualified.split('.');
    const rows = await this.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      [schema, name],
    );
    return rows[0].n > 0;
  }

  async counts(missionId: string, attemptId?: string): Promise<Counts> {
    const one = async (text: string, values: unknown[]) =>
      Number((await this.q<{ n: string }>(text, values))[0].n);
    const intents = (await this.tableExists('coordinator.action_intents'))
      ? await one(
          `SELECT count(*) AS n FROM coordinator.action_intents WHERE mission_id = $1`,
          [missionId],
        )
      : 0;
    const authorizations = (await this.tableExists(
      'coordinator.authorizations',
    ))
      ? await one(`SELECT count(*) AS n FROM coordinator.authorizations`, [])
      : 0;
    const readSet = attemptId
      ? await one(
          `SELECT coalesce(cardinality(read_set_receipt_ids), 0) AS n FROM coordinator.task_attempts WHERE id = $1`,
          [attemptId],
        )
      : 0;
    const config = (
      await this.q<{ d: string }>(
        `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.key), '')) AS d FROM checkout.config_entries x`,
      )
    )[0].d;
    return {
      tasks: await one(
        `SELECT count(*) AS n FROM coordinator.tasks WHERE mission_id = $1`,
        [missionId],
      ),
      findings: await one(
        `SELECT count(*) AS n FROM coordinator.findings WHERE mission_id = $1`,
        [missionId],
      ),
      intents,
      authorizations,
      receipts: await one(
        `SELECT count(*) AS n FROM ledger.observation_receipts WHERE mission_id = $1`,
        [missionId],
      ),
      confirmations: await one(
        `SELECT count(*) AS n FROM ledger.receipt_confirmations c JOIN ledger.observation_receipts r ON r.id = c.receipt_id WHERE r.mission_id = $1`,
        [missionId],
      ),
      edges: await one(
        `SELECT count(*) AS n FROM ledger.dependency_edges WHERE mission_id = $1`,
        [missionId],
      ),
      events: await one(
        `SELECT count(*) AS n FROM coordinator.events WHERE mission_id = $1`,
        [missionId],
      ),
      toolCallEvents: await one(
        `SELECT count(*) AS n FROM coordinator.events WHERE mission_id = $1 AND kind = 'tool_call.recorded'`,
        [missionId],
      ),
      readSet,
      config,
    };
  }

  /** Every intent row of a mission as JSON (the action_intents table is created by a later migration). */
  async intents(missionId: string): Promise<Record<string, unknown>[]> {
    if (!(await this.tableExists('coordinator.action_intents'))) return [];
    return (
      await this.q<{ j: Record<string, unknown> }>(
        `SELECT to_jsonb(x) AS j FROM coordinator.action_intents x WHERE x.mission_id = $1 ORDER BY x.created_at`,
        [missionId],
      )
    ).map((row) => row.j);
  }

  /** value and version of one controlled configuration key, from the authority table. */
  async configOf(key: string): Promise<{ value: unknown; version: number }> {
    const rows = await this.q<{ value: unknown; version: string }>(
      `SELECT value, version FROM checkout.config_entries WHERE key = $1`,
      [key],
    );
    return { value: rows[0]?.value, version: Number(rows[0]?.version) };
  }
}

/* ------------------------------------------------------------------ executor binding */

function looksLikeError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Boolean(record.error) ||
    record.isError === true ||
    record.ok === false ||
    (typeof record.status === 'string' &&
      /^(error|rejected|refused|blocked|denied)$/i.test(record.status))
  );
}

export async function bindTeamExecutor(world: TeamWorld): Promise<Exec> {
  const file = resolve(APP_ROOT, TEAM_TOOLS_MODULE);
  if (!existsSync(file))
    throw new EntryPointMissingError(
      TEAM_TOOLS_MODULE,
      'module file does not exist',
    );
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (error) {
    throw new EntryPointMissingError(
      TEAM_TOOLS_MODULE,
      `module failed to load: ${(error as Error).message}`,
    );
  }
  const factory = mod.createTeamTools;
  if (typeof factory !== 'function')
    throw new EntryPointMissingError(
      `${TEAM_TOOLS_MODULE}#createTeamTools`,
      'no such export',
    );
  const tools = await (factory as (deps: unknown) => unknown)({
    pool: world.app,
    appPool: world.app,
    adminUrl: world.db.admin,
    appUrl: world.db.app,
    env: { ...process.env },
    clock: () => new Date(),
  });
  const dispatcher = (tools as { execute?: unknown } | null)?.execute;
  if (typeof dispatcher !== 'function')
    throw new DriverWiringPendingError(
      'team executors',
      `${TEAM_TOOLS_MODULE}#createTeamTools(deps) must return { execute(name, rawArgs, { context, toolCallId, modelCallId }) } (ACCEPTANCE_CONTRACT section 10)`,
    );
  return async (name, rawArgs, options) => {
    try {
      const value = await (
        dispatcher as (n: string, a: unknown, o: unknown) => Promise<unknown>
      ).call(tools, name, rawArgs, options);
      return {
        ok: !looksLikeError(value),
        value,
        text: JSON.stringify(value) ?? '',
      };
    } catch (error) {
      const e = error as Error & { code?: string; reason?: string };
      return {
        ok: false,
        value: undefined,
        text: `${e.name ?? 'Error'} ${e.code ?? ''} ${e.reason ?? ''} ${e.message ?? String(error)}`,
      };
    }
  };
}

export { adminQuery };
