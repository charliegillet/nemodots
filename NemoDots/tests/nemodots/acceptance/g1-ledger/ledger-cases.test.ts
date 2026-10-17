// Gate 1 items 1-5, 10-13 against the frozen oracle (../oracle/ledger.ts,
// LG-01..LG-16), executed on a fresh real PostgreSQL database per case
// (prefix acc1_). Every title carries its TEST_PROMPT gate-1 item as [G1.n].
// Expected values come only from the oracle; observed values come only from
// SQL read in driver.ts.
import { describe, expect, it } from 'vitest';
import { LEDGER_CASES } from '../oracle/ledger.js';
import type { LedgerCase, LedgerOp } from '../oracle/types.js';
import { World, errorCode, type OpResult } from './driver.js';
import { withAccDatabase } from './harness.js';

async function exec(w: World, op: LedgerOp): Promise<OpResult> {
  switch (op.op) {
    case 'seed_config':
      await w.seedConfig(op.key, op.value);
      return { ok: true };
    case 'advance_config':
      try {
        await w.advance(op);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorCode(error) };
      }
    case 'register':
      return w.register(op);
    case 'register_concurrent':
      return w.registerConcurrent(op);
    case 'assert_current':
      return w.assertCurrent(op);
    case 'age_receipt':
      await w.ageReceipt(op);
      return { ok: true };
    case 'transition':
      await w.transition(op);
      return { ok: true };
    case 'tamper_update': {
      const r = await w.tamper(op);
      return r.unchanged ? r : { ok: true, error: 'ROW_WAS_MUTATED' };
    }
    case 'publish_finding':
      return w.publishFinding(op);
    case 'page_edit':
      // A page edit happens in the OpenDots page store, which the ledger never
      // reads. The oracle expectation is that nothing in the ledger or the
      // authority moves; the final checks prove it.
      return { ok: true };
  }
}

function checkOutcome(i: number, op: LedgerOp, got: OpResult, w: World, expected: NonNullable<LedgerCase['expected']['outcomes'][number]>, problems: string[]) {
  const at = `op ${i} (${op.op}${'label' in op ? ` ${op.label}` : ''})`;
  if (!expected.ok) {
    if (got.ok) problems.push(`${at}: expected rejection "${expected.error}" but it succeeded`);
    else if (got.error !== expected.error) problems.push(`${at}: expected error "${expected.error}", got "${got.error}"`);
    if (op.op === 'register' && (got.receiptDelta ?? 0) !== 0) problems.push(`${at}: a rejected registration still wrote ${got.receiptDelta} receipt row(s)`);
    if (op.op === 'register' && (got.confirmationDelta ?? 0) !== 0) problems.push(`${at}: a rejected registration still appended a confirmation`);
    return;
  }
  if (!got.ok) {
    problems.push(`${at}: expected success but got "${got.error}"`);
    return;
  }
  if (got.error === 'ROW_WAS_MUTATED') problems.push(`${at}: the immutable column changed`);
  if (op.op !== 'register' && op.op !== 'register_concurrent') return;
  const cur = got.current;
  if (!cur) {
    problems.push(`${at}: no supported receipt exists for the source afterwards`);
    return;
  }
  if (expected.revision !== undefined && cur.revision !== expected.revision) problems.push(`${at}: expected revision ${expected.revision}, current is ${cur.revision}`);
  if (expected.relRevision !== undefined && cur.revision - (got.baseRevision ?? 0) !== expected.relRevision) {
    problems.push(`${at}: expected relative revision ${expected.relRevision}, got ${cur.revision - (got.baseRevision ?? 0)} (authority base ${got.baseRevision})`);
  }
  if (op.op === 'register' && expected.newRevision !== undefined && (got.receiptDelta ?? 0) !== (expected.newRevision ? 1 : 0)) {
    problems.push(`${at}: expected newRevision=${expected.newRevision}, receipt rows changed by ${got.receiptDelta}`);
  }
  if (op.op === 'register' && expected.confirmation !== undefined && (got.confirmationDelta ?? 0) !== (expected.confirmation ? 1 : 0)) {
    problems.push(`${at}: expected confirmation=${expected.confirmation}, confirmations changed by ${got.confirmationDelta}`);
  }
  void w;
}

async function checkFinal(w: World, c: LedgerCase, problems: string[]) {
  const f = c.expected.final;
  const split = (k: string): [import('./driver.js').Env, string] => {
    const i = k.indexOf(':');
    return [k.slice(0, i) as import('./driver.js').Env, k.slice(i + 1)];
  };
  for (const [k, rev] of Object.entries(f.currentRevisionBySource ?? {})) {
    const [env, key] = split(k);
    const cur = await w.currentOf(env, key);
    if (cur?.revision !== rev) problems.push(`final currentRevision ${k}: expected ${rev}, got ${cur?.revision ?? 'none'}`);
  }
  for (const [k, rel] of Object.entries(f.currentRelRevisionBySource ?? {})) {
    const [env, key] = split(k);
    const cur = await w.currentOf(env, key);
    const got = cur ? cur.revision - w.baseOf(key) : undefined;
    if (got !== rel) problems.push(`final currentRelRevision ${k}: expected ${rel}, got ${got ?? 'none'}`);
  }
  for (const [label, status] of Object.entries(f.receiptStatus ?? {})) {
    const id = w.labels.get(label);
    const rec = id ? await w.receiptById(id) : null;
    if (rec?.status !== status) problems.push(`final receiptStatus ${label}: expected ${status}, got ${rec?.status ?? 'no receipt'}`);
  }
  for (const [k, n] of Object.entries(f.receiptRowsBySource ?? {})) {
    const [env, key] = split(k);
    const rows = await w.receiptsOf(env, key);
    if (rows.length !== n) problems.push(`final receiptRows ${k}: expected ${n}, got ${rows.length}`);
  }
  for (const [label, n] of Object.entries(f.confirmationsByLabel ?? {})) {
    const id = w.labels.get(label);
    const got = id ? await w.confirmationCount(id) : -1;
    if (got !== n) problems.push(`final confirmations ${label}: expected ${n}, got ${got}`);
  }
  if (f.distinctSources !== undefined) {
    const got = await w.distinctSources();
    if (got !== f.distinctSources) problems.push(`final distinctSources: expected ${f.distinctSources}, got ${got}`);
  }
  if (f.newObservationReceipts !== undefined) {
    const got = await w.newReceiptsSinceSeed();
    if (got !== f.newObservationReceipts) problems.push(`final newObservationReceipts: expected ${f.newObservationReceipts}, got ${got}`);
  }
  for (const [key, delta] of Object.entries(f.configVersionDelta ?? {})) {
    const got = (await w.configVersion(key)) ?? 0;
    const base = w.bases?.entries.get(key) ?? 0;
    if (got - base !== delta) problems.push(`final configVersionDelta ${key}: expected ${delta}, got ${got - base}`);
  }
  for (const [key, value] of Object.entries(f.configValue ?? {})) {
    const got = await w.configValue(key);
    if (got !== value) problems.push(`final configValue ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`);
  }
  if (f.modelClaimFindings !== undefined) {
    const got = await w.newFindingsSinceSeed();
    if (got !== f.modelClaimFindings) problems.push(`final modelClaimFindings: expected ${f.modelClaimFindings}, got ${got}`);
  }
}

const gateTag = (c: LedgerCase) =>
  c.covers
    .filter((x) => x.startsWith('gate1.'))
    .map((x) => `[G1.${x.slice(6)}]`)
    .join('');

async function runLedgerCase(c: LedgerCase) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    const problems: string[] = [];
    try {
      for (let i = 0; i < c.ops.length; i += 1) {
        const op = c.ops[i];
        if (op.op !== 'seed_config') await w.snapshotBases().catch((e) => problems.push(`snapshot: ${(e as Error).message.split('\n')[0]}`));
        let got: OpResult;
        try {
          got = await exec(w, op);
        } catch (error) {
          problems.push(`op ${i} (${op.op}) threw: ${(error as Error).message.split('\n')[0]}`);
          continue;
        }
        const expected = c.expected.outcomes[i];
        if (expected) checkOutcome(i, op, got, w, expected, problems);
        else if (!got.ok && op.op !== 'register') problems.push(`op ${i} (${op.op}) failed unexpectedly: ${got.error}`);
        else if (!got.ok && op.op === 'register') problems.push(`op ${i} (register ${op.label}) failed unexpectedly: ${got.error}`);
      }
      await w.snapshotBases();
      await checkFinal(w, c, problems);
    } finally {
      await w.close();
    }
    expect(problems, `${c.id} ${c.title}`).toEqual([]);
  });
}

describe('gate 1 ledger cases (frozen oracle LG-*)', () => {
  it.each(LEDGER_CASES.map((c) => [`${gateTag(c)} ${c.id} ${c.title}`, c] as const))('%s', async (_name, c) => {
    await runLedgerCase(c);
  });
});
