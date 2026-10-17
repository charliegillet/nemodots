// Gate 1 driver: executes the frozen LedgerOp sequences (../oracle/ledger.ts)
// against the production ledger on real PostgreSQL, and reads results back
// from the database with SQL written here, never from production return
// values, so a wrong return value cannot hide a wrong row.
//
// PRODUCTION SIGNATURES THIS DRIVER ASSUMES (the verifier's dependency list;
// each is a single call site below, marked BIND):
//   ledger/receipts.ts#registerObservation(client in an open txn, input) -> Promise<RegisterResult>
//        input = { scope: Scope, sourceKey, normalizedValue?, claimedRevision?,
//                  claimedDigest?, provenance: { kind:'watcher', toolCallId:null,
//                  modelCallId:null, attemptId:null, causedByActionId:null,
//                  selfWrite:'none' } }
//        runs its own transaction, throws a typed error whose code/reason/message
//        carries one of the oracle error names (KNOWN_ERRORS).
//   ledger/support.ts#assertCurrent(client: pg.PoolClient, receiptIds, { lockMode, freshness })
//        (also accepted as a method of an exported SupportValidator/supportValidator).
//   sandbox/version-authority.ts#advanceConfig(client: pg.PoolClient,
//        { key, value, expectedVersion, causedBy: { actor, actionId: null },
//          insertIfMissing?, deleteKey? })
//   migration 0004: checkout.config_entries(key, value jsonb, version),
//        checkout.config_collection(version).
// Table/column names are resolved by introspection with the candidate lists
// below; a missing table or column fails with SCHEMA BINDING, naming it.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LEDGER_CASES } from '../oracle/ledger.js';
import type { LedgerCase, LedgerOp } from '../oracle/types.js';
import { entry, insertRow, pool, Schema, type AccDb } from './harness.js';

export const KNOWN_ERRORS = [
  'immutable',
  'revision_mismatch',
  'digest_mismatch',
  'too_large',
  'invalid_source_key',
  'stale_observation_rejected',
  'stale_version',
  'stale_pending_observation',
  'receipt_not_supported',
  'evidence_too_old',
  'closure_cap_exceeded',
  'scheduling_cycle',
  'edge_order',
  'edge_cycle',
] as const;

export const OWNER_ID = 'acc1-owner';
export type Env = 'dev' | 'test' | 'eval';

/** Maps a thrown value to an oracle error name, or "unclassified:<name>: <message>". */
export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return `unclassified:${String(error)}`;
  const e = error as Error & Record<string, unknown>;
  for (const field of ['code', 'reason', 'kind', 'blockReason', 'errorCode', 'name']) {
    const v = e[field];
    if (typeof v === 'string') {
      const snake = v.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      if ((KNOWN_ERRORS as readonly string[]).includes(snake)) return snake;
    }
  }
  const text = `${e.name} ${e.message}`.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  for (const known of KNOWN_ERRORS) if (text.includes(known)) return known;
  if (/immutable|not allowed|read-only|may not be (updated|modified)/i.test(e.message)) return 'immutable';
  return `unclassified:${e.name}: ${e.message.slice(0, 160)}`;
}

export const REC = 'ledger.observation_receipts';
export const SRC = 'ledger.sources';
export const CONF = 'ledger.receipt_confirmations';
export const TRANS = 'ledger.receipt_transitions';
export const CFG = 'checkout.config_entries';
export const COLL = 'checkout.config_collection';
export const FIND = 'coordinator.findings';

export interface Recv {
  id: string;
  revision: number;
  status: string;
  trust: string | null;
  digest: string | null;
}

export interface OpResult {
  ok: boolean;
  error?: string;
  /** Receipt rows for the op's source before/after, confirmations before/after. */
  receiptDelta?: number;
  confirmationDelta?: number;
  /** Current (supported, highest revision) receipt of the op's source after the op. */
  current?: Recv | null;
  baseRevision?: number;
}

export class World {
  readonly app: pg.Pool;
  readonly admin: pg.Pool;
  readonly injector: pg.Pool;
  readonly schema: Schema;
  readonly labels = new Map<string, string>();
  readonly labelEnv = new Map<string, { env: Env; key: string }>();
  bases: { entries: Map<string, number>; collection: number } | null = null;
  readonly results: OpResult[] = [];
  private seeded = false;
  private obsReceiptsAtStart = 0;
  private findingsAtStart = 0;
  readonly missionId = randomUUID();

  constructor(readonly db: AccDb) {
    this.app = pool(db.urls.app);
    this.admin = pool(db.urls.admin);
    this.injector = pool(db.urls.injector);
    this.schema = new Schema(this.admin);
  }

  async close() {
    await Promise.all([this.app.end(), this.admin.end(), this.injector.end()]);
  }

  scope(env: Env) {
    return { ownerId: OWNER_ID, missionId: this.missionId, spaceId: null, environment: env, resource: 'checkout' };
  }

  // ------------------------------------------------------------ SQL readers

  private async srcCols() {
    return {
      id: await this.schema.need(SRC, ['id']),
      env: await this.schema.need(SRC, ['environment', 'env']),
      key: await this.schema.need(SRC, ['key', 'source_key']),
    };
  }

  private async recCols() {
    return {
      id: await this.schema.need(REC, ['id']),
      source: await this.schema.need(REC, ['source_id']),
      revision: await this.schema.need(REC, ['source_revision']),
      status: await this.schema.need(REC, ['status']),
      digest: await this.schema.pick(REC, ['content_digest']),
      trust: await this.schema.pick(REC, ['trust']),
      value: await this.schema.pick(REC, ['normalized_value']),
    };
  }

  async receiptsOf(env: Env, key: string): Promise<Recv[]> {
    const s = await this.srcCols();
    const r = await this.recCols();
    const rows = await this.admin.query(
      `SELECT r."${r.id}" AS id, r."${r.revision}" AS revision, r."${r.status}" AS status,
              ${r.trust ? `r."${r.trust}"` : 'NULL'} AS trust, ${r.digest ? `r."${r.digest}"` : 'NULL'} AS digest
         FROM ${REC} r JOIN ${SRC} s ON s."${s.id}" = r."${r.source}"
        WHERE s."${s.env}" = $1 AND s."${s.key}" = $2 ORDER BY r."${r.revision}", r."${r.id}"`,
      [env, key],
    );
    return rows.rows.map((x) => ({ id: x.id, revision: Number(x.revision), status: x.status, trust: x.trust, digest: x.digest }));
  }

  async currentOf(env: Env, key: string): Promise<Recv | null> {
    const all = await this.receiptsOf(env, key);
    const supported = all.filter((x) => x.status === 'supported');
    return supported.length ? supported[supported.length - 1] : null;
  }

  async receiptById(id: string): Promise<Recv | null> {
    const r = await this.recCols();
    const rows = await this.admin.query(
      `SELECT "${r.id}" AS id, "${r.revision}" AS revision, "${r.status}" AS status,
              ${r.trust ? `"${r.trust}"` : 'NULL'} AS trust, ${r.digest ? `"${r.digest}"` : 'NULL'} AS digest
         FROM ${REC} WHERE "${r.id}" = $1`,
      [id],
    );
    const x = rows.rows[0];
    return x ? { id: x.id, revision: Number(x.revision), status: x.status, trust: x.trust, digest: x.digest } : null;
  }

  async confirmationCount(receiptId: string): Promise<number> {
    const rc = await this.schema.need(CONF, ['receipt_id']);
    const r = await this.admin.query(`SELECT count(*)::int AS n FROM ${CONF} WHERE "${rc}" = $1`, [receiptId]);
    return r.rows[0].n;
  }

  async totalReceipts(): Promise<number> {
    const r = await this.admin.query(`SELECT count(*)::int AS n FROM ${REC}`);
    return r.rows[0].n;
  }

  async distinctSources(): Promise<number> {
    const r = await this.admin.query(`SELECT count(*)::int AS n FROM ${SRC}`);
    return r.rows[0].n;
  }

  async findingsCount(trust?: string): Promise<number> {
    if (!(await this.schema.exists(FIND))) return 0;
    const col = await this.schema.pick(FIND, ['trust']);
    const r = await this.admin.query(
      trust && col ? `SELECT count(*)::int AS n FROM ${FIND} WHERE "${col}" = $1` : `SELECT count(*)::int AS n FROM ${FIND}`,
      trust && col ? [trust] : [],
    );
    return r.rows[0].n;
  }

  async configVersion(key: string): Promise<number | null> {
    const r = await this.admin.query(`SELECT version FROM ${CFG} WHERE key = $1`, [key]);
    return r.rowCount ? Number(r.rows[0].version) : null;
  }

  async configValue(key: string): Promise<unknown> {
    const r = await this.admin.query(`SELECT value FROM ${CFG} WHERE key = $1`, [key]);
    return r.rowCount ? r.rows[0].value : undefined;
  }

  async collectionVersion(): Promise<number> {
    const r = await this.admin.query(`SELECT version FROM ${COLL} LIMIT 1`);
    return r.rowCount ? Number(r.rows[0].version) : 0;
  }

  /** Authority version of a controlled source key (member or collection). */
  async authorityVersion(sourceKey: string): Promise<number> {
    if (sourceKey === 'checkout.config') return this.collectionVersion();
    const m = /^checkout\.config\/(.+)$/.exec(sourceKey);
    if (!m) throw new Error(`not a controlled source: ${sourceKey}`);
    return (await this.configVersion(m[1])) ?? 0;
  }

  isControlled(sourceKey: string) {
    return sourceKey === 'checkout.config' || sourceKey.startsWith('checkout.config/');
  }

  // --------------------------------------------------------------- seeding

  async seedConfig(key: string, value: unknown) {
    if (!(await this.schema.exists(CFG)) || !(await this.schema.exists(COLL))) {
      throw new Error(`ENTRY POINT MISSING: migration 0004_checkout (${CFG}, ${COLL}) is not present in the migrated database`);
    }
    // Setup, not behaviour under test: plain SQL as the table owner, mirroring the
    // authority's own rules (a new key bumps the membership collection once).
    const hasCollection = (await this.admin.query(`SELECT 1 FROM ${COLL} LIMIT 1`)).rowCount;
    if (!hasCollection) await insertRow(this.admin, this.schema, COLL, { version: 1 });
    const existing = await this.configVersion(key);
    if (existing === null) {
      await this.admin.query(`INSERT INTO ${CFG} (key, value, version, caused_by_actor) VALUES ($1, $2::jsonb, 1, 'seed')`, [key, JSON.stringify(value)]);
      await this.admin.query(`UPDATE ${COLL} SET version = version + 1`);
    } else {
      await this.admin.query(`UPDATE ${CFG} SET value = $2::jsonb, version = version + 1, caused_by_actor = 'seed' WHERE key = $1`, [key, JSON.stringify(value)]);
    }
  }

  async snapshotBases() {
    if (this.bases) return;
    const entries = new Map<string, number>();
    if (await this.schema.exists(CFG)) {
      const r = await this.admin.query(`SELECT key, version FROM ${CFG}`);
      for (const row of r.rows) entries.set(row.key, Number(row.version));
    }
    this.bases = { entries, collection: (await this.schema.exists(COLL)) ? await this.collectionVersion() : 0 };
    this.obsReceiptsAtStart = await this.totalReceipts();
    this.findingsAtStart = await this.findingsCount();
  }

  baseOf(sourceKey: string): number {
    if (!this.bases) return 0;
    if (sourceKey === 'checkout.config') return this.bases.collection;
    const m = /^checkout\.config\/(.+)$/.exec(sourceKey);
    return m ? (this.bases.entries.get(m[1]) ?? 0) : 0;
  }

  newReceiptsSinceSeed() {
    return this.totalReceipts().then((n) => n - this.obsReceiptsAtStart);
  }
  newFindingsSinceSeed() {
    return this.findingsCount('model_claim').then((n) => n - this.findingsAtStart);
  }

  // ------------------------------------------------------------- operations

  async advance(op: Extract<LedgerOp, { op: 'advance_config' }>) {
    const advanceConfig = await entry<
      (client: pg.PoolClient, input: Record<string, unknown>) => Promise<unknown>
    >('sandbox/version-authority.ts', ['advanceConfig']);
    const via = op.actor === 'injector' ? this.injector : this.app;
    const client = await via.connect();
    try {
      const current = (await this.configVersion(op.key)) ?? 0;
      await client.query('BEGIN');
      try {
        // BIND: advanceConfig signature (see header).
        await advanceConfig(client, {
          key: op.key,
          // The authority refuses a value or insertIfMissing together with deleteKey.
          ...(op.deleteKey ? { deleteKey: true } : { value: op.value, ...(op.insertIfMissing ? { insertIfMissing: true } : {}) }),
          expectedVersion: current,
          causedBy: { actor: op.actor, actionId: null },
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private payloadFor(op: Extract<LedgerOp, { op: 'register' }>): unknown {
    if (op.syntheticBytes !== undefined) {
      // canonical JSON of {"pad":"..."} is 10 bytes of framing + the pad.
      return { pad: 'x'.repeat(Math.max(0, op.syntheticBytes - 10)) };
    }
    return op.normalizedValue;
  }

  /** SourceRef for a source key (CONTRACTS 1): the type follows the key family. */
  sourceRef(key: string, env: Env) {
    const family = key === 'checkout.config' ? 'collection' : key.startsWith('checkout.config/') ? 'member' : key;
    const sourceType =
      family === 'collection'
        ? 'controlled_collection'
        : family === 'member'
          ? 'controlled_config'
          : key === 'redis.stats'
            ? 'observed_store'
            : key === 'checkout.acceptance'
              ? 'probe'
              : key.startsWith('runbook/')
                ? 'runbook'
                : key.startsWith('opendots.page/')
                  ? 'page_snapshot'
                  : key.startsWith('opendots.memory/')
                    ? 'memory_snapshot'
                    : 'observed_endpoint';
    const authority = sourceType.startsWith('controlled') ? 'controlled' : 'observed';
    return { key, sourceType, authority, scope: this.scope(env) };
  }

  /** The value a watcher reads from the controlled authority (ARCHITECTURE 9.4): member {key,value,version}, collection {keys,collectionVersion}. */
  async controlledValue(key: string): Promise<unknown> {
    if (key === 'checkout.config') {
      const keys = await this.admin.query(`SELECT key FROM ${CFG} ORDER BY key`);
      return { keys: keys.rows.map((r) => r.key), collectionVersion: await this.collectionVersion() };
    }
    const member = key.slice('checkout.config/'.length);
    const version = await this.configVersion(member);
    if (version === null) return { key: member, value: null, version: 0 };
    return { key: member, value: await this.configValue(member), version };
  }

  /** Runs fn on a connection inside a transaction owned here (the ledger requires the caller's). */
  async inTx<T>(fn: (client: pg.PoolClient) => Promise<T>, via: pg.Pool = this.app): Promise<T> {
    const client = await via.connect();
    try {
      await client.query('BEGIN');
      try {
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async registerInput(op: Extract<LedgerOp, { op: 'register' }>): Promise<Record<string, unknown>> {
    const env = op.environment ?? 'test';
    const controlled = this.isControlled(op.sourceKey);
    const base = controlled ? this.baseOf(op.sourceKey) : 0;
    const input: Record<string, unknown> = {
      source: this.sourceRef(op.sourceKey, env),
      normalizedValue: controlled ? await this.controlledValue(op.sourceKey) : (this.payloadFor(op) ?? {}),
      provenance: { kind: 'watcher' },
    };
    const claimed: Record<string, unknown> = {};
    if (op.claimRevision !== undefined) claimed.sourceRevision = base + op.claimRevision;
    if (op.claimDigestMismatch) claimed.contentDigest = 'f'.repeat(64);
    if (Object.keys(claimed).length) input.claimed = claimed;
    return input;
  }

  async register(op: Extract<LedgerOp, { op: 'register' }>): Promise<OpResult> {
    // BIND: registerObservation(client in an open transaction, { source, normalizedValue, provenance, claimed? }).
    const registerObservation = await entry<(client: pg.PoolClient, input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>>(
      'ledger/receipts.ts',
      ['registerObservation'],
    );
    const env = op.environment ?? 'test';
    const before = await this.receiptsOf(env, op.sourceKey);
    const beforeCur = await this.currentOf(env, op.sourceKey);
    const confBefore = beforeCur ? await this.confirmationCount(beforeCur.id) : 0;
    const controlled = this.isControlled(op.sourceKey);
    const result: OpResult = { ok: true, baseRevision: controlled ? this.baseOf(op.sourceKey) : 0 };
    try {
      const input = await this.registerInput(op);
      await this.inTx((client) => registerObservation(client, input));
    } catch (error) {
      result.ok = false;
      result.error = errorCode(error);
    }
    const after = await this.receiptsOf(env, op.sourceKey);
    const afterCur = await this.currentOf(env, op.sourceKey);
    result.receiptDelta = after.length - before.length;
    result.current = afterCur;
    result.confirmationDelta = afterCur ? (await this.confirmationCount(afterCur.id)) - (beforeCur && beforeCur.id === afterCur.id ? confBefore : 0) : 0;
    if (result.ok && afterCur) {
      this.labels.set(op.label, afterCur.id);
      this.labelEnv.set(op.label, { env, key: op.sourceKey });
    }
    return result;
  }

  async registerConcurrent(op: Extract<LedgerOp, { op: 'register_concurrent' }>): Promise<OpResult> {
    const registerObservation = await entry<(client: pg.PoolClient, input: Record<string, unknown>) => Promise<unknown>>('ledger/receipts.ts', ['registerObservation']);
    const before = await this.receiptsOf('test', op.sourceKey);
    const input = await this.registerInput({ op: 'register', label: op.labels[0], sourceKey: op.sourceKey, normalizedValue: op.normalizedValue });
    const settled = await Promise.allSettled([
      this.inTx((c) => registerObservation(c, structuredClone(input))),
      this.inTx((c) => registerObservation(c, structuredClone(input))),
    ]);
    const failed = settled.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    const cur = await this.currentOf('test', op.sourceKey);
    const after = await this.receiptsOf('test', op.sourceKey);
    if (cur)
      for (const label of op.labels) {
        this.labels.set(label, cur.id);
        this.labelEnv.set(label, { env: 'test', key: op.sourceKey });
      }
    return {
      ok: failed.length === 0,
      error: failed.length ? errorCode(failed[0].reason) : undefined,
      receiptDelta: after.length - before.length,
      current: cur,
      confirmationDelta: cur ? await this.confirmationCount(cur.id) : 0,
    };
  }

  async assertCurrent(op: Extract<LedgerOp, { op: 'assert_current' }>): Promise<OpResult> {
    const mod = await entry<Record<string, unknown>>('ledger/support.ts', ['assertCurrent', 'supportValidator', 'SupportValidator', 'createSupportValidator']);
    // Resolve the callable regardless of how support.ts exports it.
    const fn = await this.resolveAssertCurrent(mod);
    const ids = op.labels.map((l) => {
      const id = this.labels.get(l);
      if (!id) throw new Error(`oracle label ${l} has no receipt (an earlier op failed)`);
      return id;
    });
    const client = await this.app.connect();
    try {
      await client.query('BEGIN');
      try {
        await fn(client, ids, { lockMode: op.lockMode, ...(op.freshness ? { freshness: op.freshness } : {}) });
        await client.query('COMMIT');
        return { ok: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: errorCode(error) };
      }
    } finally {
      client.release();
    }
  }

  private async resolveAssertCurrent(mod: unknown): Promise<(c: pg.PoolClient, ids: string[], o: Record<string, unknown>) => Promise<unknown>> {
    type F = (c: pg.PoolClient, ids: string[], o: Record<string, unknown>) => Promise<unknown>;
    if (typeof mod === 'function') {
      const direct = mod as unknown;
      try {
        const made = (mod as () => unknown)();
        if (made && typeof (made as { assertCurrent?: unknown }).assertCurrent === 'function') {
          return ((made as { assertCurrent: F }).assertCurrent).bind(made);
        }
      } catch {
        /* not a factory */
      }
      try {
        const inst = new (mod as new () => { assertCurrent: F })();
        if (typeof inst.assertCurrent === 'function') return inst.assertCurrent.bind(inst);
      } catch {
        /* not a class */
      }
      return direct as F;
    }
    const obj = mod as { assertCurrent?: F };
    if (obj && typeof obj.assertCurrent === 'function') return obj.assertCurrent.bind(obj);
    throw new Error('ENTRY POINT MISSING: ledger/support.ts exports no assertCurrent');
  }

  async ageReceipt(op: Extract<LedgerOp, { op: 'age_receipt' }>) {
    const id = this.labels.get(op.label);
    if (!id) throw new Error(`label ${op.label} unknown`);
    const client = await this.admin.connect();
    try {
      await client.query('BEGIN');
      const observed = await this.schema.pick(REC, ['observed_at']);
      const confirmed = await this.schema.pick(REC, ['last_confirmed_at']);
      const cc = await this.schema.pick(CONF, ['confirmed_at']);
      const rc = await this.schema.need(CONF, ['receipt_id']);
      await client.query(`ALTER TABLE ${REC} DISABLE TRIGGER USER`);
      await client.query(`ALTER TABLE ${CONF} DISABLE TRIGGER USER`);
      const ms = String(op.ageMs);
      const sets = [observed && `"${observed}" = "${observed}" - ($2 || ' milliseconds')::interval`, confirmed && `"${confirmed}" = "${confirmed}" - ($2 || ' milliseconds')::interval`].filter(Boolean);
      if (sets.length) await client.query(`UPDATE ${REC} SET ${sets.join(', ')} WHERE id = $1`, [id, ms]);
      if (cc) await client.query(`UPDATE ${CONF} SET "${cc}" = "${cc}" - ($2 || ' milliseconds')::interval WHERE "${rc}" = $1`, [id, ms]);
      await client.query(`ALTER TABLE ${REC} ENABLE TRIGGER USER`);
      await client.query(`ALTER TABLE ${CONF} ENABLE TRIGGER USER`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async transition(op: Extract<LedgerOp, { op: 'transition' }>) {
    const id = this.labels.get(op.label);
    if (!id) throw new Error(`label ${op.label} unknown`);
    const transitionReceipt = await entry<(client: pg.PoolClient, input: Record<string, unknown>) => Promise<unknown>>('ledger/receipts.ts', ['transitionReceipt']);
    const reason = op.to === 'expired' ? 'ttl_elapsed' : op.to === 'retracted' ? 'owner_retraction' : 'conflicting_observation';
    // BIND: transitionReceipt(client in an open transaction, { receiptId, to, reason }).
    await this.inTx((client) => transitionReceipt(client, { receiptId: id, to: op.to, reason }));
  }

  /**
   * A mission, an investigator task and a running attempt with an unexpired
   * lease, written the way claimAttempt writes them (so lockFencedAttempt accepts
   * the context). Setup only; the publication under test goes through the
   * production publishFinding.
   */
  async attemptContext() {
    await insertRow(this.admin, this.schema, 'coordinator.missions', { id: this.missionId, status: 'running' });
    const taskId = randomUUID();
    await this.admin.query(
      `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, capabilities, status, generation, fence_seq, attempt_count, budget)
       VALUES ($1, $2, 0, 0, 'acc', 'acc', 'investigator', ARRAY['observe','publish_finding']::text[], 'running', 0, 1, 1, '{"maxIterations":3,"maxTokens":1000,"maxChildren":1}'::jsonb)`,
      [taskId, this.missionId],
    );
    const attemptId = randomUUID();
    await this.admin.query(
      `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at)
       VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'acc1-worker', 1, now() + interval '1 hour', now())`,
      [attemptId, taskId, this.missionId],
    );
    return {
      missionId: this.missionId, taskId, attemptId, fencingToken: 1, generation: 0,
      capabilities: ['observe', 'publish_finding'], role: 'investigator',
    };
  }

  async publishFinding(op: Extract<LedgerOp, { op: 'publish_finding' }>): Promise<OpResult> {
    // BIND: coordinator/publish.ts#publishFinding(deps, context, { claim, supportingReceiptIds, confidence, dependencyVector }).
    const publishFinding = await entry<(deps: unknown, ctx: unknown, input: unknown) => Promise<unknown>>('coordinator/publish.ts', ['publishFinding']);
    const { createEventSink } = await import('../../../../src/server/nemodots/coordinator/events.js');
    const { addEdges } = await import('../../../../src/server/nemodots/ledger/edges.js');
    const support = await entry<Record<string, unknown>>('ledger/support.ts', ['supportValidator']);
    void addEdges;
    const ctx = await this.attemptContext();
    const vector = [] as { sourceKey: string; sourceRevision: number; receiptId: string }[];
    for (const l of op.citing) {
      const id = this.labels.get(l);
      const where = this.labelEnv.get(l);
      if (!id || !where) throw new Error(`label ${l} unknown`);
      const rec = await this.receiptById(id);
      vector.push({ sourceKey: where.key, sourceRevision: rec!.revision, receiptId: id });
    }
    const deps = {
      pool: this.app,
      config: {},
      events: createEventSink(),
      supportValidator: support,
      // The graph has no finding node kind; the composition root records nothing for findings.
      ledger: { recordModelCall: async () => {}, recordArtifact: async () => {} },
      recordOrphanedAttempt: async () => {},
      intents: {},
      clock: () => new Date(),
    };
    try {
      await publishFinding(deps, ctx, {
        claim: 'db.pool_max is 3, which may starve the pool',
        confidence: 'medium',
        supportingReceiptIds: vector.map((v) => v.receiptId),
        dependencyVector: vector,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorCode(error) };
    }
  }

  /** Attempts to rewrite an immutable receipt column as the app role; the row must be unchanged afterwards. */
  async tamper(op: Extract<LedgerOp, { op: 'tamper_update' }>): Promise<OpResult & { unchanged: boolean }> {
    const id = this.labels.get(op.label);
    if (!id) throw new Error(`label ${op.label} unknown`);
    const col = await this.schema.need(REC, [op.column]);
    const before = await this.admin.query(`SELECT "${col}"::text AS v FROM ${REC} WHERE id = $1`, [id]);
    const patch = col === 'source_revision' ? `"${col}" = "${col}" + 100` : col === 'content_digest' ? `"${col}" = repeat('0', 64)` : `"${col}" = '{"tampered":true}'::jsonb`;
    let result: OpResult = { ok: true };
    try {
      await this.app.query(`UPDATE ${REC} SET ${patch} WHERE id = $1`, [id]);
    } catch (error) {
      const sqlstate = (error as { code?: string }).code ?? '';
      // Any trigger/permission/constraint refusal is the guarantee holding; a missing relation or column is a binding problem.
      result = { ok: false, error: /^(42P01|42703)$/.test(sqlstate) ? `binding:${sqlstate}` : 'immutable' };
    }
    const after = await this.admin.query(`SELECT "${col}"::text AS v FROM ${REC} WHERE id = $1`, [id]);
    return { ...result, unchanged: before.rows[0].v === after.rows[0].v };
  }
}

export function newRunId() {
  return randomBytes(4).toString('hex');
}

export function caseById(id: string): LedgerCase {
  const c = LEDGER_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown oracle case ${id}`);
  return c;
}
