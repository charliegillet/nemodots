// Gate 2 (admission and races) harness. Port block: checkout 4640, app 4641
// (reserved; this suite drives services in process and opens no HTTP port).
// Databases come from tests/nemodots/helpers/test-db.ts (withTestDatabase,
// nemodots_test_<rand> on the NemoDots PostgreSQL 55432). Redis uses db index 3
// on the NemoDots Redis (56379) with a random key prefix.
//
// What is verifier-owned here and what is production code:
// - Mission and task rows are seeded with verifier SQL, then claimed and
//   started through the REAL coordinator (coordinator/leases.ts claimAttempt +
//   startAttempt). Publication, delegation, findings, model calls, read sets,
//   heartbeat and the reaper are the REAL coordinator and ledger functions
//   (coordinator/publish.ts, coordinator/leases.ts, ledger/model-calls.ts,
//   ledger/receipts.ts, ledger/readset.ts). The composition ("deps") is built
//   here because the production composition root does not exist yet; it only
//   adapts ledger functions to the coordinator's LedgerWriterPort.
// - Expected values live in the test files and the frozen oracle, never in
//   production logic.
// - Entry points that do not exist yet (actions, watcher, mission control) are
//   resolved at run time; a missing module or export FAILS the test with
//   "ENTRY POINT MISSING" (never skipped). The list is in ./README.md.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from 'redis';
import { expect } from 'vitest';
import { barrier, latch, withTimeout } from '../../helpers/barrier.js';
import { testRedisUrl } from '../../helpers/test-redis.js';
import { withTestDatabase } from '../../helpers/test-db.js';
import {
  ROLE_CAPABILITIES,
  digest,
  unionDependencyVectors,
} from '../../../../src/server/nemodots/contracts/index.js';
import type {
  ActionAdmissionPort,
  ActionIntent,
  AttemptContext,
  ContextSnapshot,
  DependencyVector,
  ModelCallRecord,
  ProposeInput,
  Scope,
  TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  addEdges,
  createSupportValidator,
  recordModelCall as ledgerRecordModelCall,
  recordOrphanedAttempt as ledgerRecordOrphanedAttempt,
  recordReadSet,
  registerObservation,
  type RegisterObservationInput,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  addReadSet,
  recordModelCall as coordRecordModelCall,
  type PublishDeps,
} from '../../../../src/server/nemodots/coordinator/publish.js';
import {
  claimAttempt,
  reapExpired,
  startAttempt,
} from '../../../../src/server/nemodots/coordinator/leases.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { createRecovery } from '../../../../src/server/nemodots/coordinator/recovery.js';
import type {
  CoordinatorDeps,
  LedgerWriterPort,
} from '../../../../src/server/nemodots/coordinator/types.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { advanceConfig } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { SETUP_CONFIG, ADMISSION_CASES } from '../oracle/admission.js';
import type {
  AdmissionOutcome,
  AdmissionStep,
  IntentExpectation,
} from '../oracle/admission.js';

process.env.NEMODOTS_TEST_HOOKS = '1';

// Every production registration needs the coordinator event sink
// (ledger/options.ts requireEventSink, W2-R5): it writes the per-mission
// invalidation.recorded events inside the registration transaction.
const LEDGER_EVENTS = { ledger: { events: createEventSink() } };

export const PORTS = { checkout: 4640, app: 4641 } as const;
export const REDIS_DB = 3;
export { barrier, latch, withTimeout, SETUP_CONFIG, ADMISSION_CASES };

const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export class EntryPointMissing extends Error {
  constructor(entry: string, why: string) {
    super(
      `ENTRY POINT MISSING: ${entry} (${why}). See tests/nemodots/acceptance/g2-races/README.md.`,
    );
    this.name = 'EntryPointMissing';
  }
}

/** Dynamic import of src/server/nemodots/<file>; a missing file or export is a hard failure. */
export async function entry<T = unknown>(
  file: string,
  names?: string | readonly string[],
): Promise<T> {
  const abs = resolve(APP_ROOT, 'src/server/nemodots', file);
  const wanted = names === undefined ? [] : [names].flat();
  const label = `src/server/nemodots/${file}${wanted.length ? `#${wanted.join('|')}` : ''}`;
  if (!existsSync(abs))
    throw new EntryPointMissing(label, 'file does not exist');
  let mod: Rec;
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(abs).href);
  } catch (e) {
    throw new EntryPointMissing(
      label,
      `failed to load: ${(e as Error).message}`,
    );
  }
  if (wanted.length === 0) return mod as T;
  for (const n of wanted) if (typeof mod[n] !== 'undefined') return mod[n] as T;
  throw new EntryPointMissing(
    label,
    `no such export (module exports: ${Object.keys(mod).join(', ') || 'nothing'})`,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function isSettled(p: Promise<unknown>, graceMs = 400) {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await sleep(graceMs);
  return done;
}
export const errText = (e: unknown) =>
  `${(e as Rec)?.name ?? ''}|${(e as Rec)?.code ?? ''}|${(e as Rec)?.message ?? e}`;
/** Error class name of a thrown value ('' for non-errors). */
export const errName = (e: unknown) => String((e as Rec)?.name ?? '');
export const isFenceError = (e: unknown) => errName(e) === 'FenceError';
export const isDispatchFenceError = (e: unknown) =>
  errName(e) === 'DispatchFenceError';

export const POOL = 'db.pool_max';
export const TIMEOUT = 'db.statement_timeout_ms';
export const NS = 'cache.namespace';
export const ROUTING = 'routing.inventory_source';
export const ORDERS = 'orders.write_enabled';

export type HookPoint =
  | 'after_preliminary_read'
  | 'before_lock'
  | 'after_lock_before_commit'
  | 'after_commit_before_dispatch'
  | 'after_effect_before_record';

export type Need = 'actions' | 'hooks' | 'cacheKey' | 'watcher' | 'control';

export interface Parked {
  reached: Promise<Rec>;
  release(): void;
}

/** A running attempt (real coordinator claim + start) and what it has read. */
export interface Att {
  ctx: AttemptContext;
  role: TaskRole;
  /** Receipt labels the attempt's model calls inherit (snapshot vector only, not the read set). */
  inherit: string[];
  /** label -> receipt id the attempt has read (read set + evidence edge). */
  reads: Map<string, string>;
}

export interface ProposeSpec {
  action: 'set_config' | 'flush_cache_namespace';
  payload: Rec;
  /** receipt labels: member:<key>, health, redis, foreign */
  cites: string[];
  toolCallId: string;
  att?: Att;
  /** extra top-level fields smuggled into the tool input (a strict schema must reject them) */
  extra?: Rec;
}

export type Actions = ActionAdmissionPort & {
  reclaim(id: string, dispatcher: string): Promise<ActionIntent>;
  compensate(id: string, ctx: Rec): Promise<ActionIntent>;
};
export interface ActionsHandle {
  api: Actions;
  pool: pg.Pool;
  redis: ReturnType<typeof createClient>;
}

// ---------------------------------------------------------------- Redis tools

/**
 * TCP proxy in front of the NemoDots Redis. 'drop_reply': the script request is
 * forwarded and really executes, its reply is swallowed and the connection is
 * cut (a lost response after a real effect). 'fail_before': the request is
 * never forwarded and the connection is cut (the effect did not happen).
 * Implementation agnostic: it does not care how the production client sends
 * its script.
 */
export class RedisFault {
  mode: 'ok' | 'drop_reply' | 'fail_before' = 'ok';
  port = 0;
  private server!: net.Server;
  private readonly sockets = new Set<net.Socket>();
  static async start(targetHost: string, targetPort: number) {
    const f = new RedisFault();
    f.server = net.createServer((client) => {
      const up = net.connect(targetPort, targetHost);
      f.sockets.add(client);
      f.sockets.add(up);
      let dropNext = false;
      const kill = () => {
        client.destroy();
        up.destroy();
      };
      client.on('error', kill);
      up.on('error', kill);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
      client.on('data', (buf) => {
        const scripted =
          /\r\n\$\d+\r\n(EVAL|EVALSHA|EVAL_RO|EVALSHA_RO|FCALL|FCALL_RO)\r\n/i.test(
            buf.toString('latin1'),
          );
        if (scripted && f.mode === 'fail_before') return kill();
        if (scripted && f.mode === 'drop_reply') dropNext = true;
        up.write(buf);
      });
      up.on('data', (buf) => {
        if (dropNext) {
          dropNext = false;
          setTimeout(kill, 5); // reply swallowed, connection cut
          return;
        }
        client.write(buf);
      });
    });
    await new Promise<void>((ok) => f.server.listen(0, '127.0.0.1', ok));
    f.port = (f.server.address() as net.AddressInfo).port;
    return f;
  }
  url(db: number) {
    return `redis://127.0.0.1:${this.port}/${db}`;
  }
  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

/**
 * MONITOR on a dedicated raw connection (straight to Redis, not through the
 * fault proxy). Commands issued from inside a Lua script are reported too, so
 * this counts real UNLINK/DEL effects per key.
 */
export class RedisWatch {
  private lines: string[] = [];
  private sock!: net.Socket;
  private tail = '';
  static async start(host: string, port: number) {
    const w = new RedisWatch();
    w.sock = net.connect(port, host);
    w.sock.setEncoding('utf8');
    const ready = new Promise<void>((ok, bad) => {
      w.sock.on('error', bad);
      w.sock.on('data', (chunk: string) => {
        const parts = (w.tail + chunk).split('\r\n');
        w.tail = parts.pop() ?? '';
        for (const l of parts) {
          if (l === '+OK') ok();
          else w.lines.push(l);
        }
      });
    });
    w.sock.write('MONITOR\r\n');
    await withTimeout(ready, 5000, 'redis MONITOR did not start');
    return w;
  }
  /** Number of UNLINK/DEL command mentions of any of the given keys. */
  mentions(keys: readonly string[]) {
    let n = 0;
    for (const line of this.lines) {
      if (!/"(unlink|del)"/i.test(line)) continue;
      for (const k of keys) if (line.includes(`"${k}"`)) n += 1;
    }
    return n;
  }
  stop() {
    this.sock.destroy();
  }
}

// ---------------------------------------------------------------------- World

export interface World {
  names: { db: string; prefix: string };
  /** the primary action-admission instance (own pool and Redis client) */
  actions: Actions;
  mission: string;
  scope: Scope;
  admin: pg.Pool;
  app: pg.Pool;
  injector: pg.Pool;
  verifier: pg.Pool;
  redis: ReturnType<typeof createClient>;
  fault: RedisFault;
  watch: RedisWatch;
  deps: PublishDeps & CoordinatorDeps;
  receipts: Map<string, { id: string; sourceKey: string; revision: number }>;
  /** another fully independent action-admission instance (own pool, own Redis client) */
  newActions(label: string): Promise<ActionsHandle>;
  // receipts
  registerMember(key: string): Promise<string>;
  registerObserved(
    label: 'health' | 'redis',
    value?: unknown,
    o?: { observedAt?: Date },
  ): Promise<string>;
  receiptId(label: string): string;
  // missions and attempts (real coordinator)
  seedMission(): Promise<string>;
  seedTask(missionId: string, role: TaskRole): Promise<string>;
  newAttempt(
    role: TaskRole,
    o?: { missionId?: string; reads?: string[]; inherit?: string[] },
  ): Promise<Att>;
  claim(role: TaskRole, missionId?: string): Promise<Att | null>;
  readReceipts(att: Att, labels: string[]): Promise<void>;
  modelCallFor(att: Att, toolCallId: string): Promise<string>;
  /** the context a tool call carries into propose/compensate: attempt identity + its recorded model call */
  callCtx(att: Att, toolCallId: string): Promise<Rec>;
  /** a fully formed model call (record + snapshot) for the attempt, NOT yet recorded */
  buildModelCall(
    att: Att,
    toolCallIds: string[],
  ): { record: ModelCallRecord; snapshot: ContextSnapshot };
  vector(labels: string[]): DependencyVector;
  /** re-read the head receipt of a label from the ledger (after a watcher registered a new revision) */
  refresh(label: string): Promise<void>;
  expireLease(attemptId: string): Promise<void>;
  reap(): Promise<unknown[]>;
  footprint(): Promise<Rec>;
  // config mutation
  advance(
    key: string,
    value: unknown,
    o?: {
      via?: 'injector' | 'owner';
      register?: boolean;
      expectedVersion?: number;
    },
  ): Promise<void>;
  holdRowLock(
    key: string,
    value: unknown,
  ): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }>;
  // actions
  propose(spec: ProposeSpec): Promise<ActionIntent>;
  /** propose through another action-admission instance */
  proposeVia(api: Actions, spec: ProposeSpec): Promise<ActionIntent>;
  proposeAdmit(spec: ProposeSpec): Promise<ActionIntent>;
  poolSpec(toolCallId: string, value?: number, cites?: string[]): ProposeSpec;
  flushSpec(toolCallId: string): ProposeSpec;
  setSpec(
    toolCallId: string,
    key: string,
    value: unknown,
    cites: string[],
  ): ProposeSpec;
  // hooks
  park(point: HookPoint, only?: (ctx: Rec) => boolean): Parked;
  onHook(point: HookPoint, fn: (ctx: Rec) => Promise<void> | void): void;
  hits(point: HookPoint): number;
  clearHooks(): Promise<void>;
  // inspection (verifier-owned SQL; no production reads)
  cfg(
    key: string,
  ): Promise<{ value: unknown; version: number; causedBy: string | null }>;
  snapshotConfig(): Promise<
    Record<string, { value: unknown; version: number }>
  >;
  history(key: string): Promise<Rec[]>;
  intent(id: string): Promise<Rec>;
  auths(id: string): Promise<Rec[]>;
  resultReceipts(id: string): Promise<Rec[]>;
  actionRows(): Promise<number>;
  outboxFor(id: string): Promise<Rec[]>;
  invalidationCount(): Promise<number>;
  invalidationsFor(sourceKey: string): Promise<Rec[]>;
  headReceipt(sourceKey: string): Promise<Rec | null>;
  anyBlocked(): Promise<boolean>;
  // redis
  plantCache(n?: number, ns?: string, tag?: string): Promise<string[]>;
  cacheKeysLeft(keys: string[]): Promise<number>;
  markerPresent(actionId: string): Promise<boolean>;
  fenceKeys(): Promise<string[]>;
  // lease helpers
  expireDispatcherLease(id: string): Promise<void>;
  // lazily resolved production entries
  watcher(): Promise<Rec>;
  watcherPoll(): Promise<void>;
  control(): Promise<Rec>;
}

const DEFAULT_MEMBERS = Object.keys(SETUP_CONFIG);
const BUDGETS = {
  maxTasks: 40,
  maxDepth: 3,
  maxBreadth: 6,
  maxTokens: 200_000,
  maxInferenceCalls: 200,
  maxWallClockMs: 3_600_000,
};
const TASK_BUDGET = { maxIterations: 8, maxTokens: 20_000, maxChildren: 4 };

async function requireEntries(need: readonly Need[]) {
  const wanted: [Need, string, string[]][] = [
    ['actions', 'actions/index.ts', ['createActions']],
    ['actions', 'actions/dispatch.ts', ['effectKey']],
    ['actions', 'actions/dispatch.ts', ['fenceKey']],
    ['hooks', 'actions/test-hooks.ts', ['setHook', 'clearHooks']],
    // The flush clears the checkout's own cache keys, so planted keys use the
    // checkout's key format (sandbox/checkout-cache.ts), not an actions name.
    ['cacheKey', 'sandbox/checkout-cache.ts', ['cacheKey']],
    ['watcher', 'watcher/watcher.ts', ['createWatcher']],
    [
      'control',
      'coordinator/control.ts',
      ['createMissionControl', 'createControl', 'createMissionControlPort'],
    ],
  ];
  const missing: string[] = [];
  for (const [n, file, names] of wanted)
    if (need.includes(n))
      await entry(file, names).catch((e: Error) => missing.push(e.message));
  if (missing.length)
    throw new EntryPointMissing(
      'Gate 2 entry points',
      `\n${missing.join('\n')}`,
    );
}

export async function withWorld<T>(
  fn: (w: World) => Promise<T>,
  opts: { need?: Need[] } = {},
): Promise<T> {
  const need = opts.need ?? ['actions', 'hooks', 'cacheKey'];
  await requireEntries(need);
  return withTestDatabase(async (db) => {
    const cleanup: (() => Promise<void> | void)[] = [];
    const mkPool = (url: string, name: string, max = 8) => {
      const p = new pg.Pool({
        connectionString: url,
        max,
        application_name: `acc2-${name}`,
      });
      p.on('error', () => {});
      cleanup.push(() => p.end().catch(() => {}));
      return p;
    };
    const prefix = `acc2:${randomBytes(5).toString('hex')}`;
    const rurl = new URL(testRedisUrl());
    const redis = createClient({
      url: `redis://${rurl.hostname}:${rurl.port}/${REDIS_DB}`,
    });
    redis.on('error', () => {});
    await redis.connect();
    const fault = await RedisFault.start(rurl.hostname, Number(rurl.port));
    const watch = await RedisWatch.start(rurl.hostname, Number(rurl.port));
    cleanup.push(async () => {
      watch.stop();
      await fault.stop();
      try {
        for await (const keys of redis.scanIterator({
          MATCH: `${prefix}:*`,
          COUNT: 200,
        }))
          if (keys.length) await redis.unlink(keys);
      } catch {
        /* best effort, own prefix only */
      }
      redis.destroy();
    });
    let world: World | null = null;
    try {
      world = await build({
        db: db.name,
        urls: db.urls as Record<string, string>,
        prefix,
        redis,
        fault,
        watch,
        need,
        mkPool,
        cleanup,
      });
      return await fn(world);
    } finally {
      await world?.clearHooks().catch(() => {});
      for (const c of cleanup.reverse())
        await Promise.resolve(c()).catch(() => {});
    }
  });
}

async function build(c: {
  db: string;
  urls: Record<string, string>;
  prefix: string;
  redis: ReturnType<typeof createClient>;
  fault: RedisFault;
  watch: RedisWatch;
  need: readonly Need[];
  mkPool: (url: string, name: string, max?: number) => pg.Pool;
  cleanup: (() => Promise<void> | void)[];
}): Promise<World> {
  const { prefix, fault, watch } = c;
  const admin = c.mkPool(c.urls.admin, 'admin');
  const app = c.mkPool(c.urls.app, 'app');
  const injector = c.mkPool(c.urls.injector, 'injector');
  const verifier = c.mkPool(c.urls.verifier, 'verifier');
  const ownerId = 'acc2-owner';
  const tx = <R>(pool: pg.Pool, f: (cl: pg.PoolClient) => Promise<R>) =>
    withTransaction(pool, f);

  const lazy = <T>(file: string, names: string | string[]) => {
    let p: Promise<T> | null = null;
    return () => (p ??= entry<T>(file, names));
  };
  const loadActions = lazy<(d: Rec) => Rec>('actions/index.ts', [
    'createActions',
  ]);
  const loadEffectKey = lazy<(p: string, actionId: string) => string>(
    'actions/dispatch.ts',
    ['effectKey'],
  );
  const loadCacheKey = async () => {
    const make = await entry<
      (p: string, ns: string, schema: number, n: string) => string
    >('sandbox/checkout-cache.ts', ['cacheKey']);
    // schema 1: any schema suffix lies under the namespace prefix the flush scans
    return (p: string, ns: string, n: string) => make(p, ns, 1, n);
  };
  const loadWatcher = lazy<(d: Rec) => Promise<Rec> | Rec>(
    'watcher/watcher.ts',
    ['createWatcher'],
  );
  const loadControl = lazy<(d: Rec) => Promise<Rec> | Rec>(
    'coordinator/control.ts',
    ['createMissionControl', 'createControl', 'createMissionControlPort'],
  );
  let hooksModule: Rec | null = null;
  if (c.need.includes('hooks'))
    hooksModule = await entry<Rec>('actions/test-hooks.ts');
  let cacheKeyFn: ((p: string, ns: string, n: string) => string) | null = null;
  if (c.need.includes('cacheKey')) cacheKeyFn = await loadCacheKey();

  // ------------------------------------------------------------------ SQL seeds
  const seedMission = async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO coordinator.missions
         (id, owner_id, space_id, environment, resource, goal, constraints, mode,
          status, budgets, provider, started_at)
       VALUES ($1,$2,NULL,'test','checkout','g2 acceptance mission','[]'::jsonb,'fixture',
          'running',$3::jsonb,$4::jsonb,now())`,
      [
        id,
        ownerId,
        JSON.stringify(BUDGETS),
        JSON.stringify({
          host: 'fixture.local',
          plannerModel: 'fx',
          workerModel: 'fx',
        }),
      ],
    );
    return id;
  };
  const mission = await seedMission();
  const missionScope = (missionId: string): Scope => ({
    ownerId,
    missionId: missionId as never,
    spaceId: null,
    environment: 'test',
    resource: 'checkout',
  });
  const scope = missionScope(mission);
  const seedTask = async (missionId: string, role: TaskRole) => {
    const id = randomUUID();
    const caps = [...(ROLE_CAPABILITIES[role] as readonly string[])];
    await admin.query(
      `INSERT INTO coordinator.tasks
         (id, mission_id, parent_id, depth, ordinal, title, question, role, capabilities,
          status, generation, budget)
       SELECT $1, m.id, NULL, 0,
              COALESCE((SELECT max(ordinal) + 1 FROM coordinator.tasks WHERE mission_id = m.id), 0),
              $3, $4, $5, $6::text[], 'runnable', m.generation, $7::jsonb
         FROM coordinator.missions m WHERE m.id = $2`,
      [
        id,
        missionId,
        `g2 ${role} task`,
        'g2 acceptance question',
        role,
        caps,
        JSON.stringify(TASK_BUDGET),
      ],
    );
    return id;
  };

  const cfg: World['cfg'] = async (key) => {
    const r = await verifier.query(
      'SELECT value, version, caused_by_action_id FROM checkout.config_entries WHERE key=$1',
      [key],
    );
    if (!r.rows[0]) throw new Error(`config key ${key} is not seeded`);
    return {
      value: r.rows[0].value,
      version: Number(r.rows[0].version),
      causedBy: r.rows[0].caused_by_action_id,
    };
  };

  // Test-local setup values go through the version authority as the 'seed' actor.
  for (const [k, v] of Object.entries(SETUP_CONFIG)) {
    const cur = await admin.query(
      'SELECT version FROM checkout.config_entries WHERE key=$1',
      [k],
    );
    await tx(admin, (cl) =>
      advanceConfig(
        cl,
        cur.rows[0]
          ? {
              key: k,
              value: v,
              expectedVersion: Number(cur.rows[0].version),
              causedBy: { actor: 'seed' },
            }
          : {
              key: k,
              value: v,
              expectedVersion: 0,
              insertIfMissing: true,
              causedBy: { actor: 'seed' },
            },
      ),
    );
  }

  // ------------------------------------------------------------------ receipts
  const receipts: World['receipts'] = new Map();
  const digests = new Map<string, string>();
  const keep = (
    label: string,
    r: { id: string; sourceRevision: number; contentDigest: string },
    sourceKey: string,
  ) => {
    receipts.set(label, { id: r.id, sourceKey, revision: r.sourceRevision });
    digests.set(r.id, r.contentDigest);
  };
  const provenance = { kind: 'watcher' as const };
  const registerMember: World['registerMember'] = async (key) => {
    const cur = await cfg(key);
    const coll = await verifier.query(
      'SELECT version FROM checkout.config_collection',
    );
    const res = await tx(app, (cl) =>
      registerObservation(
        cl,
        {
          source: {
            key: `checkout.config/${key}`,
            sourceType: 'controlled_config',
            authority: 'controlled',
            scope,
          },
          trust: 'controlled_authority',
          // ARCHITECTURE 9.4 / D10: a config member's normalized value is { key, value, version }.
          normalizedValue: { key, value: cur.value, version: cur.version },
          provenance,
          collectionRevision: Number(coll.rows[0].version),
          claimed: { sourceRevision: cur.version },
        } as unknown as RegisterObservationInput,
        LEDGER_EVENTS as never,
      ),
    );
    keep(`member:${key}`, res.receipt, `checkout.config/${key}`);
    return res.receipt.id;
  };
  const registerObserved: World['registerObserved'] = async (
    label,
    value,
    o,
  ) => {
    const key = label === 'health' ? 'checkout.health' : 'redis.stats';
    const res = await tx(app, (cl) =>
      registerObservation(
        cl,
        {
          source: {
            key,
            sourceType:
              label === 'health' ? 'observed_endpoint' : 'observed_store',
            authority: 'observed',
            scope,
          },
          trust: 'observed_tool',
          normalizedValue:
            value ?? (label === 'health' ? { status: 'ok' } : { keys: 0 }),
          provenance,
          observedAt: o?.observedAt ?? null,
        } as unknown as RegisterObservationInput,
        LEDGER_EVENTS as never,
      ),
    );
    keep(label, res.receipt, key);
    return res.receipt.id;
  };
  for (const k of DEFAULT_MEMBERS) await registerMember(k);
  await registerObserved('health');
  await registerObserved('redis');
  // A valid receipt that belongs to a different mission (scope isolation); a
  // distinct source key so it never supersedes the primary mission's receipts.
  const other = await seedMission();
  const foreign = await tx(app, (cl) =>
    registerObservation(
      cl,
      {
        source: {
          key: 'checkout.metrics',
          sourceType: 'observed_endpoint',
          authority: 'observed',
          scope: missionScope(other),
        },
        trust: 'observed_tool',
        normalizedValue: { p95: 120 },
        provenance,
      } as unknown as RegisterObservationInput,
      LEDGER_EVENTS as never,
    ),
  );
  keep('foreign', foreign.receipt, 'checkout.metrics');

  const receiptId = (label: string) => {
    const r = receipts.get(label);
    if (!r) throw new Error(`no receipt labelled ${label}`);
    return r.id;
  };
  const vectorOf = (labels: readonly string[]): DependencyVector =>
    unionDependencyVectors(
      labels.map((l) => {
        const r = receipts.get(l);
        if (!r) throw new Error(`no receipt labelled ${l}`);
        return {
          sourceKey: r.sourceKey as never,
          sourceRevision: r.revision,
          receiptId: r.id as never,
        };
      }),
    );

  // -------------------------------------------- verifier-built coordinator deps
  const ledgerPort: LedgerWriterPort = {
    async recordModelCall(client, input) {
      await ledgerRecordModelCall(client, {
        record: input.record,
        snapshot: input.snapshot,
      });
    },
    async recordArtifact(client, a) {
      // The graph has no finding node kind (findings are model claims, not
      // graph artifacts); task outputs and delegated tasks get evidence edges.
      if (a.kind === 'finding') return;
      const to = {
        kind: a.kind,
        id: a.id,
        missionId: a.missionId,
        taskId: a.taskId,
      } as const;
      await addEdges(client, [
        ...a.dependencyVector.map((e) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: e.receiptId },
          to,
        })),
        {
          kind: 'evidence' as const,
          from: {
            kind: 'attempt' as const,
            id: a.attemptId,
            missionId: a.missionId,
            taskId: a.taskId,
          },
          to,
        },
      ]);
    },
  };
  // The coordinator's ActionAdmissionPort slice. When the scenario does not
  // load the actions package (pure coordinator tests) there are no intents, so
  // "no queued intents" is the truthful answer for cancelQueued; admit throws.
  const actionsPort = {
    admit: (id: string, d: string) =>
      primary().then((a) => a.api.admit(id as never, d)),
    cancelQueued: async (m: string, g: number) =>
      c.need.includes('actions')
        ? (await primary()).api.cancelQueued(m as never, g)
        : [],
  };
  const hasIntents = async (client: Rec) =>
    (
      await client.query(
        "SELECT to_regclass('coordinator.action_intents') IS NOT NULL AS ok",
      )
    ).rows[0].ok as boolean;
  const deps = {
    pool: app,
    config: {
      ownerId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
      mode: 'fixture',
      provider: {
        host: 'fixture.local',
        plannerModel: 'fx',
        workerModel: 'fx',
      },
      budgets: BUDGETS,
      leaseMs: 30_000,
      taskDefaults: { maxAttempts: 3, maxIterations: 8, maxTokens: 20_000 },
      replanCap: 3,
    },
    supportValidator: createSupportValidator(),
    ledger: ledgerPort,
    recordOrphanedAttempt: async (info: Rec) => {
      await tx(app, (client) =>
        ledgerRecordOrphanedAttempt(client, {
          modelCallId: info.record.id,
          scope: info.record.scope,
          taskId: info.record.taskId,
          attemptId: info.record.attemptId,
          role: info.record.role,
          model: info.record.model,
          provider: info.record.provider,
          attempts: info.record.attempts,
        }),
      );
    },
    // IntentReader over coordinator.action_intents (owned by the actions
    // migration). Before that table exists there are no intents to report.
    intents: {
      async find(client: Rec, id: string) {
        if (!(await hasIntents(client))) return null;
        const r = await client.query(
          'SELECT id, mission_id, task_id, attempt_id, status FROM coordinator.action_intents WHERE id=$1',
          [id],
        );
        const x = r.rows[0];
        return x
          ? {
              id: x.id,
              missionId: x.mission_id,
              taskId: x.task_id,
              attemptId: x.attempt_id,
              status: x.status,
            }
          : null;
      },
      async statuses(client: Rec, ids: string[]) {
        if (!(await hasIntents(client))) return [];
        const r = await client.query(
          'SELECT id, status FROM coordinator.action_intents WHERE id = ANY($1::uuid[])',
          [ids],
        );
        return r.rows;
      },
      async committedEffects(client: Rec, missionId: string) {
        if (!(await hasIntents(client))) return [];
        const r = await client.query(
          "SELECT id FROM coordinator.action_intents WHERE mission_id=$1 AND status IN ('committed','dispatched','verified','outcome_unknown')",
          [missionId],
        );
        return r.rows.map((x: Rec) => x.id);
      },
    },
    actions: actionsPort,
    snapshotReader: {
      read: async () => {
        throw new Error('snapshotReader is not wired in the g2 harness');
      },
    },
    probe: null,
    providerHealthy: async () => true,
    events: createEventSink(),
    clock: () => new Date(),
  } as unknown as World['deps'];

  // ------------------------------------------------------------- action instances
  let primaryHandle: Promise<ActionsHandle> | null = null;
  const newActions: World['newActions'] = async (label) => {
    const factory = await loadActions();
    const pool = c.mkPool(c.urls.app, `app-${label}`, 6);
    const rc = createClient({ url: fault.url(REDIS_DB) });
    rc.on('error', () => {});
    await rc.connect();
    c.cleanup.push(() => rc.destroy());
    // actions/deps.ts ActionsDeps: the same support validator and event sink
    // the coordinator deps use, an app-role pool and a Redis client through
    // the fault proxy.
    const api = factory({
      pool,
      validator: deps.supportValidator,
      events: deps.events,
      redis: rc,
      redisPrefix: prefix,
      dispatchLeaseMs: 30_000,
    }) as Actions;
    return { api, pool, redis: rc };
  };
  const primary = () => (primaryHandle ??= newActions('primary'));
  let primaryApi: Actions | null = null;
  if (c.need.includes('actions')) primaryApi = (await primary()).api;

  // ---------------------------------------------------- attempts (real coordinator)
  const readReceipts: World['readReceipts'] = async (att, labels) => {
    const vec = vectorOf(labels);
    await addReadSet(deps, att.ctx, vec);
    await tx(app, (cl) =>
      recordReadSet(cl, {
        missionId: att.ctx.missionId,
        taskId: att.ctx.taskId,
        attemptId: att.ctx.attemptId,
        receiptIds: vec.map((e) => e.receiptId),
      }),
    );
    for (const l of labels) att.reads.set(l, receiptId(l));
  };
  const claim: World['claim'] = async (role, missionId) => {
    const claimed = await claimAttempt(deps, {
      workerId: `acc2-${randomUUID().slice(0, 8)}`,
      missionId: (missionId ?? mission) as never,
      roles: [role],
    });
    if (!claimed) return null;
    await startAttempt(deps, claimed.context);
    return { ctx: claimed.context, role, inherit: [], reads: new Map() };
  };
  const newAttempt: World['newAttempt'] = async (role, o = {}) => {
    const missionId = o.missionId ?? mission;
    await seedTask(missionId, role);
    const att = await claim(role, missionId);
    if (!att) throw new Error(`no runnable ${role} task could be claimed`);
    att.inherit = o.inherit ?? [];
    if (o.reads?.length) await readReceipts(att, o.reads);
    return att;
  };
  const buildCall = (
    ctx: AttemptContext,
    vector: DependencyVector,
    toolCallIds: string[],
  ): { record: ModelCallRecord; snapshot: ContextSnapshot } => {
    const callId = randomUUID();
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    const snapshot = {
      id: snapshotId,
      contextSchemaVersion: 'v1',
      layout: 'ordinary',
      prefixDigest: digest(['prefix', callId]),
      prefixLength: 10,
      contextDigest: digest(['context', callId]),
      contextLength: 20,
      toolSchemaHash: digest('tools'),
      injected: {
        receipts: vector.map((e) => ({
          id: e.receiptId,
          sourceKey: e.sourceKey,
          sourceRevision: e.sourceRevision,
          contentDigest: digests.get(e.receiptId) ?? digest('unknown'),
        })),
        inheritedArtifacts: [],
        runbooks: [],
        pageSnapshots: [],
        memories: [],
        invalidationEvents: [],
        historyItems: [],
      },
      dependencyVector: vector,
      volatile: { nowIso: now },
    } as unknown as ContextSnapshot;
    const record = {
      id: callId,
      scope: missionScope(ctx.missionId),
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      role: 'worker',
      model: { requested: 'fixture-model', returned: 'fixture-model' },
      provider: { host: 'fixture.local', mode: 'fixture' },
      contextSnapshotId: snapshotId,
      attempts: [
        {
          n: 1,
          startedAt: now,
          headersAt: now,
          firstContentAt: now,
          finishedAt: now,
          httpStatus: 200,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            cachedTokens: 0,
            reasoningTokens: 0,
          },
          finishReason: toolCallIds.length ? 'tool_calls' : 'stop',
          error: null,
          retryAfterMs: null,
          streamed: false,
          outcome: 'recorded',
        },
      ],
      outcome: toolCallIds.length ? 'tool_calls' : 'completed',
      outputDigest: digest(['out', callId]),
      outputDependencyVector: vector,
      toolCalls: toolCallIds.map((t) => ({
        toolCallId: t,
        name: 'propose_action',
        argumentsDigest: digest({ toolCallId: t }),
      })),
      createdAt: now,
    } as unknown as ModelCallRecord;
    return { record, snapshot };
  };
  const calls = new Map<string, string>();
  const modelCallFor: World['modelCallFor'] = async (att, toolCallId) => {
    const k = `${att.ctx.attemptId}:${toolCallId}`;
    const hit = calls.get(k);
    if (hit) return hit;
    const { record, snapshot } = buildCall(att.ctx, vectorOf(att.inherit), [
      toolCallId,
    ]);
    await coordRecordModelCall(deps, att.ctx, { record, snapshot });
    calls.set(k, record.id);
    return record.id;
  };

  const callCtx: World['callCtx'] = async (att, toolCallId) => ({
    ...att.ctx,
    modelCallId: await modelCallFor(att, toolCallId),
    toolCallId,
  });

  // One proposing attempt per tool call (a replayed tool call reuses it, which
  // the idempotency key requires), reading exactly the receipts it cites.
  const attemptByCall = new Map<string, Att>();
  const proposeVia: World['proposeVia'] = async (api, s) => {
    let att = s.att ?? attemptByCall.get(s.toolCallId);
    if (!att) {
      att = await newAttempt(
        s.action === 'flush_cache_namespace'
          ? 'cache_specialist'
          : 'database_specialist',
      );
      attemptByCall.set(s.toolCallId, att);
    }
    const unread = s.cites.filter(
      (l) => l !== 'foreign' && att!.reads.get(l) !== receipts.get(l)?.id,
    );
    if (unread.length) await readReceipts(att, unread);
    const cur = s.payload.key ? await cfg(s.payload.key) : null;
    const payload =
      s.action === 'set_config'
        ? { expectedCurrentValueDigest: digest(cur?.value), ...s.payload }
        : s.payload;
    const input = {
      action: s.action,
      payload,
      rationale: 'g2 acceptance',
      supportingReceiptIds: s.cites.map((l) => receiptId(l)),
      ...(s.extra ?? {}),
    } as unknown as ProposeInput;
    return api.propose(input, (await callCtx(att, s.toolCallId)) as never);
  };
  const propose: World['propose'] = async (s) => {
    if (!primaryApi)
      throw new EntryPointMissing('actions/index.ts', 'not requested');
    return proposeVia(primaryApi, s);
  };

  // ---------------------------------------------------------------------- hooks
  const hitCount = new Map<string, number>();
  const onHook: World['onHook'] = (point, fn) => {
    if (!hooksModule)
      throw new EntryPointMissing('actions/test-hooks.ts', 'not requested');
    hooksModule.setHook(point, async (ctx: Rec) => {
      hitCount.set(point, (hitCount.get(point) ?? 0) + 1);
      await fn(ctx);
    });
  };

  let watcherCache: Rec | null = null;
  const watcherLog: Rec[] = [];
  let controlCache: Rec | null = null;
  const w: World = {
    names: { db: c.db, prefix },
    get actions() {
      if (!primaryApi)
        throw new EntryPointMissing('actions/index.ts', 'not requested');
      return primaryApi;
    },
    mission,
    scope,
    admin,
    app,
    injector,
    verifier,
    redis: c.redis,
    fault,
    watch,
    deps,
    receipts,
    newActions,
    registerMember,
    registerObserved,
    receiptId,
    seedMission,
    seedTask,
    newAttempt,
    claim,
    readReceipts,
    modelCallFor,
    callCtx,
    buildModelCall: (att, toolCallIds) =>
      buildCall(att.ctx, vectorOf(att.inherit), toolCallIds),
    vector: vectorOf,
    async refresh(label) {
      const r = receipts.get(label);
      if (!r) throw new Error(`no receipt labelled ${label}`);
      const head = await w.headReceipt(r.sourceKey);
      if (!head) throw new Error(`no head receipt for ${r.sourceKey}`);
      receipts.set(label, {
        id: head.id,
        sourceKey: r.sourceKey,
        revision: Number(head.source_revision),
      });
      digests.set(head.id, head.content_digest);
    },
    async expireLease(attemptId) {
      await admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '5 seconds' WHERE id=$1",
        [attemptId],
      );
    },
    reap: () => reapExpired(deps),
    async footprint() {
      const n = async (sql: string) =>
        Number((await admin.query(sql)).rows[0].n);
      const intents = await admin.query(
        "SELECT to_regclass('coordinator.action_intents') IS NOT NULL AS ok",
      );
      return {
        outputs: await n(
          'SELECT count(*)::int n FROM coordinator.task_outputs',
        ),
        findings: await n('SELECT count(*)::int n FROM coordinator.findings'),
        tasks: await n('SELECT count(*)::int n FROM coordinator.tasks'),
        attempts: await n(
          'SELECT count(*)::int n FROM coordinator.task_attempts',
        ),
        modelCalls: await n(
          'SELECT count(*)::int n FROM ledger.model_call_records',
        ),
        snapshots: await n(
          'SELECT count(*)::int n FROM ledger.context_snapshots',
        ),
        edges: await n('SELECT count(*)::int n FROM ledger.dependency_edges'),
        recordedInference: await n(
          "SELECT count(*)::int n FROM ledger.inference_attempts WHERE outcome='recorded'",
        ),
        orphanedInference: await n(
          "SELECT count(*)::int n FROM ledger.inference_attempts WHERE outcome='orphaned_fence'",
        ),
        events: await n('SELECT count(*)::int n FROM coordinator.events'),
        intents: intents.rows[0].ok
          ? await n('SELECT count(*)::int n FROM coordinator.action_intents')
          : 0,
      };
    },
    async advance(key, value, o = {}) {
      const pool = o.via === 'owner' ? app : injector;
      const expected = o.expectedVersion ?? (await cfg(key)).version;
      await tx(pool, (cl) =>
        advanceConfig(cl, {
          key,
          value: value as never,
          expectedVersion: expected,
          causedBy: { actor: o.via ?? 'injector' },
        }),
      );
      if (o.register) await registerMember(key);
    },
    async holdRowLock(key, value) {
      const cl = await injector.connect();
      await cl.query('BEGIN');
      const cur = await cfg(key);
      await advanceConfig(cl, {
        key,
        value: value as never,
        expectedVersion: cur.version,
        causedBy: { actor: 'injector' },
      });
      let open = true;
      const close = async (sql: string) => {
        if (!open) return;
        open = false;
        try {
          await cl.query(sql);
        } finally {
          cl.release();
        }
      };
      return {
        commit: () => close('COMMIT'),
        rollback: () => close('ROLLBACK'),
      };
    },
    propose,
    proposeVia,
    async proposeAdmit(s) {
      const i = await propose(s);
      return w.actions.admit(i.id, 'dispatcher-1');
    },
    poolSpec: (
      toolCallId,
      value = 12,
      cites = ['member:db.pool_max', 'health'],
    ) => ({
      action: 'set_config',
      payload: { key: POOL, value },
      cites,
      toolCallId,
    }),
    setSpec: (toolCallId, key, value, cites) => ({
      action: 'set_config',
      payload: { key, value },
      cites,
      toolCallId,
    }),
    flushSpec(toolCallId) {
      // Payload and citations come from the frozen oracle case; the proposer is
      // a cache_specialist (propose_cache_flush is granted to that role only).
      const step = oracleStep('ADM-11d', 'F');
      return {
        action: 'flush_cache_namespace',
        payload: { ...step.payload },
        cites: [...step.cites],
        toolCallId,
      };
    },
    park(point, only) {
      const reached = latch<Rec>();
      const gate = latch();
      let first = true;
      onHook(point, async (ctx) => {
        if (!first || (only && !only(ctx))) return;
        first = false;
        reached.open(ctx);
        await gate.promise;
      });
      return { reached: reached.promise, release: () => gate.open() };
    },
    onHook,
    hits: (p) => hitCount.get(p) ?? 0,
    async clearHooks() {
      hooksModule?.clearHooks();
    },
    cfg,
    async snapshotConfig() {
      const out: Record<string, { value: unknown; version: number }> = {};
      for (const k of DEFAULT_MEMBERS) {
        const x = await cfg(k);
        out[k] = { value: x.value, version: x.version };
      }
      return out;
    },
    async history(key) {
      return (
        await verifier.query(
          'SELECT * FROM checkout.config_versions WHERE key=$1 ORDER BY version',
          [key],
        )
      ).rows;
    },
    async intent(id) {
      const r = await admin.query(
        'SELECT * FROM coordinator.action_intents WHERE id=$1',
        [id],
      );
      return r.rows[0];
    },
    async auths(id) {
      return (
        await admin.query(
          'SELECT * FROM coordinator.authorizations WHERE action_id=$1 ORDER BY decided_at, id',
          [id],
        )
      ).rows;
    },
    async resultReceipts(id) {
      return (
        await admin.query(
          'SELECT * FROM coordinator.result_receipts WHERE action_id=$1 ORDER BY recorded_at, id',
          [id],
        )
      ).rows;
    },
    async actionRows() {
      const r = await verifier.query(
        'SELECT count(*)::int n FROM checkout.config_versions WHERE caused_by_action_id IS NOT NULL',
      );
      return r.rows[0].n;
    },
    async outboxFor(id) {
      return (
        await admin.query(
          "SELECT * FROM coordinator.outbox WHERE payload::text LIKE '%' || $1 || '%'",
          [id],
        )
      ).rows;
    },
    async invalidationCount() {
      return (
        await admin.query(
          'SELECT count(*)::int n FROM ledger.invalidation_events',
        )
      ).rows[0].n;
    },
    async invalidationsFor(sourceKey) {
      return (
        await admin.query(
          'SELECT * FROM ledger.invalidation_events WHERE source_key=$1 ORDER BY created_at, id',
          [sourceKey],
        )
      ).rows;
    },
    async headReceipt(sourceKey) {
      const r = await admin.query(
        // 0002 stores provenance as columns; expose it in the contract's shape
        // (ObservationReceipt.provenance) for the self-write assertions.
        `SELECT r.*, jsonb_build_object('kind', r.provenance_kind,
                  'causedByActionId', r.caused_by_action_id, 'selfWrite', r.self_write) AS provenance
           FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id=r.source_id
          WHERE s.key=$1 AND s.environment='test' ORDER BY r.source_revision DESC LIMIT 1`,
        [sourceKey],
      );
      return r.rows[0] ?? null;
    },
    async anyBlocked() {
      const r = await admin.query(
        `SELECT count(*)::int n FROM pg_stat_activity a
          WHERE a.datname = current_database() AND cardinality(pg_blocking_pids(a.pid)) > 0`,
      );
      return r.rows[0].n > 0;
    },
    async plantCache(n = 3, ns = 'acc-ns-a', tag = 'k') {
      if (!cacheKeyFn)
        throw new EntryPointMissing(
          'actions/dispatch.ts#cacheKey',
          'not requested',
        );
      const keys = Array.from({ length: n }, (_, i) =>
        cacheKeyFn!(prefix, ns, `${tag}${i}`),
      );
      for (const k of keys) await c.redis.set(k, 'v');
      return keys;
    },
    async cacheKeysLeft(keys) {
      return Number(await c.redis.exists(keys));
    },
    async markerPresent(actionId) {
      // actions/dispatch.ts: the effect marker holds the dispatch fence once the
      // effect ran, or 'fence_newer' when the script refused it. Only the first
      // records an applied effect.
      const marker = await c.redis.get(
        (await loadEffectKey())(prefix, actionId),
      );
      return marker !== null && marker !== 'fence_newer';
    },
    async fenceKeys() {
      const out: string[] = [];
      for await (const ks of c.redis.scanIterator({
        MATCH: `${prefix}:fence:*`,
        COUNT: 200,
      }))
        out.push(...ks);
      return out;
    },
    async expireDispatcherLease(id) {
      await admin.query(
        "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id=$1",
        [id],
      );
    },
    async watcher() {
      // watcher/types.ts WatcherDeps. `intents` (SelfWriteIntentPort) is left
      // out on purpose: no production adapter exists yet and the verifier does
      // not supply its own, so self-writes classify as `none` until one lands.
      // The reader refuses: this suite runs no checkout, and watcherPoll only
      // passes controlled sources, which the watcher reads from the authority.
      const factory = await loadWatcher();
      const recovery = createRecovery(deps);
      const control = await w.control();
      return (watcherCache ??= await factory({
        pool: app,
        reader: {
          read: async (key: string) => {
            throw new Error(`g2 polls controlled sources only (asked ${key})`);
          },
        },
        recovery,
        missions: { pause: (id: string) => control.pause(id) },
        intervalMs: 60_000,
        ledger: LEDGER_EVENTS.ledger,
        log: (entry: Rec) => watcherLog.push(entry),
      }));
    },
    async watcherPoll() {
      // Watcher.pass: one pass regardless of leadership, over the controlled
      // sources the ledger knows (members and the collection).
      const wt = await w.watcher();
      const keys = (
        await admin.query(
          "SELECT DISTINCT key FROM ledger.sources WHERE authority = 'controlled'",
        )
      ).rows.map((r) => r.key as string);
      const stats = await wt.pass({ keys });
      if (stats.errors > 0)
        throw new Error(
          `watcher pass reported ${stats.errors} error(s): ${JSON.stringify(watcherLog.slice(-stats.errors))}`,
        );
    },
    async control() {
      const factory = await loadControl();
      return (controlCache ??= await factory(deps));
    },
  };
  return w;
}

// ----------------------------------------------------------- oracle accessors

/** The propose step of a frozen oracle case (payload, citations, role). */
export function oracleStep(caseId: string, intent: string) {
  const c = ADMISSION_CASES.find((x) => x.id === caseId);
  if (!c) throw new Error(`oracle case ${caseId} not found`);
  const step = c.steps.find(
    (s) => s.do === 'propose' && s.intent === intent,
  ) as Extract<AdmissionStep, { do: 'propose' }> | undefined;
  if (!step) throw new Error(`oracle ${caseId} has no propose step ${intent}`);
  return step;
}

export interface OracleCtx {
  intents: Record<string, string>;
  base: Record<string, { value: unknown; version: number }>;
  /** total UNLINK/DEL mentions of the planted keys, and how many keys were planted */
  redis?: { mentions: number; planted: number };
}

/** Checks every field of one frozen-oracle outcome against authoritative state. */
export async function checkOutcome(
  w: World,
  exp: AdmissionOutcome,
  ctx: OracleCtx,
) {
  for (const [label, want] of Object.entries(exp.intents) as [
    string,
    IntentExpectation,
  ][]) {
    const id = ctx.intents[label];
    expect(id, `intent ${label} was not created`).toBeTruthy();
    const row = await w.intent(id);
    expect(row.status, `${label} status`).toBe(want.status);
    if (want.blockReason)
      expect(row.block_reason, `${label} block reason`).toBe(want.blockReason);
    if (want.failureReason)
      expect(row.failure_reason, `${label} failure reason`).toBe(
        want.failureReason,
      );
    if (want.authorizations)
      expect(
        (await w.auths(id)).map((a) => ({
          stage: a.stage,
          decision: a.decision,
          ...(a.block_reason ? { blockReason: a.block_reason } : {}),
        })),
        `${label} authorizations`,
      ).toEqual(want.authorizations);
    if (want.vectorContains) {
      const keys = (row.dependency_vector as { sourceKey: string }[]).map(
        (e) => e.sourceKey,
      );
      expect(keys, `${label} vector`).toEqual(
        expect.arrayContaining(want.vectorContains),
      );
    }
  }
  for (const [key, want] of Object.entries(exp.config)) {
    if (!want) continue;
    const now = await w.cfg(key);
    expect(now.version - ctx.base[key].version, `${key} version delta`).toBe(
      want.versionDelta,
    );
    expect(now.value, `${key} value`).toEqual(
      want.value === 'unchanged' ? ctx.base[key].value : want.value,
    );
  }
  expect(await w.actionRows(), 'action-caused config rows').toBe(
    exp.actionRows,
  );
  if (exp.resultReceipts !== undefined) {
    let total = 0;
    for (const id of Object.values(ctx.intents))
      total += (await w.resultReceipts(id)).length;
    expect(total, 'result receipts').toBe(exp.resultReceipts);
  }
  if (exp.redisEffects !== undefined && ctx.redis)
    expect(
      ctx.redis.mentions,
      'UNLINK/DEL mentions of the planted keys (one effect unlinks each key once)',
    ).toBe(exp.redisEffects * ctx.redis.planted);
  if (exp.neverValue) {
    const hist = await w.history(exp.neverValue.key);
    expect(
      hist.some((h) => h.value === exp.neverValue!.value),
      'a forbidden value must never appear in the history',
    ).toBe(false);
  }
}

// ---------------------------------------------------------------- race helpers

/**
 * Parks `commit` at a barrier, runs `during` concurrently, and never hangs: if
 * `during` waits on a lock the parked commit holds (the barrier sits after the
 * commit's locks) that is observed through pg_blocking_pids, the barrier is
 * released and both outcomes are returned. The caller asserts on authoritative
 * state, which tells who serialized first.
 */
export async function parkedRace(
  w: World,
  point: HookPoint,
  commit: () => Promise<unknown>,
  during: () => Promise<unknown>,
) {
  const parked = w.park(point);
  const commitP = commit().then(
    (v) => ({ ok: v as Rec }),
    (e) => ({ err: e as unknown }),
  );
  await withTimeout(parked.reached, 20_000, `${point} was never reached`);
  const duringP = during().then(
    (v) => ({ ok: v as unknown }),
    (e) => ({ err: e as unknown }),
  );
  let blockedOnCommit = false;
  for (let i = 0; i < 40; i += 1) {
    if (await isSettled(duringP, 50)) break;
    if (await w.anyBlocked()) {
      blockedOnCommit = true;
      break;
    }
  }
  parked.release();
  const [commitResult, duringResult] = await withTimeout(
    Promise.all([commitP, duringP]),
    30_000,
    `race at ${point} did not complete`,
  );
  return { commitResult, duringResult, blockedOnCommit };
}

/** Commit outcome of an intent that the closure may already have blocked. */
export async function commitSettled(w: World, id: string, fence: number) {
  return w.actions.commit(id as never, fence).then(
    (i) => ({ returned: i as Rec }),
    (e) => ({ threw: e as unknown }),
  );
}

export async function authSummary(w: World, id: string) {
  return (await w.auths(id)).map((a) => ({
    stage: a.stage as string,
    decision: a.decision as string,
    blockReason: (a.block_reason ?? null) as string | null,
  }));
}
