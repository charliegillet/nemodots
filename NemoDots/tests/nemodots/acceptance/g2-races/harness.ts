// Gate 2 (admission and races) harness. Port block: checkout 4640, app 4641
// (reserved; this suite drives services in-process and opens no HTTP port).
// Databases are named acc2_<rand> on the NemoDots PostgreSQL (55432), Redis
// uses db index 3 on 56379 with a random key prefix. Expected values live in
// the test files and the frozen oracle, never in production logic.
//
// Production entry points are resolved at run time; a missing module or
// export FAILS the test with "ENTRY POINT MISSING" (never skipped). The
// complete list is in ./README.md.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from 'redis';
import { barrier, latch, withTimeout } from '../../helpers/barrier.js';
import {
  stackRoleUrls,
  withDatabase,
} from '../../helpers/test-db.js';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import type {
  ActionAdmissionPort,
  ActionIntent,
  AttemptContext,
  ProposeInput,
} from '../../../../src/server/nemodots/contracts/index.js';
import { SETUP_CONFIG } from '../oracle/admission.js';

process.env.NEMODOTS_TEST_HOOKS = '1';

export const PORTS = { checkout: 4640, app: 4641 } as const;
export const DB_PREFIX = 'acc2_';
export const REDIS_DB = 3;
export const REDIS_PORT = 56379;
export { barrier, latch, withTimeout };

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

export async function entry<T = unknown>(
  file: string,
  name?: string,
): Promise<T> {
  const abs = resolve(APP_ROOT, 'src/server/nemodots', file);
  const label = `src/server/nemodots/${file}${name ? `#${name}` : ''}`;
  if (!existsSync(abs)) throw new EntryPointMissing(label, 'file does not exist');
  let mod: Rec;
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(abs).href);
  } catch (e) {
    throw new EntryPointMissing(label, `failed to load: ${(e as Error).message}`);
  }
  if (!name) return mod as T;
  if (typeof mod[name] === 'undefined')
    throw new EntryPointMissing(label, 'no such export');
  return mod[name] as T;
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

export const POOL = 'db.pool_max';
export const TIMEOUT = 'db.statement_timeout_ms';
export const NS = 'cache.namespace';

export type HookPoint =
  | 'after_preliminary_read'
  | 'before_lock'
  | 'after_lock_before_commit'
  | 'after_commit_before_dispatch'
  | 'after_effect_before_record';

export interface Parked {
  reached: Promise<Rec>;
  release(): void;
}

export interface ProposeSpec {
  action: 'set_config' | 'flush_cache_namespace';
  payload: Rec;
  /** receipt labels: member:<key>, health, redis, foreign */
  cites: string[];
  toolCallId: string;
  attempt?: AttemptCtx;
}
export type AttemptCtx = AttemptContext & { modelCallId: string };

export interface World {
  names: { db: string; prefix: string };
  actions: ActionAdmissionPort & {
    reclaim(id: string, dispatcher: string): Promise<ActionIntent>;
    compensate(id: string, ctx: AttemptCtx): Promise<ActionIntent>;
  };
  attempt: AttemptCtx;
  mission: string;
  admin: pg.Pool;
  redis: ReturnType<typeof createClient>;
  redisMode: { current: 'ok' | 'drop_reply' | 'fail_before' };
  // setup / mutation
  seedAttempt(role?: string): Promise<AttemptCtx>;
  receipts: Map<string, string>;
  registerMember(key: string): Promise<string>;
  registerObserved(label: 'health' | 'redis', value?: unknown): Promise<string>;
  advance(
    key: string,
    value: unknown,
    o?: { actor?: 'injector' | 'owner'; register?: boolean; expectedVersion?: number },
  ): Promise<void>;
  holdRowLock(
    key: string,
    value: unknown,
  ): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }>;
  // actions
  propose(spec: ProposeSpec): Promise<ActionIntent>;
  proposeAdmit(spec: ProposeSpec): Promise<ActionIntent>;
  poolSpec(toolCallId: string, value?: number, cites?: string[]): ProposeSpec;
  flushSpec(toolCallId: string): ProposeSpec;
  // hooks
  park(point: HookPoint, only?: (ctx: Rec) => boolean): Parked;
  onHook(point: HookPoint, fn: (ctx: Rec) => Promise<void> | void): void;
  clearHooks(): Promise<void>;
  // inspection (verifier-owned SQL; no production reads)
  cfg(key: string): Promise<{ value: unknown; version: number; causedBy: string | null }>;
  history(key: string): Promise<Rec[]>;
  intent(id: string): Promise<Rec>;
  auths(id: string): Promise<Rec[]>;
  resultReceipts(id: string): Promise<Rec[]>;
  actionRows(): Promise<number>;
  outboxFor(id: string): Promise<Rec[]>;
  invalidationCount(): Promise<number>;
  currentReceipt(label: string): Promise<Rec | null>;
  // redis
  plantCache(n?: number, ns?: string): Promise<string[]>;
  cacheKeysLeft(keys: string[]): Promise<number>;
  markerPresent(actionId: string): Promise<boolean>;
  // lease helpers
  expireDispatcherLease(id: string): Promise<void>;
  expireAuthorLease(a: AttemptCtx): Promise<void>;
  completeAuthor(a: AttemptCtx): Promise<void>;
  cancelMission(): Promise<void>;
  staleOps(a: AttemptCtx): Promise<Record<string, () => Promise<unknown>>>;
  watcherPoll(): Promise<void>;
}

export async function withWorld<T>(fn: (w: World) => Promise<T>): Promise<T> {
  const base = stackRoleUrls();
  const db = `${DB_PREFIX}${randomBytes(6).toString('hex')}`;
  const adminBoot = new pg.Client({ connectionString: base.admin });
  await adminBoot.connect();
  const pools: pg.Pool[] = [];
  const mk = (role: keyof typeof base) => {
    const p = new pg.Pool({
      connectionString: withDatabase(base[role], db),
      max: 8,
      application_name: `acc2-${role}`,
    });
    pools.push(p);
    return p;
  };
  const redisUrl = `redis://127.0.0.1:${REDIS_PORT}/${REDIS_DB}`;
  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  const prefix = `acc2:${randomBytes(5).toString('hex')}`;
  try {
    await adminBoot.query(`CREATE DATABASE ${db} OWNER nemodots_admin`);
    await migrate({ connectionString: withDatabase(base.admin, db) });
    await redis.connect();
    const admin = mk('admin');
    const app = mk('app');
    const injector = mk('injector');
    const verifier = mk('verifier');
    const world = await build({
      db, prefix, admin, app, injector, verifier, redis,
    });
    try {
      return await fn(world);
    } finally {
      await world.clearHooks().catch(() => {});
    }
  } finally {
    for (const p of pools) await p.end().catch(() => {});
    try {
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 }))
        if (keys.length) await redis.unlink(keys);
    } catch {
      /* best effort, own prefix only */
    }
    redis.destroy();
    await adminBoot
      .query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
      .catch(() => {});
    await adminBoot.end();
  }
}

async function build(c: {
  db: string; prefix: string; admin: pg.Pool; app: pg.Pool;
  injector: pg.Pool; verifier: pg.Pool; redis: ReturnType<typeof createClient>;
}): Promise<World> {
  const { admin, app, injector, verifier, prefix } = c;
  const redisMode = { current: 'ok' as 'ok' | 'drop_reply' | 'fail_before' };
  // A real Redis client whose script calls can lose their reply AFTER the
  // real effect (drop_reply) or fail before reaching Redis (fail_before).
  const flaky = new Proxy(c.redis as Rec, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      const scripted = /^(eval|evalsha|evalRo|evalShaRo|EVAL|EVALSHA|sendCommand|functionCall|fCall)/i.test(String(prop));
      if (!scripted) return v.bind(target);
      return async (...args: unknown[]) => {
        if (redisMode.current === 'fail_before')
          throw new Error('ECONNREFUSED (injected before script)');
        const out = await v.apply(target, args);
        if (redisMode.current === 'drop_reply')
          throw new Error('ECONNRESET (injected: reply lost after effect)');
        void recv;
        return out;
      };
    },
  });

  const createActions = await entry<(deps: Rec) => Rec>(
    'actions/index.ts',
    'createActionAdmission',
  );
  const hooks = await entry<Rec>('actions/test-hooks.ts');
  const support = await entry<Rec>('coordinator/test-support.ts');
  const advanceConfig = await entry<(cl: pg.PoolClient, a: Rec) => Promise<unknown>>(
    'sandbox/version-authority.ts',
    'advanceConfig',
  );
  const registerObservation = await entry<(cl: pg.PoolClient, a: Rec) => Promise<Rec>>(
    'ledger/receipts.ts',
    'registerObservation',
  );
  const cacheKey = await entry<(p: string, ns: string, n: string) => string>(
    'actions/dispatch.ts',
    'cacheKey',
  );
  const createWatcher = await entry<(d: Rec) => Promise<Rec> | Rec>(
    'watcher/watcher.ts',
    'createWatcher',
  );

  const actions = createActions({
    pool: app, redis: flaky, redisPrefix: prefix, dispatcherLeaseMs: 30_000,
  }) as World['actions'];
  const watcher = await createWatcher({ pool: app, redis: flaky, redisPrefix: prefix });

  const seed = async (role = 'database_specialist', missionId?: string) =>
    (await support.seedRunningAttempt(app, { role, missionId })) as AttemptCtx;
  const attempt = await seed('database_specialist');
  const mission = attempt.missionId as string;
  const scope = {
    ownerId: process.env.OWNER_ID ?? 'acc2-owner',
    missionId: mission, spaceId: null, environment: 'test', resource: 'checkout',
  };
  const receipts = new Map<string, string>();

  const tx = async <R>(pool: pg.Pool, f: (cl: pg.PoolClient) => Promise<R>) => {
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      const r = await f(cl);
      await cl.query('COMMIT');
      return r;
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cl.release();
    }
  };

  const cfg: World['cfg'] = async (key) => {
    const r = await verifier.query(
      'SELECT value, version, caused_by_action_id FROM checkout.config_entries WHERE key=$1',
      [key],
    );
    if (!r.rows[0]) throw new Error(`config key ${key} not seeded by migration 0004`);
    return { value: r.rows[0].value, version: Number(r.rows[0].version), causedBy: r.rows[0].caused_by_action_id };
  };

  const registerMember: World['registerMember'] = async (key) => {
    const cur = await cfg(key);
    const r = await tx(app, (cl) =>
      registerObservation(cl, {
        source: { key: `checkout.config/${key}`, sourceType: 'controlled_config', authority: 'controlled', scope },
        trust: 'controlled_authority',
        normalizedValue: { value: cur.value },
        rawRef: null,
        provenance: { kind: 'watcher', toolCallId: null, modelCallId: null, attemptId: null, causedByActionId: null, selfWrite: 'none' },
        negative: null,
        expiresAt: null,
      }),
    );
    receipts.set(`member:${key}`, r.id);
    return r.id;
  };
  const registerObserved: World['registerObserved'] = async (label, value) => {
    const key = label === 'health' ? 'checkout.health' : 'redis.stats';
    const r = await tx(app, (cl) =>
      registerObservation(cl, {
        source: { key, sourceType: label === 'health' ? 'observed_endpoint' : 'observed_store', authority: 'observed', scope },
        trust: 'observed_tool',
        normalizedValue: value ?? { status: 'ok' },
        rawRef: null,
        provenance: { kind: 'watcher', toolCallId: null, modelCallId: null, attemptId: null, causedByActionId: null, selfWrite: 'none' },
        negative: null,
        expiresAt: null,
      }),
    );
    receipts.set(label, r.id);
    return r.id;
  };

  // Test-local setup values are installed through the version authority.
  for (const [k, v] of Object.entries(SETUP_CONFIG)) {
    const cur = await cfg(k);
    await tx(app, (cl) =>
      advanceConfig(cl, { key: k, value: v, expectedVersion: cur.version, causedBy: { actor: 'owner' } }),
    );
  }
  for (const k of Object.keys(SETUP_CONFIG)) await registerMember(k);
  await registerObserved('health');
  await registerObserved('redis');
  // a valid receipt that belongs to a different mission (scope isolation)
  const other = await seed('database_specialist');
  const foreign = await tx(app, (cl) =>
    registerObservation(cl, {
      source: { key: 'checkout.health', sourceType: 'observed_endpoint', authority: 'observed', scope: { ...scope, missionId: other.missionId } },
      trust: 'observed_tool', normalizedValue: { status: 'ok' }, rawRef: null,
      provenance: { kind: 'watcher', toolCallId: null, modelCallId: null, attemptId: null, causedByActionId: null, selfWrite: 'none' },
      negative: null, expiresAt: null,
    }),
  );
  receipts.set('foreign', foreign.id);

  const advance: World['advance'] = async (key, value, o = {}) => {
    const pool = o.actor === 'owner' ? app : injector;
    const expected = o.expectedVersion ?? (await cfg(key)).version;
    await tx(pool, (cl) =>
      advanceConfig(cl, { key, value, expectedVersion: expected, causedBy: { actor: o.actor ?? 'injector' } }),
    );
    if (o.register) await registerMember(key);
  };

  const propose: World['propose'] = async (s) => {
    const cur = s.payload.key ? await cfg(s.payload.key) : null;
    const payload = s.action === 'set_config'
      ? { expectedCurrentValueDigest: digest(cur?.value), ...s.payload }
      : s.payload;
    const input = {
      action: s.action, payload, rationale: 'g2 acceptance',
      supportingReceiptIds: s.cites.map((l) => {
        const id = receipts.get(l);
        if (!id) throw new Error(`no receipt labelled ${l}`);
        return id;
      }),
    } as ProposeInput;
    const a = s.attempt ?? attempt;
    return actions.propose(input, { ...a, toolCallId: s.toolCallId });
  };

  const active: { point: HookPoint; fn: (ctx: Rec) => Promise<void> | void }[] = [];
  const onHook: World['onHook'] = (point, fn) => {
    active.push({ point, fn });
    hooks.setHook(point, async (ctx: Rec) => fn(ctx));
  };

  const w: World = {
    names: { db: c.db, prefix },
    actions, attempt, mission, admin, redis: c.redis, redisMode, receipts,
    seedAttempt: seed, registerMember, registerObserved, advance, propose,
    async holdRowLock(key, value) {
      const cl = await injector.connect();
      await cl.query('BEGIN');
      const cur = await cfg(key);
      await advanceConfig(cl, { key, value, expectedVersion: cur.version, causedBy: { actor: 'injector' } });
      let open = true;
      const close = async (sql: string) => {
        if (!open) return;
        open = false;
        try { await cl.query(sql); } finally { cl.release(); }
      };
      return { commit: () => close('COMMIT'), rollback: () => close('ROLLBACK') };
    },
    async proposeAdmit(s) {
      const i = await propose(s);
      return actions.admit(i.id, 'dispatcher-1');
    },
    poolSpec: (toolCallId, value = 12, cites = ['member:db.pool_max', 'health']) => ({
      action: 'set_config', payload: { key: POOL, value }, cites, toolCallId,
    }),
    flushSpec: (toolCallId) => ({
      action: 'flush_cache_namespace',
      payload: { namespace: 'acc-ns-a', reason: 'acceptance flush' },
      cites: ['member:cache.namespace', 'redis'], toolCallId,
    }),
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
    async clearHooks() {
      active.length = 0;
      hooks.clearHooks();
    },
    cfg,
    async history(key) {
      return (await verifier.query(
        'SELECT * FROM checkout.config_versions WHERE key=$1 ORDER BY version', [key])).rows;
    },
    async intent(id) {
      const r = await admin.query('SELECT * FROM coordinator.action_intents WHERE id=$1', [id]);
      return r.rows[0];
    },
    async auths(id) {
      return (await admin.query('SELECT * FROM coordinator.authorizations WHERE action_id=$1 ORDER BY decided_at, id', [id])).rows;
    },
    async resultReceipts(id) {
      return (await admin.query('SELECT * FROM coordinator.result_receipts WHERE action_id=$1 ORDER BY recorded_at, id', [id])).rows;
    },
    async actionRows() {
      const r = await verifier.query('SELECT count(*)::int n FROM checkout.config_versions WHERE caused_by_action_id IS NOT NULL');
      return r.rows[0].n;
    },
    async outboxFor(id) {
      return (await admin.query("SELECT * FROM coordinator.outbox WHERE payload::text LIKE '%' || $1 || '%'", [id])).rows;
    },
    async invalidationCount() {
      return (await admin.query('SELECT count(*)::int n FROM ledger.invalidation_events')).rows[0].n;
    },
    async currentReceipt(label) {
      const id = receipts.get(label);
      if (!id) return null;
      const r = await admin.query('SELECT * FROM ledger.observation_receipts WHERE id=$1', [id]);
      return r.rows[0] ?? null;
    },
    async plantCache(n = 3, ns = 'acc-ns-a') {
      const keys = Array.from({ length: n }, (_, i) => cacheKey(prefix, ns, `k${i}`));
      for (const k of keys) await c.redis.set(k, 'v');
      return keys;
    },
    async cacheKeysLeft(keys) {
      return Number(await c.redis.exists(keys));
    },
    async markerPresent(actionId) {
      for await (const ks of c.redis.scanIterator({ MATCH: `${prefix}:*${actionId}*`, COUNT: 200 }))
        if (ks.length) return true;
      return false;
    },
    async expireDispatcherLease(id) {
      await admin.query("UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    },
    expireAuthorLease: (a) => support.expireAttemptLease(app, a.attemptId),
    completeAuthor: (a) => support.completeAttempt(app, a.attemptId),
    cancelMission: () => support.cancelMission(app, mission),
    staleOps: (a) => support.staleOps(app, a),
    async watcherPoll() {
      await watcher.pollOnce();
    },
  };
  return w;
}

/** Asserts that nothing but the already-recorded rows exist for an intent. */
export async function authSummary(w: World, id: string) {
  return (await w.auths(id)).map((a) => ({
    stage: a.stage as string,
    decision: a.decision as string,
    blockReason: (a.block_reason ?? null) as string | null,
  }));
}
