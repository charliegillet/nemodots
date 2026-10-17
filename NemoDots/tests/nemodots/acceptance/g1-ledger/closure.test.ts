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
import { APP_ROOT, entry, fillRow, insertRow, insertValues, withAccDatabase } from './harness.js';
import { T, applyAuthority, mapIds, observeClosure, registerChange, seedGraph } from './graph.js';

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
      if (!sortedEq(obs.attemptsInvalidated, expectAffected.attemptIds)) problems.push(`attempt rows invalidated: expected ${JSON.stringify(e.affected.attemptIds)}, got ${JSON.stringify(obs.attemptsInvalidated.map((id) => seeded.reverse.get(id) ?? id))}`);
      if (!sortedEq(obs.outputsUnusable, expectAffected.outputIds)) problems.push(`outputs made unusable: expected ${JSON.stringify(e.affected.outputIds)}, got ${JSON.stringify(obs.outputsUnusable.map((id) => seeded.reverse.get(id) ?? id))}`);
      if (!sortedEq(obs.tasksInvalidated, expectAffected.taskIds)) problems.push(`task rows invalidated: expected ${JSON.stringify(e.affected.taskIds)}, got ${JSON.stringify(obs.tasksInvalidated.map((id) => seeded.reverse.get(id) ?? id))}`);

      for (const [intent, want] of Object.entries(e.intentStatusAfter)) {
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
        if ((obs.coordinatorEventsByMission.get(mid) ?? 0) < 1) problems.push(`mission ${pm.missionId}: no invalidation.recorded event was emitted`);
      }
      for (const [oracleMission, mid] of seeded.missions) {
        if (expectedMissions.has(mid)) continue;
        const leaked = obs.perMission.get(mid);
        if (leaked && Object.values(leaked.affected).some((x) => x.length)) problems.push(`unaffected mission ${oracleMission} received affected nodes in the event`);
        if ((obs.coordinatorEventsByMission.get(mid) ?? 0) > 0) problems.push(`unaffected mission ${oracleMission} received an invalidation.recorded event`);
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

const planTask = (i: number, dependsOn: number[]) => ({
  title: `acc task ${i}`,
  question: 'acceptance question',
  role: 'investigator',
  capabilities: ['observe'],
  dependsOn,
});

async function countRows(w: World, table: string) {
  if (!(await w.schema.exists(table))) return 0;
  return (await w.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
}

async function runSchedulingRejection(c: RejectionCase & { operation: { kind: 'plan' | 'delegate' } }) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      const missionId = randomUUID();
      await insertRow(w.admin, w.schema, T.missions, { id: missionId, status: 'running' });
      const before = await countRows(w, T.tasks);
      let error: unknown = null;
      if (c.operation.kind === 'plan') {
        const persistPlan = await entry<(db: pg.Pool, input: Record<string, unknown>) => Promise<unknown>>('coordinator/tasks.ts', ['persistPlan', 'createPlan', 'planMission']);
        try {
          await persistPlan(w.app, { missionId, plan: { tasks: c.operation.dependsOn.map((deps, i) => planTask(i, deps)) } });
        } catch (e) {
          error = e;
        }
      } else {
        const op = c.operation;
        // Existing graph: parents and waits, seeded as tasks; then the delegation under test.
        const real = new Map<string, string>();
        for (const t of op.existing) {
          const id = randomUUID();
          real.set(t.id, id);
          await insertRow(w.admin, w.schema, T.tasks, { id, mission_id: missionId, ...(t.parentTaskId ? { parent_id: real.get(t.parentTaskId) } : {}), role: 'investigator', status: 'waiting' });
        }
        const delegateTask = await entry<(db: pg.Pool, input: Record<string, unknown>) => Promise<unknown>>('coordinator/tasks.ts', ['delegateTask', 'delegate']);
        try {
          await delegateTask(w.app, {
            missionId,
            parentTaskId: real.get(op.parentTaskId),
            child: { ...planTask(9, []), dependsOn: op.childDependsOn.map((id) => real.get(id)) },
          });
        } catch (e) {
          error = e;
        }
      }
      const code = error ? errorCode(error) : 'accepted';
      expect(c.expected.acceptedCodes as string[], `${c.id}: got ${code}`).toContain(code);
      if (c.operation.kind === 'plan') expect(await countRows(w, T.tasks), 'a rejected plan must write no task rows').toBe(before);
    } finally {
      await w.close();
    }
  });
}

async function runEdgeRejection(c: RejectionCase & { operation: { kind: 'edge' } }) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      const op = c.operation;
      const seeded = await seedGraph(w, op.nodes, op.existing);
      const addEdge = await entry<(db: pg.Pool, input: Record<string, unknown>) => Promise<unknown>>('ledger/edges.ts', ['addEdge', 'insertEdge', 'recordEdge']);
      const before = await countRows(w, T.edges);
      const node = (id: string) => op.nodes.find((n) => n.id === id)!;
      let error: unknown = null;
      try {
        await addEdge(w.app, {
          missionId: seeded.missions.get(node(op.add.to).missionId),
          kind: op.add.kind,
          from: { kind: node(op.add.from).kind, id: seeded.ids.get(op.add.from) },
          to: { kind: node(op.add.to).kind, id: seeded.ids.get(op.add.to) },
        });
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
  const task = await insertRow(w.admin, w.schema, T.tasks, { id: randomUUID(), mission_id: missionId, status: 'succeeded', role: 'investigator' });
  const idCol = 'id';
  const taskCol = await w.schema.need(T.attempts, ['task_id']);
  const statusCol = await w.schema.need(T.attempts, ['status']);
  const attemptTemplate = await fillRow(w.admin, w.schema, T.attempts, { [idCol]: randomUUID(), [taskCol]: task.id, [statusCol]: 'published' }, { parents: { [T.missions]: missionId } });
  const attemptIds = Array.from({ length: size }, () => randomUUID());
  await insertValues(w.admin, T.attempts, attemptIds.map((id) => ({ ...attemptTemplate, [idCol]: id })));
  const mk = async (kind: 'evidence' | 'inheritance', fromKind: string, from: string, toKind: string, to: string) =>
    fillRow(w.admin, w.schema, T.edges, {
      [await w.schema.need(T.edges, ['mission_id'])]: missionId,
      [await w.schema.need(T.edges, ['kind', 'edge_kind'])]: kind,
      [await w.schema.need(T.edges, ['from_kind'])]: fromKind,
      [await w.schema.need(T.edges, ['from_id'])]: from,
      [await w.schema.need(T.edges, ['to_kind'])]: toKind,
      [await w.schema.need(T.edges, ['to_id'])]: to,
    });
  const rows: Record<string, unknown>[] = [];
  if (shape === 'fanout') {
    for (const a of attemptIds) rows.push(await mk('evidence', 'receipt', first.current.id, 'attempt', a));
  } else {
    // R0 -> A1; then A(i) -> O(i) -> A(i+1). Outputs reuse attempt-sized rows via task_outputs.
    const outputCols = {
      id: 'id',
      task: await w.schema.need(T.outputs, ['task_id']),
      attempt: await w.schema.pick(T.outputs, ['attempt_id']),
      usable: await w.schema.need(T.outputs, ['usable']),
    };
    const outputIds = attemptIds.map(() => randomUUID());
    const outTemplate = await fillRow(w.admin, w.schema, T.outputs, { id: randomUUID(), [outputCols.task]: task.id, [outputCols.usable]: true, ...(outputCols.attempt ? { [outputCols.attempt]: attemptIds[0] } : {}) }, { parents: { [T.missions]: missionId } });
    await insertValues(w.admin, T.outputs, outputIds.map((id) => ({ ...outTemplate, id })));
    rows.push(await mk('evidence', 'receipt', first.current.id, 'attempt', attemptIds[0]));
    for (let i = 0; i < size; i += 1) {
      rows.push(await mk('evidence', 'attempt', attemptIds[i], 'task_output', outputIds[i]));
      if (i + 1 < size) rows.push(await mk('inheritance', 'task_output', outputIds[i], 'attempt', attemptIds[i + 1]));
    }
  }
  await insertValues(w.admin, T.edges, rows);
  return { missionId, firstReceipt: first.current.id };
}

async function runGeneratedRejection(c: RejectionCase & { operation: { kind: 'generated' } }) {
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

      // The source must stay observable: the cap path registers without a closure (C14).
      const registerWithoutClosure = await entry<(db: pg.Pool, input: Record<string, unknown>) => Promise<unknown>>('ledger/invalidation.ts', ['registerWithoutClosure']);
      await registerWithoutClosure(w.app, {
        scope: w.scope('test'),
        sourceKey: 'checkout.config/db.pool_max',
        provenance: { kind: 'watcher', toolCallId: null, modelCallId: null, attemptId: null, causedByActionId: null, selfWrite: 'none' },
      });
      const cur = await w.currentOf('test', 'checkout.config/db.pool_max');
      expect(cur?.revision, 'registerWithoutClosure must register the new revision').toBe(w.baseOf('checkout.config/db.pool_max') + 1);
      expect((await w.receiptById(firstReceipt))?.status).toBe('superseded');
      void missionId;
    } finally {
      await w.close();
    }
  });
}

describe('gate 1 cycle and cap rejections (frozen oracle RJ-*)', () => {
  for (const c of REJECTION_CASES) {
    const name = `${tag(c.covers)} ${c.id} ${c.title}`;
    if (c.operation.kind === 'plan' || c.operation.kind === 'delegate') it(name, () => runSchedulingRejection(c as never));
    else if (c.operation.kind === 'edge') it(name, () => runEdgeRejection(c as never));
    else it(name, () => runGeneratedRejection(c as never), 300_000);
  }

  it.each(REJECTION_CASES.filter((c) => c.expected.afterwards).map((c) => [`[G1.8] ${c.id} watcher path after a refused closure pauses the missions and records a coarse event`, c] as const))('%s', async (_name, c) => {
    if (c.operation.kind !== 'generated') throw new Error('oracle changed shape');
    await withAccDatabase(async (db) => {
      const w = new World(db);
      try {
        const watcher = await entry<Record<string, unknown>>('watcher/watcher.ts', ['createWatcher', 'pollOnce', 'runOnce', 'tick']);
        const { missionId } = await seedGenerated(w, c.operation.shape, c.operation.size);
        await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 9, actor: 'injector' });
        // Drive one watcher pass. The factory form returns an object with the pass; the function form is the pass.
        const pass = typeof watcher === 'function' ? (watcher as unknown as (db: pg.Pool) => Promise<unknown>)(w.app) : null;
        await pass;
        const cur = await w.currentOf('test', 'checkout.config/db.pool_max');
        expect(cur?.revision, 'the receipt must be registered despite the cap').toBe(w.baseOf('checkout.config/db.pool_max') + 1);
        const status = await w.admin.query(`SELECT status FROM ${T.missions} WHERE id = $1`, [missionId]);
        expect(status.rows[0].status).toBe('paused');
        const closure = await w.admin.query(`SELECT closure FROM ${T.invalidations}`);
        expect(closure.rows.some((r) => (r.closure as { capped?: boolean })?.capped === true), 'a coarse capped invalidation event must exist').toBe(true);
        const kinds = await w.admin.query(`SELECT kind FROM coordinator.recovery_events WHERE mission_id = $1`, [missionId]);
        expect(kinds.rows.map((r) => r.kind)).toContain(c.expected.afterwards!.recoveryKind);
      } finally {
        await w.close();
      }
    });
  }, 300_000);
});
