// Gate 1 items 8, 9, 10 and 12: hand-enumerated transitive invalidation
// closures (CL-*) and cycle/cap rejections (RJ-*) from the frozen oracle,
// executed on real PostgreSQL through the production registration path.
// Expected sets come only from ../oracle/closures.ts. Observed sets are read
// from the rows the closure wrote (attempt/task status, output usability,
// intent status) and from the invalidation event the closure recorded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { CLOSURE_CASES, REJECTION_CASES } from '../oracle/closures.js';
import type { ClosureCase, RejectionCase } from '../oracle/types.js';
import { World, errorCode } from './driver.js';
import { APP_ROOT, entry, insertRow, insertValues, withAccDatabase } from './harness.js';
import { T, applyAuthority, edgeApi, mapIds, observeClosure, registerChange, seedGraph } from './graph.js';

const tag = (covers: string[]) =>
  covers
    .filter((x) => x.startsWith('gate1.'))
    .map((x) => `[G1.${x.slice(6)}]`)
    .join('');

const sortedEq = (got: string[], want: string[]) => JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());

async function runClosure(c: ClosureCase) {
  return withAccDatabase(async (db) => {
    const w = new World(db);
    const problems: string[] = [];
    try {
      const seeded = await seedGraph(w, c.nodes, c.edges, { ensureExtraKey: c.changes.some((ch) => ch.via === 'collection_delete') });
      if (c.concurrent) {
        for (let i = 0; i < c.changes.length; i += 1) await applyAuthority(w, c, i);
        const results = await Promise.all(c.changes.map((_, i) => registerChange(w, c, i)));
        results.forEach((r, i) => {
          if (!r.ok) problems.push(`concurrent change ${i} failed: ${r.error}`);
        });
      } else {
        for (let i = 0; i < c.changes.length; i += 1) {
          await applyAuthority(w, c, i);
          const r = await registerChange(w, c, i);
          if (!r.ok) problems.push(`change ${i} failed: ${r.error}`);
        }
      }
      const obs = await observeClosure(w, seeded);
      const e = c.expected;
      const real = (ids: string[]) => mapIds(seeded, ids);

      if (obs.eventRows !== e.invalidationEvents) problems.push(`invalidation_events rows: expected ${e.invalidationEvents}, got ${obs.eventRows}`);

      const expectAffected = {
        modelCallIds: real(e.affected.modelCallIds),
        attemptIds: real(e.affected.attemptIds),
        outputIds: real(e.affected.outputIds),
        actionIds: real(e.affected.actionIds),
        taskIds: real(e.affected.taskIds),
      };
      for (const k of Object.keys(expectAffected) as (keyof typeof expectAffected)[]) {
        if (!sortedEq(obs.union[k], expectAffected[k])) problems.push(`event.affected.${k}: expected ${seeded && JSON.stringify(e.affected[k])}, got ${JSON.stringify(obs.union[k].map((id) => seeded.reverse.get(id) ?? id))}`);
      }
      // The event is a record; the rows are the effect. Both must agree with the oracle.
      // CONTRACTS transition table: a published attempt is terminal. Closure membership flips only
      // attempts that were still running; the published ones lose their output (usable=false) and their task.
      const runningAffected = e.affected.attemptIds.filter((id) => c.nodes.find((n) => n.id === id)?.attemptStatus === 'running');
      if (!sortedEq(obs.attemptsInvalidated, real(runningAffected))) problems.push(`attempt rows invalidated: expected ${JSON.stringify(runningAffected)} (the affected attempts that were running), got ${JSON.stringify(obs.attemptsInvalidated.map((id) => seeded.reverse.get(id) ?? id))}`);
      if (!sortedEq(obs.outputsUnusable, expectAffected.outputIds)) problems.push(`outputs made unusable: expected ${JSON.stringify(e.affected.outputIds)}, got ${JSON.stringify(obs.outputsUnusable.map((id) => seeded.reverse.get(id) ?? id))}`);
      if (!sortedEq(obs.tasksInvalidated, expectAffected.taskIds)) problems.push(`task rows invalidated: expected ${JSON.stringify(e.affected.taskIds)}, got ${JSON.stringify(obs.tasksInvalidated.map((id) => seeded.reverse.get(id) ?? id))}`);

      if (seeded.intentRowsMissing > 0)
        problems.push(`coordinator.action_intents does not exist yet (wave-3 actions migration): ${seeded.intentRowsMissing} intent node(s) were graph nodes only, so ${Object.keys(e.intentStatusAfter).length} intent status expectation(s) were NOT evaluated`);
      else for (const [intent, want] of Object.entries(e.intentStatusAfter)) {
        const got = obs.intents.get(seeded.ids.get(intent)!);
        if (got?.status !== want.status) problems.push(`intent ${intent}: expected status ${want.status}, got ${got?.status}`);
        if (want.blockReason && got?.blockReason !== want.blockReason) problems.push(`intent ${intent}: expected block reason ${want.blockReason}, got ${got?.blockReason}`);
      }

      const expectedMissions = new Set<string>();
      for (const pm of e.perMission) {
        const mid = seeded.missions.get(pm.missionId)!;
        expectedMissions.add(mid);
        const got = obs.perMission.get(mid);
        if (!got) {
          problems.push(`mission ${pm.missionId}: no perMission entry in the invalidation event`);
          continue;
        }
        for (const k of Object.keys(pm.affected) as (keyof typeof pm.affected)[]) {
          if (!sortedEq(got.affected[k], real(pm.affected[k]))) problems.push(`mission ${pm.missionId} affected.${k}: expected ${JSON.stringify(pm.affected[k])}, got ${JSON.stringify(got.affected[k].map((id) => seeded.reverse.get(id) ?? id))}`);
        }
        if (!sortedEq(got.preserved, real(pm.preservedTaskIds))) problems.push(`mission ${pm.missionId} preserved tasks: expected ${JSON.stringify(pm.preservedTaskIds)}, got ${JSON.stringify(got.preserved.map((id) => seeded.reverse.get(id) ?? id))}`);
      }
      for (const [oracleMission, mid] of seeded.missions) {
        if (expectedMissions.has(mid)) continue;
        const leaked = obs.perMission.get(mid);
        if (leaked && Object.values(leaked.affected).some((x) => x.length)) problems.push(`unaffected mission ${oracleMission} received affected nodes in the event`);
      }
      for (const r of e.receiptsStillCurrent ?? []) if (obs.receiptStatus.get(r) !== 'supported') problems.push(`receipt ${r} must remain current, is ${obs.receiptStatus.get(r)}`);
      for (const ch of c.changes) if (obs.receiptStatus.get(ch.oldReceipt) !== 'superseded') problems.push(`changed receipt ${ch.oldReceipt} should be superseded, is ${obs.receiptStatus.get(ch.oldReceipt)}`);

      // G1.10 quantification: false invalidations (rows invalidated that the oracle preserves).
      const falseInvalidated = obs.tasksInvalidated.filter((id) => !expectAffected.taskIds.includes(id)).length;
      const missed = expectAffected.taskIds.filter((id) => !obs.tasksInvalidated.includes(id)).length;
      mkdirSync(resolve(APP_ROOT, '.local/acceptance'), { recursive: true });
      writeFileSync(
        resolve(APP_ROOT, `.local/acceptance/g1-false-invalidation-${c.id}.json`),
        JSON.stringify(
          {
            case: c.id,
            conservative: e.conservative,
            tasksInvalidated: obs.tasksInvalidated.length,
            expectedAffectedTasks: expectAffected.taskIds.length,
            falseInvalidatedTasks: falseInvalidated,
            missedTasks: missed,
            dagRestartTasks: e.dagRestartTaskIds?.length ?? null,
            avoidedReruns: e.dagRestartTaskIds ? e.dagRestartTaskIds.length - obs.tasksInvalidated.length : null,
          },
          null,
          2,
        ),
      );
      if (falseInvalidated > 0) problems.push(`false invalidation: ${falseInvalidated} task row(s) invalidated that the oracle preserves`);
      if (missed > 0) problems.push(`missed invalidation: ${missed} affected task row(s) were not invalidated`);
    } finally {
      await w.close();
    }
    expect(problems, `${c.id} ${c.title}`).toEqual([]);
  });
}

describe('gate 1 invalidation closures (frozen oracle CL-*)', () => {
  it.each(CLOSURE_CASES.map((c) => [`${tag(c.covers)} ${c.id} ${c.title}`, c] as const))('%s', async (_name, c) => {
    await runClosure(c);
  });

  it('[G1.9] CL-3 is labelled conservative by the oracle: v1 invalidates the whole closure and has no representation of independent sufficient support', async () => {
    const cl3 = CLOSURE_CASES.find((c) => c.id === 'CL-3')!;
    expect(cl3.expected.conservative).toBe(true);
    await withAccDatabase(async (db) => {
      const w = new World(db);
      try {
        // Nothing in the ledger schema may claim exact or sufficiency reasoning.
        const cols = await w.admin.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema IN ('ledger','coordinator')
              AND (column_name ~* '(sufficien|exact|alternative_support|independent_support)')`,
        );
        expect(cols.rows, 'a sufficiency/exactness column exists: the v1 conservative oracle must be revised before it is advertised').toEqual([]);
      } finally {
        await w.close();
      }
    });
    await runClosure(cl3);
  });
});

// ------------------------------------------------------------- rejections

const uuidFor = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

async function countRows(w: World, table: string) {
  if (!(await w.schema.exists(table))) return 0;
  return (await w.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
}

/** RJ-1/RJ-2: plans with scheduling cycles, through the pure plan validator the planner path uses. */
async function planRejection(c: RejectionCase & { operation: { kind: 'plan' } }) {
  const { validatePlan } = await import('../../../../src/server/nemodots/coordinator/plan-validation.js');
  const plan = {
    tasks: c.operation.dependsOn.map((deps, i) => ({
      title: `acc task ${i}`,
      question: 'acceptance question',
      role: 'investigator',
      capabilities: ['observe'],
      dependsOn: deps,
    })),
  };
  const verdict = validatePlan(plan, { maxTasks: 50, existingTasks: 0 });
  expect(verdict.ok, `${c.id}: the plan must be rejected`).toBe(false);
  if (verdict.ok) return;
  expect(verdict.issues.join(' | ').toLowerCase(), `${c.id}: the refusal must name the cycle`).toMatch(/cycl|depend/);
}

/** RJ-3/RJ-4: delegated children that would close a scheduling cycle with a waiting ancestor. */
async function delegationRejection(c: RejectionCase & { operation: { kind: 'delegate' } }) {
  const { validateDelegation } = await import('../../../../src/server/nemodots/coordinator/plan-validation.js');
  const op = c.operation;
  const real = new Map(op.existing.map((t, i) => [t.id, uuidFor(i + 1)] as const));
  const tasks = op.existing.map((t) => ({
    id: real.get(t.id)!,
    parentId: t.parentTaskId ? real.get(t.parentTaskId)! : null,
    prerequisites: t.waitsOn.map((id) => real.get(id)!),
  }));
  const issues = validateDelegation(
    {
      role: 'verifier',
      title: 'acc child',
      question: 'acceptance question',
      justification: 'needs an independent check',
      dependsOn: op.childDependsOn.map((id) => real.get(id)!),
    } as never,
    {
      parent: { id: real.get(op.parentTaskId)!, role: 'investigator', depth: 1, capabilities: ['observe', 'delegate', 'publish_finding', 'request_replan'], maxChildren: 4 },
      limits: { maxDepth: 4, maxBreadth: 4, maxTasks: 50 },
      totalTasks: tasks.length,
      parentChildren: 0,
      tasks,
    } as never,
    uuidFor(99) as never,
  );
  expect(issues.length, `${c.id}: the delegation must be rejected`).toBeGreaterThan(0);
  expect(issues.join(' | ').toLowerCase()).toContain('cycle');
}

async function edgeRejection(c: RejectionCase & { operation: { kind: 'edge' } }) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      const op = c.operation;
      const seeded = await seedGraph(w, op.nodes, op.existing);
      const { addEdges } = await edgeApi();
      const before = await countRows(w, T.edges);
      const byId = new Map(op.nodes.map((n) => [n.id, n]));
      const ref = (id: string) => {
        const n = byId.get(id)!;
        return { kind: n.kind, id: seeded.ids.get(id), missionId: seeded.missions.get(n.missionId), taskId: n.taskId ? seeded.ids.get(n.taskId) : null };
      };
      let error: unknown = null;
      try {
        await w.inTx((client) => addEdges(client, [{ kind: op.add.kind, from: ref(op.add.from), to: ref(op.add.to) }]));
      } catch (e) {
        error = e;
      }
      const code = error ? errorCode(error) : 'accepted';
      expect(c.expected.acceptedCodes as string[], `${c.id}: got ${code}`).toContain(code);
      expect(await countRows(w, T.edges), 'a rejected edge must write nothing').toBe(before);
    } finally {
      await w.close();
    }
  });
}

/** Chain R0 -> A1 -> O1 -> A2 -> ... or fan-out R0 -> A1..An, bulk-inserted. */
async function seedGenerated(w: World, shape: 'chain' | 'fanout', size: number) {
  await w.seedConfig('db.pool_max', 3);
  await w.snapshotBases();
  const first = await w.register({ op: 'register', label: 'R0', sourceKey: 'checkout.config/db.pool_max' });
  if (!first.ok || !first.current) throw new Error(`cannot register R0: ${first.error}`);
  const missionId = randomUUID();
  await insertRow(w.admin, w.schema, T.missions, { id: missionId, status: 'running' });
  const taskId = randomUUID();
  await w.admin.query(
    `INSERT INTO ${T.tasks} (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
     VALUES ($1, $2, 0, 0, 'acc', 'acc', 'investigator', 'succeeded', 0, '{"maxIterations":1,"maxTokens":1,"maxChildren":1}'::jsonb)`,
    [taskId, missionId],
  );
  const task = { id: taskId };
  const now = new Date();
  const later = new Date(Date.now() + 3_600_000);
  const attemptIds = Array.from({ length: size }, () => randomUUID());
  await insertValues(
    w.admin,
    T.attempts,
    attemptIds.map((id, i) => ({
      id, task_id: task.id, mission_id: missionId, n: i + 1, kind: 'initial', status: 'published', generation: 0,
      lease_owner: 'acc1', fencing_token: i + 1, lease_expires_at: later, lease_renewed_at: now,
    })),
  );
  const nodes: Record<string, unknown>[] = attemptIds.map((id) => ({ kind: 'attempt', id, mission_id: missionId, task_id: task.id }));
  const edges: Record<string, unknown>[] = [];
  const edge = (kind: string, fromKind: string, from: string, toKind: string, to: string) =>
    edges.push({ id: randomUUID(), mission_id: missionId, kind, from_kind: fromKind, from_id: from, to_kind: toKind, to_id: to });
  nodes.push({ kind: 'receipt', id: first.current.id, mission_id: null, task_id: null });
  if (shape === 'fanout') {
    for (const a of attemptIds) edge('evidence', 'receipt', first.current.id, 'attempt', a);
  } else {
    const outputIds = attemptIds.map(() => randomUUID());
    await insertValues(
      w.admin,
      T.outputs,
      outputIds.map((id, i) => ({
        id, task_id: task.id, attempt_id: attemptIds[i], mission_id: missionId, kind: 'finding', content: {}, digest: 'a'.repeat(64), usable: true,
      })),
    );
    for (const id of outputIds) nodes.push({ kind: 'task_output', id, mission_id: missionId, task_id: task.id });
    edge('evidence', 'receipt', first.current.id, 'attempt', attemptIds[0]);
    for (let i = 0; i < size; i += 1) {
      edge('evidence', 'attempt', attemptIds[i], 'task_output', outputIds[i]);
      if (i + 1 < size) edge('inheritance', 'task_output', outputIds[i], 'attempt', attemptIds[i + 1]);
    }
  }
  const existing = new Set((await w.admin.query('SELECT id FROM ledger.dependency_nodes')).rows.map((r) => r.id));
  await insertValues(w.admin, 'ledger.dependency_nodes', nodes.filter((n) => !existing.has(n.id)));
  await insertValues(w.admin, T.edges, edges);
  return { missionId, firstReceipt: first.current.id };
}

async function generatedRejection(c: RejectionCase & { operation: { kind: 'generated' } }) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      const { missionId, firstReceipt } = await seedGenerated(w, c.operation.shape, c.operation.size);
      const receiptsBefore = await countRows(w, 'ledger.observation_receipts');
      const eventsBefore = await countRows(w, T.invalidations);
      await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 9, actor: 'injector' });
      const r = await w.register({ op: 'register', label: 'R1', sourceKey: 'checkout.config/db.pool_max' });
      expect(r.ok, 'the closure cap must refuse the registration').toBe(false);
      expect(c.expected.acceptedCodes as string[]).toContain(r.error);
      expect(await countRows(w, 'ledger.observation_receipts'), 'a refused registration must not leave a receipt row').toBe(receiptsBefore);
      expect(await countRows(w, T.invalidations), 'a refused registration must not leave an invalidation event').toBe(eventsBefore);
      expect((await w.receiptById(firstReceipt))?.status, 'old receipt must be untouched').toBe('supported');
      const attemptStatus = await w.schema.need(T.attempts, ['status']);
      const flipped = await w.admin.query(`SELECT count(*)::int AS n FROM ${T.attempts} WHERE "${attemptStatus}" = 'invalidated'`);
      expect(flipped.rows[0].n, 'no attempt may be invalidated by a refused closure').toBe(0);

      // The source stays observable: the cap path registers without a closure (C14).
      const registerWithoutClosure = await entry<(c: pg.PoolClient, input: Record<string, unknown>) => Promise<unknown>>('ledger/invalidation.ts', ['registerWithoutClosure']);
      const input = await w.registerInput({ op: 'register', label: 'R1', sourceKey: 'checkout.config/db.pool_max' });
      await w.inTx((client) => registerWithoutClosure(client, input));
      const cur = await w.currentOf('test', 'checkout.config/db.pool_max');
      expect(cur?.revision, 'registerWithoutClosure must register the new revision').toBe(w.baseOf('checkout.config/db.pool_max') + 1);
      expect((await w.receiptById(firstReceipt))?.status).toBe('superseded');
      const flippedAfter = await w.admin.query(`SELECT count(*)::int AS n FROM ${T.attempts} WHERE "${attemptStatus}" = 'invalidated'`);
      expect(flippedAfter.rows[0].n, 'the skip path must not compute a closure').toBe(0);
      void missionId;
    } finally {
      await w.close();
    }
  });
}

describe('gate 1 cycle and cap rejections (frozen oracle RJ-*)', () => {
  for (const c of REJECTION_CASES) {
    const name = `${tag(c.covers)} ${c.id} ${c.title}`;
    if (c.operation.kind === 'plan') it(name, () => planRejection(c as never));
    else if (c.operation.kind === 'delegate') it(name, () => delegationRejection(c as never));
    else if (c.operation.kind === 'edge') it(name, () => edgeRejection(c as never));
    else it(name, () => generatedRejection(c as never), 300_000);
  }

  for (const c of REJECTION_CASES.filter((x) => x.expected.afterwards)) {
    it(`[G1.8] ${c.id} watcher path after a refused closure pauses the missions and records a coarse event`, async () => {
      const op = c.operation;
      if (op.kind !== 'generated') throw new Error('oracle changed shape');
      await withAccDatabase(async (db) => {
        const w = new World(db);
        try {
          const watcher = await entry<unknown>('watcher/watcher.ts', ['processSourceChange', 'pollOnce', 'runOnce', 'tick']);
          if (typeof watcher !== 'function') throw new Error('DRIVER WIRING: watcher/watcher.ts export is not a function; bind it in closure.test.ts');
          const { missionId } = await seedGenerated(w, op.shape, op.size);
          await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 9, actor: 'injector' });
          await (watcher as (db: pg.Pool) => Promise<unknown>)(w.app);
          const cur = await w.currentOf('test', 'checkout.config/db.pool_max');
          expect(cur?.revision, 'the receipt must be registered despite the cap').toBe(w.baseOf('checkout.config/db.pool_max') + 1);
          const status = await w.admin.query(`SELECT status FROM ${T.missions} WHERE id = $1`, [missionId]);
          expect(status.rows[0].status).toBe('paused');
          const closure = await w.admin.query(`SELECT closure FROM ${T.invalidations}`);
          expect(closure.rows.some((r) => (r.closure as { capped?: boolean })?.capped === true), 'a coarse capped invalidation event must exist').toBe(true);
          const kinds = await w.admin.query('SELECT kind FROM coordinator.recovery_events WHERE mission_id = $1', [missionId]);
          expect(kinds.rows.map((r) => r.kind)).toContain(c.expected.afterwards!.recoveryKind);
        } finally {
          await w.close();
        }
      });
    }, 300_000);
  }
});
