// Gate 1 items 2, 7, 8 and 13 through the REAL publication path: the
// coordinator's publishFinding / publishOutput / delegate / recordModelCall /
// publishPlan (coordinator/publish.ts) over the real ledger (see compose.ts),
// on real PostgreSQL. The guarantee under test is G2 (ARCHITECTURE section 4):
//   "A task output, handoff, child enqueue, finding or model-call record is
//    accepted only if SupportValidator.assertCurrent passes inside the
//    publishing transaction ..."
// plus ARCHITECTURE 5.2 / C13: a refused publication writes nothing, moves the
// attempt to `invalidated` and records a synthetic publication_rejected
// InvalidationEvent with a repair.
//
// A mutation that moves the final-version check out of the support validator
// and into (or out of) the publication path must turn these tests red even
// though ledger/support.ts#assertCurrent alone still passes its own tests.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { selectInheritedArtifacts, selectReceiptsForTask } from '../../../../src/server/nemodots/context/index.js';
import { addReadSet, delegate, publishFinding, publishOutput, publishPlan, recordModelCall } from '../../../../src/server/nemodots/coordinator/publish.js';
import { REJECTION_CASES } from '../oracle/closures.js';
import { World, errorCode } from './driver.js';
import { entry, withAccDatabase } from './harness.js';
import {
  COUNTED_TABLES,
  attemptRow,
  childrenOf,
  composeDeps,
  counts,
  invalidationsOf,
  loadContextReceipts,
  modelCallFor,
  recoveryOf,
  seedAttempt,
  seedMission,
  seedTask,
  seedAttemptRow,
  taskCount,
  vectorOfRefs,
  type ReceiptRef,
  type SeededAttempt,
} from './compose.js';

type Fixture = (w: World) => Promise<void>;
async function inDb(fn: Fixture) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      await fn(w);
    } finally {
      await w.close();
    }
  });
}

const HEALTH_OK = { status: 'ok', checks: { postgres: true, redis: true, config_parse: true, writes: true }, errorClasses: [] };
const HEALTH_BAD = { status: 'degraded', checks: { postgres: true, redis: true, config_parse: true, writes: false }, errorClasses: ['writes_disabled'] };

/** Receipt as stored in the ledger, found by SQL. */
async function refOf(w: World, id: string): Promise<ReceiptRef> {
  const r = await w.admin.query(
    `SELECT r.id, s.key, r.source_revision FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE r.id = $1`,
    [id],
  );
  return { id: r.rows[0].id, sourceKey: r.rows[0].key, revision: r.rows[0].source_revision };
}

async function registerPool(w: World, label: string): Promise<ReceiptRef> {
  const r = await w.register({ op: 'register', label, sourceKey: 'checkout.config/db.pool_max' });
  expect(r.ok, `register ${label}: ${r.error}`).toBe(true);
  return refOf(w, w.labels.get(label)!);
}

type Kind = 'finding' | 'handoff' | 'child_enqueue' | 'model_call';
const KINDS: Kind[] = ['finding', 'handoff', 'child_enqueue', 'model_call'];

/** One publication of each kind, citing exactly `refs` (the dependency vector). */
async function publish(kind: Kind, w: World, a: SeededAttempt, refs: ReceiptRef[], prepared?: Awaited<ReturnType<typeof modelCallFor>>) {
  const deps = composeDeps(w);
  const vector = vectorOfRefs(refs);
  switch (kind) {
    case 'finding':
      return publishFinding(deps, a.ctx, {
        claim: 'db.pool_max is 3, which starves the pool',
        confidence: 'medium',
        supportingReceiptIds: refs.map((r) => r.id) as never,
        dependencyVector: vector,
      });
    case 'handoff':
      return publishOutput(deps, a.ctx, { kind: 'handoff', content: { note: 'pool_max is 3' }, dependencyVector: vector });
    case 'child_enqueue':
      return delegate(deps, a.ctx, {
        title: 'verify the pool',
        role: 'verifier',
        question: 'is pool_max still 3?',
        dependsOn: [],
        justification: 'an independent check of the premise',
        dependencyVector: vector,
      });
    case 'model_call':
      return recordModelCall(deps, a.ctx, { record: prepared!.record, snapshot: prepared!.snapshot });
  }
}

async function newAttemptFor(_kind: Kind, w: World): Promise<SeededAttempt> {
  // A non-root task so a refused publication's repair does not trigger the root replan path.
  return seedAttempt(w, { role: 'investigator', child: true });
}

async function rejectedPublicationFacts(w: World, kind: Kind, a: SeededAttempt, r1: ReceiptRef, before: Record<string, number>, tasksBefore: number, error: unknown, expectedReason: string) {
  const problems: string[] = [];
  const code = errorCode(error);
  if (code !== expectedReason) problems.push(`${kind}: expected refusal ${expectedReason}, got ${code}`);
  const after = await counts(w);
  for (const t of COUNTED_TABLES) if (after[t] !== before[t]) problems.push(`${kind}: refused publication changed ${t} (${before[t]} -> ${after[t]})`);
  if ((await taskCount(w, a.missionId)) !== tasksBefore) problems.push(`${kind}: refused publication changed the number of tasks`);
  if ((await childrenOf(w, a.taskId)) !== 0) problems.push(`${kind}: a child task was enqueued by a refused publication`);

  const attempt = await attemptRow(w, a.attemptId);
  if (attempt.status !== 'invalidated') problems.push(`${kind}: attempt is ${attempt.status}, expected invalidated`);
  if (attempt.abort_reason !== 'publication_rejected') problems.push(`${kind}: abort_reason is ${attempt.abort_reason}, expected publication_rejected`);

  const events = (await invalidationsOf(w, a.missionId)).filter((e) => e.reason === 'publication_rejected');
  if (events.length !== 1) problems.push(`${kind}: expected exactly one publication_rejected InvalidationEvent, found ${events.length}`);
  else {
    const e = events[0].event as { oldReceiptId?: string; sourceKey?: string; affected?: { attemptIds?: string[]; taskIds?: string[] } };
    if (e.oldReceiptId !== r1.id) problems.push(`${kind}: InvalidationEvent names receipt ${e.oldReceiptId}, expected ${r1.id}`);
    if (e.sourceKey !== r1.sourceKey) problems.push(`${kind}: InvalidationEvent names source ${e.sourceKey}`);
    if (!e.affected?.attemptIds?.includes(a.attemptId)) problems.push(`${kind}: the event does not list the attempt as affected`);
    if (!e.affected?.taskIds?.includes(a.taskId)) problems.push(`${kind}: the event does not list the task as affected`);
  }
  const recovery = await recoveryOf(w, a.missionId);
  if (!recovery.some((x) => x.kind === 'repair_scheduled' && x.attempt_id === a.attemptId)) {
    problems.push(`${kind}: no repair_scheduled recovery event for the invalidated attempt (got ${recovery.map((x) => x.kind).join(',') || 'none'})`);
  }
  return problems;
}

// ---------------------------------------------------------------- item 13

describe('[G1.13] an authority epoch advanced before the watcher processed it refuses every publication on the old epoch', () => {
  it('[G1.13] findings, handoffs, child enqueues and model-call records citing r1 are refused with stale_pending_observation and write nothing', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const r1 = await registerPool(w, 'r1');
      // Compile each model call while r1 is still supported (what a worker would have done before the epoch moved).
      const attempts = new Map<Kind, SeededAttempt>();
      const prepared = new Map<Kind, Awaited<ReturnType<typeof modelCallFor>>>();
      for (const kind of KINDS) {
        const a = await newAttemptFor(kind, w);
        attempts.set(kind, a);
        if (kind === 'model_call') prepared.set(kind, await modelCallFor(w, a.ctx, { receipts: [r1.id] }));
      }
      // The epoch moves; NO watcher runs, so no replacement receipt exists. A pending replacement is not permission.
      await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 8, actor: 'injector' });
      expect(await w.receiptsOf('test', 'checkout.config/db.pool_max'), 'precondition: no watcher ran').toHaveLength(1);

      const problems: string[] = [];
      for (const kind of KINDS) {
        const a = attempts.get(kind)!;
        const before = await counts(w);
        const tasksBefore = await taskCount(w, a.missionId);
        let error: unknown = null;
        try {
          await publish(kind, w, a, [r1], prepared.get(kind));
        } catch (e) {
          error = e;
        }
        if (error === null) {
          problems.push(`${kind}: a publication on the old epoch was ACCEPTED`);
          continue;
        }
        problems.push(...(await rejectedPublicationFacts(w, kind, a, r1, before, tasksBefore, error, 'stale_pending_observation')));
      }
      expect(problems).toEqual([]);
    });
  });

  it('[G1.13] after the watcher registers the replacement, the old receipt is refused with stale_version everywhere and the replacement is accepted', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const r1 = await registerPool(w, 'r1');
      const oldAttempts = new Map<Kind, SeededAttempt>();
      const prepared = new Map<Kind, Awaited<ReturnType<typeof modelCallFor>>>();
      for (const kind of KINDS) {
        const a = await newAttemptFor(kind, w);
        oldAttempts.set(kind, a);
        if (kind === 'model_call') prepared.set(kind, await modelCallFor(w, a.ctx, { receipts: [r1.id] }));
      }
      await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 8, actor: 'injector' });
      const r2 = await registerPool(w, 'r2');
      expect(r2.revision).toBe(r1.revision + 1);

      const problems: string[] = [];
      for (const kind of KINDS) {
        const a = oldAttempts.get(kind)!;
        const before = await counts(w);
        const tasksBefore = await taskCount(w, a.missionId);
        let error: unknown = null;
        try {
          await publish(kind, w, a, [r1], prepared.get(kind));
        } catch (e) {
          error = e;
        }
        if (error === null) {
          problems.push(`${kind}: a publication citing the superseded receipt was ACCEPTED`);
          continue;
        }
        problems.push(...(await rejectedPublicationFacts(w, kind, a, r1, before, tasksBefore, error, 'stale_version')));
      }
      expect(problems).toEqual([]);

      // Control: the same four publications citing r2 succeed, so the refusals above were about staleness.
      const accepted: string[] = [];
      for (const kind of KINDS) {
        const a = await newAttemptFor(kind, w);
        const call = kind === 'model_call' ? await modelCallFor(w, a.ctx, { receipts: [r2.id] }) : undefined;
        try {
          await publish(kind, w, a, [r2], call);
          accepted.push(kind);
        } catch (e) {
          problems.push(`control ${kind}: fresh evidence was refused: ${errorCode(e)}`);
        }
      }
      expect(problems).toEqual([]);
      expect(accepted).toEqual(KINDS);
      const after = await counts(w);
      expect(after['coordinator.findings']).toBe(1);
      expect(after['ledger.model_call_records']).toBe(1);
      expect((await w.admin.query("SELECT count(*)::int AS n FROM coordinator.task_outputs WHERE kind = 'handoff'")).rows[0].n).toBe(1);
    });
  });

  it('[G1.13] a mixed vector (fresh receipt plus the old-epoch receipt) is refused as a whole by every publication kind', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const r1 = await registerPool(w, 'r1');
      const hb = await w.register({ op: 'register', label: 'health', sourceKey: 'checkout.health', normalizedValue: HEALTH_OK });
      expect(hb.ok, hb.error).toBe(true);
      const health = await refOf(w, w.labels.get('health')!);
      const attempts = new Map<Kind, SeededAttempt>();
      const prepared = new Map<Kind, Awaited<ReturnType<typeof modelCallFor>>>();
      for (const kind of KINDS) {
        const a = await newAttemptFor(kind, w);
        attempts.set(kind, a);
        if (kind === 'model_call') prepared.set(kind, await modelCallFor(w, a.ctx, { receipts: [r1.id, health.id] }));
      }
      await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 8, actor: 'injector' });
      const problems: string[] = [];
      for (const kind of KINDS) {
        const a = attempts.get(kind)!;
        const before = await counts(w);
        const tasksBefore = await taskCount(w, a.missionId);
        let error: unknown = null;
        try {
          await publish(kind, w, a, [r1, health], prepared.get(kind));
        } catch (e) {
          error = e;
        }
        if (error === null) problems.push(`${kind}: accepted with one stale member`);
        else problems.push(...(await rejectedPublicationFacts(w, kind, a, r1, before, tasksBefore, error, 'stale_pending_observation')));
      }
      expect(problems).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ item 2

describe('[G1.2] a receipt of another environment, resource, owner or Space grants no access', () => {
  const variants: [string, { env?: 'eval'; scope: Record<string, unknown> }][] = [
    ['another environment', { env: 'eval', scope: {} }],
    ['another resource', { scope: { resource: 'checkout-shadow' } }],
    ['another owner', { scope: { ownerId: 'acc1-someone-else' } }],
    ['another Space', { scope: { spaceId: 'space-b' } }],
  ];

  async function foreignReceipt(w: World, v: { env?: 'eval'; scope: Record<string, unknown> }): Promise<ReceiptRef> {
    const register = await entry<(c: pg.PoolClient, i: Record<string, unknown>) => Promise<unknown>>('ledger/receipts.ts', ['registerObservation']);
    const env = v.env ?? 'test';
    const source = { ...w.sourceRef('checkout.health', env), scope: { ...w.scope(env), ...v.scope } };
    await w.inTx((c) => register(c, { source, normalizedValue: HEALTH_BAD, provenance: { kind: 'watcher' } }));
    const s = source.scope as { ownerId: string; environment: string; resource: string };
    const r = await w.admin.query(
      `SELECT r.id FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
        WHERE s.owner_id = $1 AND s.environment = $2 AND s.resource = $3 AND s.key = 'checkout.health' ORDER BY r.source_revision DESC LIMIT 1`,
      [s.ownerId, s.environment, s.resource],
    );
    return refOf(w, r.rows[0].id);
  }

  for (const [name, variant] of variants) {
    it(`[G1.2] a receipt of ${name} does not collide with, supersede or support the test-scope mission`, async () => {
      await inDb(async (w) => {
        const mine = await w.register({ op: 'register', label: 'mine', sourceKey: 'checkout.health', normalizedValue: HEALTH_OK });
        expect(mine.ok, mine.error).toBe(true);
        const m1 = await refOf(w, w.labels.get('mine')!);
        const foreign = await foreignReceipt(w, variant);
        expect(foreign.id, `${name}: the foreign registration produced the mission's own receipt (sources collided)`).not.toBe(m1.id);
        expect((await w.receiptById(m1.id))?.status, `${name}: a foreign registration superseded the mission's own receipt`).toBe('supported');
        expect(await w.confirmationCount(m1.id)).toBe(0);

        const a = await seedAttempt(w, { role: 'investigator', child: true });
        const deps = composeDeps(w);
        const before = await counts(w);

        // (a) citing the foreign receipt without having read it: refused as out of scope, nothing written.
        const outOfScope = await publishFinding(deps, a.ctx, {
          claim: 'health is degraded',
          confidence: 'low',
          supportingReceiptIds: [foreign.id] as never,
          dependencyVector: vectorOfRefs([m1]),
        }).then(() => null, (e: unknown) => e);
        expect(outOfScope, `${name}: a finding citing an unread foreign receipt was accepted`).not.toBeNull();
        expect(await counts(w)).toEqual(before);
        expect((await w.admin.query('SELECT count(*)::int AS n FROM coordinator.findings')).rows[0].n).toBe(0);
      });
    });

    it(`[G1.2] a receipt of ${name} injected into the attempt's read set and dependency vector is still refused as support`, async () => {
      await inDb(async (w) => {
        const mine = await w.register({ op: 'register', label: 'mine', sourceKey: 'checkout.health', normalizedValue: HEALTH_OK });
        expect(mine.ok, mine.error).toBe(true);
        const m1 = await refOf(w, w.labels.get('mine')!);
        const foreign = await foreignReceipt(w, variant);
        expect(foreign.id, `${name}: sources collided`).not.toBe(m1.id);
        const a = await seedAttempt(w, { role: 'investigator', child: true });
        const deps = composeDeps(w);

        // The mission is owner acc1-owner / test / checkout; the receipt is not. Neither the read-set write nor
        // the publication may accept it as support of this mission.
        let refusedAt: string | null = null;
        try {
          await addReadSet(deps, a.ctx, vectorOfRefs([foreign]));
        } catch {
          refusedAt = 'addReadSet';
        }
        if (!refusedAt) {
          await publishFinding(deps, a.ctx, {
            claim: 'health is degraded',
            confidence: 'low',
            supportingReceiptIds: [foreign.id] as never,
            dependencyVector: vectorOfRefs([foreign]),
          }).then(
            () => {},
            () => {
              refusedAt = 'publishFinding';
            },
          );
        }
        const rows = (await w.admin.query('SELECT count(*)::int AS n FROM coordinator.findings')).rows[0].n;
        expect(
          { refusedAt: refusedAt !== null, findingRows: rows },
          `${name}: a receipt registered under another scope was accepted as support for a mission outside that scope`,
        ).toEqual({ refusedAt: true, findingRows: 0 });
      });
    });
  }
});

// ------------------------------------------------------------------ item 7

describe('[G1.7] a repaired model call cannot carry replayed stale history, an old handoff or a superseded receipt as current support (request record)', () => {
  async function staleWorld(w: World) {
    await w.seedConfig('db.pool_max', 3);
    await w.snapshotBases();
    const r1 = await registerPool(w, 'r1');
    // The original attempt: a recorded model call and a handoff, both resting on r1.
    const first = await seedAttempt(w, { role: 'investigator', child: true });
    const deps = composeDeps(w);
    const m1 = await modelCallFor(w, first.ctx, { receipts: [r1.id] });
    await recordModelCall(deps, first.ctx, m1);
    const handoff = await publishOutput(deps, first.ctx, { kind: 'handoff', content: { text: 'pool_max is 3, raise it' }, dependencyVector: vectorOfRefs([r1]) });
    // The authority moves and the watcher registers the replacement: closure marks the lineage.
    await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 8, actor: 'injector' });
    const r2 = await registerPool(w, 'r2');
    return { r1, r2, first, m1, handoffId: handoff.outputId as string, deps };
  }

  it('[G1.7] the stale lineage is unusable in SQL, and a repaired call that replays it is refused with nothing recorded', async () => {
    await inDb(async (w) => {
      const { r1, r2, handoffId, deps } = await staleWorld(w);
      const out = (await w.admin.query('SELECT usable, unusable_reason FROM coordinator.task_outputs WHERE id = $1', [handoffId])).rows[0];
      expect(out.usable, 'the old handoff must be unusable after r1 was superseded').toBe(false);

      const repair = await seedAttempt(w, { role: 'investigator', child: true });
      // A repaired call whose replayed history still carries the old tool result (depends on r1).
      const replayed = await modelCallFor(w, repair.ctx, {
        receipts: [r2.id],
        extra: {
          history: [
            { role: 'tool', content: '{"value":3}', toolCallId: 'tc9', toolName: 'observe_source', dependencyVector: vectorOfRefs([r1]) },
          ],
        },
      });
      expect(replayed.snapshot.dependencyVector.map((d) => d.receiptId), 'the compiler records the replayed premise').toContain(r1.id);
      const before = await counts(w);
      const error = await recordModelCall(deps, repair.ctx, replayed).then(() => null, (e: unknown) => e);
      expect(error, 'a model call resting on replayed stale history was recorded').not.toBeNull();
      expect(errorCode(error)).toBe('stale_version');
      expect(await counts(w)).toEqual(before);
    });
  });

  it('[G1.7] the persisted context of the repaired call lists only current receipts, and neither the old handoff nor the superseded receipt', async () => {
    await inDb(async (w) => {
      const { r1, r2, handoffId, deps } = await staleWorld(w);
      const repair = await seedAttempt(w, { role: 'investigator', child: true });

      // What a worker assembles from the database: every receipt of the key (stale and current), the old
      // handoff, the stale read set. The production scope selectors decide what enters the request.
      const all = (
        await w.admin.query(
          `SELECT r.id FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = 'checkout.config/db.pool_max'`,
        )
      ).rows.map((x) => x.id as string);
      const candidates = await loadContextReceipts(w, all);
      const picked = selectReceiptsForTask({
        candidates,
        readSetReceiptIds: [r1.id, r2.id],
        inheritedVector: vectorOfRefs([r1]),
        requestedKeys: [],
        maxReceipts: 10,
      });
      expect(picked.receipts.map((x) => x.id)).toEqual([r2.id]);
      const outputs = (await w.admin.query('SELECT id, kind, digest, content, usable FROM coordinator.task_outputs')).rows;
      const inheritedArtifacts = outputs.map((o) => ({ kind: o.kind as 'handoff', id: o.id as string, digest: o.digest as string, text: JSON.stringify(o.content), usable: o.usable as boolean, dependencyVector: vectorOfRefs([r1]) }));
      const selected = selectInheritedArtifacts(inheritedArtifacts, 10);
      expect(selected.artifacts.map((a) => a.id), 'the old handoff must not be inherited').not.toContain(handoffId);

      const built = await modelCallFor(w, repair.ctx, { receipts: picked.receipts.map((x) => x.id), extra: { inheritedArtifacts: selected.artifacts } });
      await recordModelCall(deps, repair.ctx, built);

      // The persisted request record, read back from the ledger tables.
      const snap = (await w.admin.query('SELECT injected, dependency_vector FROM ledger.context_snapshots WHERE id = $1', [built.snapshot.id])).rows[0];
      const rec = (await w.admin.query('SELECT output_dependency_vector FROM ledger.model_call_records WHERE id = $1', [built.record.id])).rows[0];
      const listed = (snap.injected.receipts as { id: string }[]).map((x) => x.id);
      expect(listed).toEqual([r2.id]);
      expect((snap.dependency_vector as { receiptId: string }[]).map((x) => x.receiptId)).toEqual([r2.id]);
      expect((rec.output_dependency_vector as { receiptId: string }[]).map((x) => x.receiptId)).toEqual([r2.id]);
      expect((snap.injected.inheritedArtifacts as { id: string }[]).map((x) => x.id)).not.toContain(handoffId);
      // Every receipt the record lists as support is supported right now, per the ledger.
      for (const id of [...listed, ...(snap.dependency_vector as { receiptId: string }[]).map((x) => x.receiptId)]) {
        expect((await w.receiptById(id))?.status, `receipt ${id} listed in the persisted context`).toBe('supported');
      }
      expect(JSON.stringify(snap)).not.toContain(r1.id);
      expect(JSON.stringify(snap)).not.toContain(handoffId);
    });
  });
});

// ---------------------------------------------------------------- item 8 (RJ)

/** Maps a coordinator refusal to an oracle rejection code: a typed code first, else the named rule in its issue list. */
function classifyRejection(error: unknown): string {
  const code = errorCode(error);
  if (!code.startsWith('unclassified')) return code;
  const issues = (error as { issues?: string[] }).issues;
  if (issues?.some((i) => /\bcycle\b|references itself/i.test(i))) return 'scheduling_cycle';
  return code;
}

describe('[G1.8] cycle rejections through the real plan and delegation publication path write nothing', () => {
  const planCases = REJECTION_CASES.filter((c) => c.operation.kind === 'plan');
  const delegateCases = REJECTION_CASES.filter((c) => c.operation.kind === 'delegate');

  for (const c of planCases) {
    it(`[G1.8] ${c.id} ${c.title}: publishPlan refuses it as a scheduling cycle and writes no task, output or edge`, async () => {
      if (c.operation.kind !== 'plan') throw new Error('oracle changed shape');
      const op = c.operation;
      await inDb(async (w) => {
        const planner = await seedAttempt(w, { role: 'planner', child: false });
        const deps = composeDeps(w);
        const plan = {
          tasks: op.dependsOn.map((deps2, i) => ({ title: `acc task ${i}`, question: 'acceptance question', role: 'investigator', capabilities: ['observe'], dependsOn: deps2 })),
        };
        const before = await counts(w, ['coordinator.tasks', 'coordinator.task_outputs', 'ledger.dependency_edges']);
        const error = await publishPlan(deps, planner.ctx, { plan, createdByModelCallId: null }).then(() => null, (e: unknown) => e);
        expect(error, `${c.id}: the plan was accepted`).not.toBeNull();
        expect(c.expected.acceptedCodes as string[], `${c.id}: refusal was "${classifyRejection(error)}" (${(error as Error).message})`).toContain(classifyRejection(error));
        expect(await counts(w, ['coordinator.tasks', 'coordinator.task_outputs', 'ledger.dependency_edges'])).toEqual(before);
        const attempt = await attemptRow(w, planner.attemptId);
        expect(attempt.status, 'a rejected plan must leave the planner attempt untouched').toBe('running');
      });
    });
  }

  it('[G1.8] negative control: a plan with an out-of-range dependency is refused but NOT classified as a scheduling cycle', async () => {
    await inDb(async (w) => {
      const planner = await seedAttempt(w, { role: 'planner', child: false });
      const plan = { tasks: [0, 1].map((i) => ({ title: `t${i}`, question: 'q', role: 'investigator', capabilities: ['observe'], dependsOn: i === 0 ? [7] : [] })) };
      const error = await publishPlan(composeDeps(w), planner.ctx, { plan, createdByModelCallId: null }).then(() => null, (e: unknown) => e);
      expect(error).not.toBeNull();
      expect(classifyRejection(error), 'the classifier must tell a range error from a cycle').not.toBe('scheduling_cycle');
    });
  });

  for (const c of delegateCases) {
    it(`[G1.8] ${c.id} ${c.title}: delegate refuses it as a scheduling cycle and writes no task, output or edge`, async () => {
      if (c.operation.kind !== 'delegate') throw new Error('oracle changed shape');
      const op = c.operation;
      await inDb(async (w) => {
        const missionId = await seedMission(w);
        const real = new Map<string, string>();
        for (const t of op.existing) real.set(t.id, randomUUID());
        // Parents first so the foreign key holds; prerequisites reference ids that already exist by the time they are read.
        const order = [...op.existing].sort((x, y) => (x.parentTaskId ? 1 : 0) - (y.parentTaskId ? 1 : 0));
        for (const t of order) {
          const isParent = t.id === op.parentTaskId;
          await seedTask(w, missionId, {
            id: real.get(t.id),
            role: 'investigator',
            parentId: t.parentTaskId ? real.get(t.parentTaskId)! : null,
            status: isParent ? 'running' : 'waiting',
            fenceSeq: isParent ? 1 : 0,
            prerequisites: t.waitsOn.map((id) => real.get(id)!),
          });
        }
        const parentId = real.get(op.parentTaskId)!;
        const attemptId = await seedAttemptRow(w, missionId, parentId);
        const ctx = { missionId, taskId: parentId, attemptId, fencingToken: 1, generation: 0, capabilities: ['observe', 'delegate', 'publish_finding', 'request_replan'], role: 'investigator' } as never;
        const deps = composeDeps(w);
        const tables = ['coordinator.tasks', 'coordinator.task_outputs', 'ledger.dependency_edges'];
        const before = await counts(w, tables);
        const error = await delegate(deps, ctx, {
          title: 'acc child',
          role: 'verifier',
          question: 'acceptance question',
          dependsOn: op.childDependsOn.map((id) => real.get(id)!) as never,
          justification: 'needs an independent check',
          dependencyVector: [],
        }).then(() => null, (e: unknown) => e);
        expect(error, `${c.id}: the delegation was accepted`).not.toBeNull();
        expect(c.expected.acceptedCodes as string[], `${c.id}: refusal was "${classifyRejection(error)}" (${(error as Error).message})`).toContain(classifyRejection(error));
        expect(await counts(w, tables)).toEqual(before);
        expect((await attemptRow(w, attemptId)).status).toBe('running');

        // Control: the same attempt can delegate a child without the cycle, so the refusal was about the cycle.
        const ok = await delegate(deps, ctx, { title: 'acc child', role: 'verifier', question: 'acceptance question', dependsOn: [], justification: 'needs an independent check', dependencyVector: [] });
        expect(ok.created).toBe(true);
        expect(await childrenOf(w, parentId)).toBe(op.existing.filter((t) => t.parentTaskId === op.parentTaskId).length + 1);
      });
    });
  }
});
