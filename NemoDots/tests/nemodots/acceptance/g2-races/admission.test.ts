// TEST_PROMPT gate 2 cases 1-8 plus ADM-17/ADM-18 (admission, ordering,
// binding, vectors, freshness, citation scope). Every test checks the
// authoritative version, the actual config value and the audit receipt
// (coordinator.authorizations) together.
//
// Two paths can stop a stale intent and the suite keeps them apart:
// - COMMIT-STAGE path: the change was NOT registered in the ledger, so the
//   invalidation closure cannot have fired; only the commit transaction's own
//   re-validation under lock can refuse. These tests require the commit-stage
//   Authorization row.
// - CLOSURE path (ARCH 5.2 step 4): the change WAS registered, the closure has
//   already moved the live intent to blocked(stale_version). The oracle
//   (ADM-01/02/04/07/08) requires the Authorization row of the stage that
//   decided. Lead ruling 2026-10-18: the tests named after those cases assert
//   the oracle exactly; a closure-only block without that row FAILS (a blocked
//   intent must be inspectable). G2-07d (ADM-07b) and the unnamed variants
//   still accept either path, backed by an invalidation event naming the intent.
import { describe, expect, it } from 'vitest';
import {
  ADMISSION_CASES,
  ORDERS,
  POOL,
  ROUTING,
  SETUP_CONFIG,
  TIMEOUT,
  authSummary,
  checkOutcome,
  commitSettled,
  errText,
  isSettled,
  parkedRace,
  withTimeout,
  withWorld,
  type Rec,
  type World,
} from './harness.js';
import {
  expectNoMutation,
  expectRefusedCommit,
  expectSerializable,
  expectStaleBlocked,
} from './asserts.js';
import type { AdmissionOutcome } from '../oracle/admission.js';

const SETUP_POOL = SETUP_CONFIG[POOL];
const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;
const TIMEOUT_CITES = [
  'member:db.pool_max',
  'member:db.statement_timeout_ms',
  'health',
];

function oracleOutcome(id: string): AdmissionOutcome {
  const c = ADMISSION_CASES.find((x) => x.id === id);
  if (!c || 'anyOf' in c.expected)
    throw new Error(`oracle case ${id} is missing or has alternatives`);
  return c.expected;
}

async function liveRowsFor(w: World, toolCallId: string) {
  return (
    await w.admin.query(
      `SELECT id, status, block_reason FROM coordinator.action_intents
        WHERE tool_call_id=$1 AND status IN ('proposed','admitted','committed','dispatched','outcome_unknown')`,
      [toolCallId],
    )
  ).rows;
}

describe('G2 admission and races: cases 1-8', () => {
  it('G2-01 ADM-01 stale before admission: propose from r1, register r2, admit r1 is blocked with the admission Authorization row and no mutation', async () => {
    await withWorld(async (w) => {
      const base = await w.snapshotConfig();
      const i = await w.propose(w.poolSpec('tc-1'));
      await w.advance(POOL, 4, { register: true });
      await w.actions.admit(i.id, 'd1');
      await checkOutcome(w, oracleOutcome('ADM-01'), {
        intents: { I: i.id },
        base,
      });
      await expectNoMutation(w, base, [POOL]);
      expect((await w.cfg(POOL)).causedBy).toBeNull();
    });
  });

  it('G2-01b ADM-01b stale before admission with the replacement not yet observed is blocked at admission as stale_pending_observation', async () => {
    await withWorld(async (w) => {
      const base = await w.snapshotConfig();
      const i = await w.propose(w.poolSpec('tc-1'));
      await w.advance(POOL, 4, { register: false });
      await w.actions.admit(i.id, 'd1');
      await checkOutcome(w, oracleOutcome('ADM-01b'), {
        intents: { I: i.id },
        base,
      });
    });
  });

  describe('G2-02 stale between the local check and the commit lock', () => {
    it('G2-02 ADM-02 pause after the preliminary read, register r2, resume: the injector serializes first and the commit stage blocks r1', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        const r = await parkedRace(
          w,
          'after_preliminary_read',
          () => w.actions.commit(i.id, fence(i)),
          () => w.advance(POOL, 4, { register: true }),
        );
        expect('err' in r.duringResult, 'the injector write succeeds').toBe(
          false,
        );
        // oracle serialization ['injector']: the only change after r1 is the injector's
        expect(
          (await w.history(POOL))
            .filter((h) => Number(h.version) > base[POOL].version)
            .map((h) => h.caused_by_actor),
        ).toEqual(['injector']);
        await checkOutcome(w, oracleOutcome('ADM-02'), {
          intents: { I: i.id },
          base,
        });
      });
    });

    it('G2-02b before the commit locks (barrier precedes every lock): an unregistered target change is refused by the commit-stage re-validation', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        const r = await parkedRace(
          w,
          'before_lock',
          () => w.actions.commit(i.id, fence(i)),
          () => w.advance(POOL, 4, { register: false }),
        );
        expect(
          r.blockedOnCommit,
          'before_lock must precede every lock the commit takes',
        ).toBe(false);
        expect('err' in r.duringResult).toBe(false);
        await expectStaleBlocked(w, i.id, { changedKey: POOL, path: 'commit' });
        expect(await w.cfg(POOL)).toMatchObject({
          version: base[POOL].version + 1,
          value: 4,
          causedBy: null,
        });
        expect(await w.actionRows()).toBe(0);
        expect((await w.history(POOL)).at(-1)?.caused_by_actor).toBe(
          'injector',
        );
      });
    });

    it('G2-02c inside the after_preliminary_read barrier an unregistered change to a NON-target cited source must not let the commit through', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1', 12, TIMEOUT_CITES));
        const r = await parkedRace(
          w,
          'after_preliminary_read',
          () => w.actions.commit(i.id, fence(i)),
          () => w.advance(TIMEOUT, 90, { register: false }),
        );
        const order = await expectSerializable(w, i.id, TIMEOUT);
        if (order === 'change_first') {
          // decided by the commit stage alone: nothing was registered
          await expectStaleBlocked(w, i.id, {
            changedKey: TIMEOUT,
            path: 'commit',
          });
          expect(await w.cfg(POOL)).toMatchObject({
            version: base[POOL].version,
            value: SETUP_POOL,
          });
          expect(await w.actionRows()).toBe(0);
        } else {
          expect(r.blockedOnCommit).toBe(true); // the commit held the vector locks first
        }
        expect(await w.cfg(TIMEOUT)).toMatchObject({
          version: base[TIMEOUT].version + 1,
          value: 90,
        });
      });
    });

    it('G2-02d before the commit locks an unregistered change to a NON-target cited source is refused at commit stage', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1', 12, TIMEOUT_CITES));
        const r = await parkedRace(
          w,
          'before_lock',
          () => w.actions.commit(i.id, fence(i)),
          () => w.advance(TIMEOUT, 90, { register: false }),
        );
        expect(r.blockedOnCommit).toBe(false);
        await expectStaleBlocked(w, i.id, {
          changedKey: TIMEOUT,
          path: 'commit',
        });
        expect(await w.cfg(POOL)).toMatchObject({
          version: base[POOL].version,
          value: SETUP_POOL,
          causedBy: null,
        });
        expect(await w.actionRows()).toBe(0);
      });
    });
  });

  it('G2-03a ADM-03a concurrent commit ordering: the commit takes the row lock first, the racing injector write serializes after and fails', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      const parked = w.park('after_lock_before_commit');
      const commit = w.actions.commit(i.id, fence(i));
      await parked.reached;
      const injector = w.advance(POOL, 4, { expectedVersion: v1 }).then(
        () => 'ok',
        (e) => errText(e),
      );
      expect(await isSettled(injector, 300)).toBe(false);
      expect(
        await w.anyBlocked(),
        'the injector must be waiting on the action’s row lock',
      ).toBe(true);
      parked.release();
      await commit;
      expect(await injector).toContain('stale_version');
      expect((await w.intent(i.id)).status).toBe('committed');
      expect(await w.cfg(POOL)).toMatchObject({
        version: v1 + 1,
        value: 12,
        causedBy: i.id,
      });
      expect(
        (await w.history(POOL))
          .filter((r) => Number(r.version) > v1)
          .map((r) => r.caused_by_action_id ?? r.caused_by_actor),
      ).toEqual([i.id]);
      expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
        'admitted',
        'committed',
      ]);
      expect((await w.resultReceipts(i.id)).length).toBe(1);
      expect(await w.actionRows()).toBe(1);
    });
  });

  it('G2-03b concurrent commit ordering: the injector holds the lock first, the commit waits then rejects r1 at commit stage', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      const hold = await w.holdRowLock(POOL, 4);
      const commit = w.actions.commit(i.id, fence(i)).then(
        (x) => ({ returned: x }),
        (e) => ({ threw: e }),
      );
      expect(await isSettled(commit, 300)).toBe(false);
      expect(await w.anyBlocked()).toBe(true);
      await hold.commit();
      await commit;
      // Lead ruling 2026-10-18: the replacement is NOT registered at this step,
      // so the one code the setup implies is stale_pending_observation. The
      // frozen ADM-03b row says stale_version (README proposal 3), so this
      // test is not named ADM-03b until the oracle is revised.
      await expectStaleBlocked(w, i.id, {
        changedKey: POOL,
        path: 'commit',
        reasons: ['stale_pending_observation'],
      });
      expect(await w.cfg(POOL)).toMatchObject({
        version: v1 + 1,
        value: 4,
        causedBy: null,
      });
      expect(await w.actionRows()).toBe(0);
      expect(
        (await w.history(POOL))
          .filter((r) => Number(r.version) > v1)
          .map((r) => r.caused_by_actor),
      ).toEqual(['injector']);
    });
  });

  describe('G2-04 approval race', () => {
    it('G2-04a approve the r1 payload, the change is NOT registered, the callback revalidates and rejects at commit stage', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1')); // admission == approval of the r1 payload
        await w.advance(POOL, 4, { register: false });
        await commitSettled(w, i.id, fence(i)); // the callback
        await expectStaleBlocked(w, i.id, { changedKey: POOL, path: 'commit' });
        expect(await w.cfg(POOL)).toMatchObject({
          version: base[POOL].version + 1,
          value: 4,
        });
        expect(await w.actionRows()).toBe(0);
      });
    });

    it('G2-04b ADM-04 approve the r1 payload, register r2, invoke the callback: blocked with the commit-stage Authorization row', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        await w.advance(POOL, 4, { register: true });
        await commitSettled(w, i.id, fence(i));
        await checkOutcome(w, oracleOutcome('ADM-04'), {
          intents: { I: i.id },
          base,
        });
      });
    });
  });

  describe('G2-05 payload binding', () => {
    it('G2-05a ADM-05a ADM-05b a reused idempotency key (same tool call) with a different payload is rejected; the same payload returns the stored intent; the original stays usable', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const a = await w.propose(w.poolSpec('tc-1', 12));
        const again = await w.propose(w.poolSpec('tc-1', 12));
        expect(again.id).toBe(a.id);
        expect(again.statusVersion).toBe(a.statusVersion);
        expect(again.status).toBe('proposed');
        expect(await liveRowsFor(w, 'tc-1')).toHaveLength(1);
        // ADM-05a: the tampered proposal is a blocked(idempotency_conflict) intent, not a throw
        const tampered = await w.propose(w.poolSpec('tc-1', 13));
        expect(tampered.id).not.toBe(a.id);
        expect(tampered.status).toBe('blocked');
        expect(tampered.blockReason).toBe('idempotency_conflict');
        expect(await liveRowsFor(w, 'tc-1')).toHaveLength(1);
        await checkOutcome(w, oracleOutcome('ADM-05a'), {
          intents: { I: a.id, I_tampered: tampered.id },
          base,
        });
        const admitted = await w.actions.admit(a.id, 'd1');
        expect(admitted.status).toBe('admitted');
        await checkOutcome(
          w,
          {
            intents: {},
            config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
            actionRows: 0,
            neverValue: { key: POOL, value: 13 },
          },
          { intents: {}, base },
        );
      });
    });

    it('G2-05b ADM-05c a new tool call may re-propose an identical payload after a block, and commits against r2', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const v1 = base[POOL].version;
        const i1 = await w.propose(w.poolSpec('tc-1'));
        await w.advance(POOL, 4, { register: true });
        await w.actions.admit(i1.id, 'd1');
        expect((await w.intent(i1.id)).status).toBe('blocked');
        // a new proposing attempt re-reads r2; its payload binds the new current value
        const i2 = await w.proposeAdmit(w.poolSpec('tc-2', 12));
        expect(i2.id).not.toBe(i1.id);
        await w.actions.commit(i2.id, fence(i2));
        expect((await w.intent(i2.id)).status).toBe('committed');
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1 + 2,
          value: 12,
          causedBy: i2.id,
        });
        expect(await w.actionRows()).toBe(1);
        expect((await w.resultReceipts(i2.id)).length).toBe(1);
        expect((await w.resultReceipts(i1.id)).length).toBe(0);
        await checkOutcome(w, oracleOutcome('ADM-05c'), {
          intents: { I: i1.id, I2: i2.id },
          base,
        });
      });
    });

    it('G2-05c ADM-05d payload, dependency vector, policy, target key, resource or environment changed after admission cannot commit without fresh authorization', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const cols = (
          await w.admin.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema='coordinator' AND table_name='action_intents'`,
          )
        ).rows.map((r) => r.column_name as string);
        for (const c of [
          'payload',
          'dependency_vector',
          'policy_version',
          'target',
        ])
          expect(
            cols,
            `SCHEMA BINDING: coordinator.action_intents.${c} is missing; the tamper statements below would test nothing`,
          ).toContain(c);
        const cases = [
          {
            name: 'payload_value',
            set: `payload = jsonb_set(payload,'{value}','13')`,
            reasons: ['payload_invalid', 'idempotency_conflict'],
          },
          {
            name: 'dependency_vector_drop_target',
            set: `dependency_vector = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(dependency_vector) e
                    WHERE e->>'sourceKey' <> 'checkout.config/${POOL}'),'[]'::jsonb)`,
            reasons: ['missing_required_source'],
          },
          {
            name: 'policy_version',
            set: `policy_version = 'policy-v0'`,
            reasons: ['policy_version_mismatch'],
          },
          {
            name: 'target_key',
            set: `target = jsonb_set(target,'{sourceKey}','"checkout.config/${TIMEOUT}"')`,
            reasons: ['payload_invalid'],
          },
          {
            name: 'target_resource',
            set: `target = jsonb_set(target,'{resource}','"other-resource"')`,
            reasons: [
              'payload_invalid',
              'idempotency_conflict',
              'target_version_mismatch',
            ],
          },
          {
            name: 'target_environment',
            set: `target = jsonb_set(target,'{environment}','"eval"')`,
            reasons: [
              'payload_invalid',
              'idempotency_conflict',
              'target_version_mismatch',
            ],
          },
        ];
        let n = 0;
        for (const c of cases) {
          n += 1;
          const i = await w.proposeAdmit(w.poolSpec(`tc-bind-${n}`));
          const tamper = await w.app
            .query(
              `UPDATE coordinator.action_intents SET ${c.set} WHERE id=$1`,
              [i.id],
            )
            .then(
              () => ({ changed: true as const }),
              (e: { code?: string; message?: string }) => ({ e }),
            );
          if ('changed' in tamper) {
            // The row accepted the change: the commit must refuse it.
            const out = await commitSettled(w, i.id, fence(i));
            const row = await w.intent(i.id);
            expect(
              row.status,
              `${c.name}: must not commit (${Object.keys(out).join()})`,
            ).toBe('blocked');
            expect(c.reasons, `${c.name}: block reason`).toContain(
              row.block_reason,
            );
            const stage = (await w.auths(i.id)).find(
              (a) => a.stage === 'commit' && a.decision === 'blocked',
            );
            expect(stage, `${c.name}: commit-stage block row`).toBeTruthy();
            expect(stage!.block_reason).toBe(row.block_reason);
          } else {
            // Sealed row: the statement must be refused for the RIGHT reason (not a typo in the test).
            const { e } = tamper;
            expect(
              e.code,
              `${c.name}: unexpected SQL error ${e.code} ${e.message}`,
            ).toMatch(/^(42501|P0001|23\d{3}|55\w{3})$/);
            expect(e.message ?? '').toMatch(
              /immutable|permission denied|sealed|read-?only|cannot (be )?(change|modif|updat)/i,
            );
            const row = await w.intent(i.id);
            expect(row.status, `${c.name}: untouched`).toBe('admitted');
            expect(row.policy_version).toBe('policy-v1');
          }
        }
        await expectNoMutation(w, base);
        expect(
          (await w.history(POOL)).some((h) => h.value === 13),
          'the tampered value must never reach the history',
        ).toBe(false);
      });
    });
  });

  describe('G2-05e tamper after admission', () => {
    it('G2-05e ADM-05e dependency vector, policy version or target key changed after admission: all three sealed, or all three blocked with their own reason (one oracle branch, never a mix)', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const steps = [
          {
            label: 'I',
            tc: 'tc-1',
            set: `dependency_vector = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(dependency_vector) e
                    WHERE e->>'sourceKey' <> 'checkout.config/${POOL}'),'[]'::jsonb)`,
            reason: 'missing_required_source',
          },
          {
            label: 'J',
            tc: 'tc-2',
            set: `policy_version = 'policy-v0'`,
            reason: 'policy_version_mismatch',
          },
          {
            label: 'K',
            tc: 'tc-3',
            set: `target = jsonb_set(target,'{sourceKey}','"checkout.config/${TIMEOUT}"')`,
            reason: 'payload_invalid',
          },
        ];
        const seen: { label: string; id: string; sealed: boolean }[] = [];
        for (const step of steps) {
          const i = await w.proposeAdmit(w.poolSpec(step.tc));
          const tamper = await w.app
            .query(
              `UPDATE coordinator.action_intents SET ${step.set} WHERE id=$1`,
              [i.id],
            )
            .then(
              () => null,
              (e: { message?: string }) => e,
            );
          if (tamper) {
            // branch 1: thrown immutable_intent; the intent is never committed
            expect(tamper.message ?? '', `${step.label}: refusal`).toMatch(
              /immutable/i,
            );
          } else await commitSettled(w, i.id, fence(i));
          seen.push({ label: step.label, id: i.id, sealed: tamper !== null });
        }
        const sealed = seen.filter((x) => x.sealed).length;
        expect(
          [0, seen.length],
          `one oracle branch for all three intents (sealed: ${seen
            .filter((x) => x.sealed)
            .map((x) => x.label)
            .join(',')})`,
        ).toContain(sealed);
        for (const [n, x] of seen.entries()) {
          const row = await w.intent(x.id);
          if (x.sealed) expect(row.status, x.label).toBe('admitted');
          else {
            expect(row.status, x.label).toBe('blocked');
            expect(row.block_reason, x.label).toBe(steps[n].reason);
          }
        }
        for (const key of [POOL, TIMEOUT])
          expect(await w.cfg(key)).toMatchObject({
            version: base[key].version,
            value: base[key].value,
          });
        expect(await w.actionRows()).toBe(0);
      });
    });
  });

  describe('G2-06 missing predicates', () => {
    // One body, two explicit titles so the gate 2 case map can read the ids.
    const missingPredicate = (cites: string[]) => async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.propose(w.poolSpec('tc-1', 12, [...cites]));
        await w.actions.admit(i.id, 'd1').catch(() => null);
        const row = await w.intent(i.id);
        if (row.status === 'blocked')
          expect(row.block_reason).toBe('missing_required_source');
        else {
          expect(row.status).toBe('admitted');
          const vec = row.dependency_vector as {
            sourceKey: string;
            receiptId: string;
          }[];
          expect(vec.map((e) => e.sourceKey)).toEqual(
            expect.arrayContaining([
              `checkout.config/${POOL}`,
              'checkout.health',
            ]),
          );
          // the added support is the CURRENT receipt, not an invented one
          expect(
            vec.find((e) => e.sourceKey === 'checkout.health')?.receiptId,
          ).toBe(w.receiptId('health'));
          expect(
            vec.find((e) => e.sourceKey === `checkout.config/${POOL}`)
              ?.receiptId,
          ).toBe(w.receiptId(`member:${POOL}`));
        }
        await expectNoMutation(w, base);
      });
    };
    it(
      'G2-06 ADM-06a required health omitted: rejected, or the server adds the mandatory support and records it in the vector',
      missingPredicate(['member:db.pool_max']),
    );
    it(
      'G2-06 ADM-06b only an irrelevant valid receipt cited: rejected, or the server adds the mandatory support and records it in the vector',
      missingPredicate(['redis']),
    );

    it('G2-06c ADM-06c strict input: out-of-domain value, unknown action kind and an extra payload field are all blocked payload_invalid, or all thrown payload_invalid (one oracle branch, never a mix)', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const inputs: [string, () => Promise<unknown>][] = [
          ['I_domain', () => w.propose(w.poolSpec('tc-1', 50))],
          [
            'I_kind',
            () =>
              w.propose({
                action: 'unknown_kind' as never,
                payload: { table: 'checkout.orders' },
                cites: ['member:db.pool_max', 'health'],
                toolCallId: 'tc-2',
              }),
          ],
          [
            'I_extra',
            () =>
              w.propose({
                ...w.poolSpec('tc-3'),
                payload: { key: POOL, value: 12, causedByActionId: 'forged' },
              }),
          ],
        ];
        const outs: { label: string; i?: Rec; e?: unknown }[] = [];
        for (const [label, run] of inputs)
          outs.push(
            await run().then(
              (i) => ({ label, i: i as Rec }),
              (e) => ({ label, e }),
            ),
          );
        const thrown = outs.filter((o) => 'e' in o).length;
        expect(
          [0, outs.length],
          `one oracle branch for all three inputs (thrown: ${outs
            .filter((o) => 'e' in o)
            .map((o) => o.label)
            .join(',')})`,
        ).toContain(thrown);
        for (const o of outs) {
          if (o.e !== undefined)
            expect(errText(o.e), `${o.label}: thrown`).toContain(
              'payload_invalid',
            );
          else {
            const row = await w.intent(o.i!.id);
            expect(row.status, o.label).toBe('blocked');
            expect(row.block_reason, o.label).toBe('payload_invalid');
          }
        }
        await expectNoMutation(w, base);
        expect(
          (await w.history(POOL)).some((h) => h.value === 50),
          'the out-of-domain value never reaches the history',
        ).toBe(false);
      });
    });

    it('G2-06c2 strict input: smuggled policy fields (easier policy version, no required sources) are rejected as payload_invalid', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const cases: [string, () => Promise<unknown>][] = [
          [
            'easier policy version',
            () =>
              w.propose({
                ...w.poolSpec('tc-p'),
                extra: { policyVersion: 'policy-v0' },
              }),
          ],
          [
            'easier policy: no required sources',
            () =>
              w.propose({
                ...w.poolSpec('tc-r'),
                extra: {
                  requiredSources: [],
                  maxAgeMs: { 'checkout.health': 1e12 },
                },
              }),
          ],
        ];
        for (const [name, run] of cases) {
          const out = await run().then(
            (i) => ({ i: i as Rec }),
            (e) => ({ e }),
          );
          if ('i' in out) {
            const row = await w.intent(out.i.id);
            expect(row.status, name).toBe('blocked');
            expect(row.block_reason, name).toBe('payload_invalid');
          } else
            expect(errText(out.e), `${name}: thrown`).toContain(
              'payload_invalid',
            );
        }
        await expectNoMutation(w, base);
        const live = (
          await w.admin.query(
            `SELECT count(*)::int n FROM coordinator.action_intents
              WHERE status IN ('proposed','admitted','committed')`,
          )
        ).rows[0].n;
        expect(live, 'no rejected input may leave a live intent').toBe(0);
      });
    });

    it('G2-06d ADM-06d an investigator cannot propose (capability)', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const inv = await w.newAttempt('investigator');
        const out = await w.propose({ ...w.poolSpec('tc-1'), att: inv }).then(
          (i) => ({ i }),
          (e) => ({ e }),
        );
        if ('i' in out) {
          await w.actions.admit(out.i.id, 'd1').catch(() => null);
          const row = await w.intent(out.i.id);
          expect(row.status).toBe('blocked');
          expect(row.block_reason).toBe('capability_denied');
        } else expect(errText(out.e)).toContain('capability_denied');
        await expectNoMutation(w, base);
      });
    });

    it('G2-06e capability is per role: a database_specialist cannot propose a cache flush', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const db = await w.newAttempt('database_specialist');
        const out = await w.propose({ ...w.flushSpec('tc-f'), att: db }).then(
          (i) => ({ i }),
          (e) => ({ e }),
        );
        if ('i' in out) {
          expect(out.i.status).toBe('blocked');
          expect(out.i.blockReason).toBe('capability_denied');
        } else expect(errText(out.e)).toContain('capability_denied');
        await expectNoMutation(w, base);
      });
    });
  });

  describe('G2-07 cross-resource vector (target-only CAS is not enough)', () => {
    it('G2-07a ADM-07 registered change to a NON-target cited controlled source: blocked with the commit-stage Authorization row, target untouched', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1', 12, TIMEOUT_CITES));
        await w.advance(TIMEOUT, 90, { register: true });
        await commitSettled(w, i.id, fence(i));
        await checkOutcome(w, oracleOutcome('ADM-07'), {
          intents: { I: i.id },
          base,
        });
      });
    });

    it('G2-07b UNREGISTERED change to a NON-target cited controlled source before commit: only the commit-stage vector check can stop it', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1', 12, TIMEOUT_CITES));
        await w.advance(TIMEOUT, 90, { register: false });
        await commitSettled(w, i.id, fence(i));
        await expectStaleBlocked(w, i.id, {
          changedKey: TIMEOUT,
          path: 'commit',
        });
        await expectNoMutation(w, base, [TIMEOUT]);
        expect(await w.cfg(TIMEOUT)).toMatchObject({
          version: base[TIMEOUT].version + 1,
          value: 90,
        });
      });
    });

    it('G2-07c C10: a receipt present ONLY in the emitting snapshot’s dependency vector (not cited, not in the read set) is validated at commit (unregistered change)', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const att = await w.newAttempt('database_specialist', {
          inherit: [`member:${ROUTING}`],
        });
        const i = await w.proposeAdmit({ ...w.poolSpec('tc-1'), att });
        // the premise really is inherited-only
        expect(att.reads.has(`member:${ROUTING}`)).toBe(false);
        const readSet = (
          await w.admin.query(
            'SELECT read_set_receipt_ids FROM coordinator.task_attempts WHERE id=$1',
            [att.ctx.attemptId],
          )
        ).rows[0].read_set_receipt_ids as string[];
        expect(readSet).not.toContain(w.receiptId(`member:${ROUTING}`));
        const vec = (await w.intent(i.id)).dependency_vector as {
          sourceKey: string;
        }[];
        expect(vec.map((e) => e.sourceKey)).toEqual(
          expect.arrayContaining([
            `checkout.config/${POOL}`,
            `checkout.config/${ROUTING}`,
            'checkout.health',
          ]),
        );
        await w.advance(ROUTING, 'primary', { register: false });
        await commitSettled(w, i.id, fence(i));
        await expectStaleBlocked(w, i.id, {
          changedKey: ROUTING,
          path: 'commit',
        });
        await expectNoMutation(w, base, [ROUTING]);
        expect((await w.cfg(ROUTING)).value).toBe('primary');
      });
    });

    it('G2-07d ADM-07b: the same inherited-only premise, change REGISTERED: refused with the config unchanged', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const att = await w.newAttempt('database_specialist', {
          inherit: [`member:${ROUTING}`],
        });
        const i = await w.proposeAdmit({ ...w.poolSpec('tc-1'), att });
        await w.advance(ROUTING, 'primary', { register: true });
        const out = await commitSettled(w, i.id, fence(i));
        expectRefusedCommit(out);
        await expectStaleBlocked(w, i.id, {
          changedKey: ROUTING,
          path: 'either',
          reasons: ['stale_version'],
        });
        expect(
          (
            (await w.intent(i.id)).dependency_vector as { sourceKey: string }[]
          ).map((e) => e.sourceKey),
        ).toEqual(
          expect.arrayContaining([
            `checkout.config/${POOL}`,
            `checkout.config/${ROUTING}`,
            'checkout.health',
          ]),
        );
        await expectNoMutation(w, base, [ROUTING]);
      });
    });

    it('G2-07e a registered change to the OBSERVED required source (health) after admission is refused too', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        await w.registerObserved('health', { status: 'degraded' });
        const out = await commitSettled(w, i.id, fence(i));
        expectRefusedCommit(out);
        const row = await w.intent(i.id);
        expect(row.status).toBe('blocked');
        expect(['stale_version', 'receipt_not_supported']).toContain(
          row.block_reason,
        );
        await expectNoMutation(w, base);
      });
    });
  });

  describe('G2-08 per-resource independence', () => {
    it('G2-08a branch A’s source is mid-change (row lock held): branch B (other key) commits without waiting; A is then refused', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const a = await w.proposeAdmit(w.poolSpec('tc-a', 12));
        const b = await w.proposeAdmit(
          w.setSpec('tc-b', ORDERS, true, [`member:${ORDERS}`, 'health']),
        );
        const hold = await w.holdRowLock(POOL, 4); // A’s source being changed, uncommitted
        const t0 = Date.now();
        await withTimeout(
          w.actions.commit(b.id, fence(b)),
          5000,
          'branch B must not wait on branch A',
        );
        expect(Date.now() - t0).toBeLessThan(3000);
        await hold.commit();
        await w.registerMember(POOL);
        await commitSettled(w, a.id, fence(a));
        expect((await w.intent(b.id)).status).toBe('committed');
        expect(await w.cfg(ORDERS)).toMatchObject({
          version: base[ORDERS].version + 1,
          value: true,
          causedBy: b.id,
        });
        await expectStaleBlocked(w, a.id, { changedKey: POOL, path: 'either' });
        expect(await w.cfg(POOL)).toMatchObject({
          version: base[POOL].version + 1,
          value: 4,
        });
        expect(await w.actionRows()).toBe(1);
        expect((await w.resultReceipts(b.id)).length).toBe(1);
        expect((await w.resultReceipts(a.id)).length).toBe(0);
      });
    });

    it('G2-08b branch A’s commit is parked holding ITS locks: branch B commits within 2 s (no mission-wide epoch lock), then A commits too', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const a = await w.proposeAdmit(w.poolSpec('tc-a', 12));
        const b = await w.proposeAdmit(
          w.setSpec('tc-b', ORDERS, true, [`member:${ORDERS}`, 'health']),
        );
        const parked = w.park('after_lock_before_commit');
        const commitA = w.actions.commit(a.id, fence(a));
        await parked.reached;
        const t0 = Date.now();
        await withTimeout(
          w.actions.commit(b.id, fence(b)),
          5000,
          'branch B must not wait on branch A',
        );
        expect(Date.now() - t0).toBeLessThan(2000);
        parked.release();
        await commitA;
        for (const [i, key, value] of [
          [a, POOL, 12],
          [b, ORDERS, true],
        ] as const) {
          expect((await w.intent(i.id)).status).toBe('committed');
          expect(await w.cfg(key)).toMatchObject({
            version: base[key].version + 1,
            value,
            causedBy: i.id,
          });
          expect((await w.resultReceipts(i.id)).length).toBe(1);
        }
        expect(await w.actionRows()).toBe(2);
      });
    });
  });

  it('G2-17 ADM-17 freshness: an aged health observation blocks admission as evidence_too_old; a confirmation makes a new proposal admissible', async () => {
    await withWorld(async (w) => {
      const base = await w.snapshotConfig();
      const aged = { status: 'ok', note: 'aged' };
      const healthR1 = w.receiptId('health');
      const agedId = await w.registerObserved('health', aged, {
        observedAt: new Date(Date.now() - 121_000),
      });
      expect(agedId).not.toBe(healthR1);
      const i = await w.propose(w.poolSpec('tc-1'));
      await w.actions.admit(i.id, 'd1');
      // confirm: the same normalized value again appends a confirmation, no new revision
      const confirmedId = await w.registerObserved('health', aged);
      expect(confirmedId).toBe(agedId);
      const confirmations = (
        await w.admin.query(
          'SELECT count(*)::int n FROM ledger.receipt_confirmations WHERE receipt_id=$1',
          [agedId],
        )
      ).rows[0].n;
      expect(confirmations).toBe(1);
      const i2 = await w.propose(w.poolSpec('tc-2'));
      await w.actions.admit(i2.id, 'd1');
      await checkOutcome(w, oracleOutcome('ADM-17'), {
        intents: { I: i.id, I2: i2.id },
        base,
      });
    });
  });

  it('G2-18 ADM-18 a valid receipt from another mission is a citation out of scope (valid is not enough)', async () => {
    await withWorld(async (w) => {
      const base = await w.snapshotConfig();
      const status = (
        await w.admin.query(
          'SELECT status FROM ledger.observation_receipts WHERE id=$1',
          [w.receiptId('foreign')],
        )
      ).rows[0].status;
      expect(status, 'the foreign receipt itself is valid and current').toBe(
        'supported',
      );
      const out = await w
        .propose(w.poolSpec('tc-1', 12, ['foreign', 'health']))
        .then(
          (i) => ({ i }),
          (e) => ({ e }),
        );
      if ('i' in out) {
        await w.actions.admit(out.i.id, 'd1').catch(() => null);
        const row = await w.intent(out.i.id);
        expect(row.status).toBe('blocked');
        expect(row.block_reason).toBe('citation_out_of_scope');
      } else {
        expect(errText(out.e)).toContain('citation_out_of_scope');
        expect(await liveRowsFor(w, 'tc-1')).toHaveLength(0);
      }
      await checkOutcome(
        w,
        {
          intents: {},
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
        { intents: {}, base },
      );
    });
  });
});
