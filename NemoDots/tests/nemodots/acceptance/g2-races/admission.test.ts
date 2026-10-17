// TEST_PROMPT gate 2 cases 1-8 (admission, ordering, binding, vectors).
// Each test checks authoritative version, actual domain value and the audit
// receipt (coordinator.authorizations) together.
import { describe, expect, it } from 'vitest';
import { SETUP_CONFIG } from '../oracle/admission.js';
import {
  POOL,
  TIMEOUT,
  authSummary,
  errText,
  isSettled,
  withTimeout,
  withWorld,
  type World,
} from './harness.js';

const SETUP_POOL = SETUP_CONFIG['db.pool_max'];
const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;
const blocked = (reason: string) => ({
  stage: expect.any(String),
  decision: 'blocked',
  blockReason: reason,
});

async function expectUntouched(
  w: World,
  key: string,
  v: number,
  value: unknown,
) {
  const c = await w.cfg(key);
  expect(c.version).toBe(v);
  expect(c.value).toEqual(value);
  expect(await w.actionRows()).toBe(0);
}

describe('G2 admission and races: cases 1-8', () => {
  it('G2-01 stale before admission: propose from r1, register r2, admit r1 fails with no mutation', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.propose(w.poolSpec('tc-1'));
      await w.advance(POOL, 4, { register: true });
      await w.actions.admit(i.id, 'd1');
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_version');
      expect(await authSummary(w, i.id)).toEqual([
        {
          stage: 'admission',
          decision: 'blocked',
          blockReason: 'stale_version',
        },
      ]);
      expect((await w.resultReceipts(i.id)).length).toBe(0);
      await expectUntouched(w, POOL, v1 + 1, 4);
    });
  });

  it('G2-01b stale before admission with the replacement not yet observed is also blocked (case 13 of gate 1)', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.propose(w.poolSpec('tc-1'));
      await w.advance(POOL, 4, { register: false });
      await w.actions.admit(i.id, 'd1');
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_pending_observation');
      await expectUntouched(w, POOL, v1 + 1, 4);
    });
  });

  it('G2-02 stale between local check and commit: pause after preliminary read, register r2, resume rejects r1', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      const parked = w.park('after_preliminary_read');
      const commit = w.actions.commit(i.id, fence(i));
      await parked.reached;
      await w.advance(POOL, 4, { register: true });
      parked.release();
      await commit;
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_version');
      expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
        'admitted',
        'blocked',
      ]);
      expect((await authSummary(w, i.id))[1]).toMatchObject(
        blocked('stale_version'),
      );
      expect((await w.resultReceipts(i.id)).length).toBe(0);
      await expectUntouched(w, POOL, v1 + 1, 4);
      expect((await w.history(POOL)).at(-1)?.caused_by_actor).toBe('injector');
    });
  });

  it('G2-03a concurrent commit ordering: the commit takes the row lock first, the racing injector write serializes after and fails', async () => {
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
      expect(await isSettled(injector)).toBe(false); // blocked on the action's row lock
      parked.release();
      await commit;
      const injResult = await injector;
      expect(injResult).toContain('stale_version');
      const row = await w.intent(i.id);
      expect(row.status).toBe('committed');
      const c = await w.cfg(POOL);
      expect(c).toMatchObject({ version: v1 + 1, value: 12, causedBy: i.id });
      const h = await w.history(POOL);
      expect(
        h
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

  it('G2-03b concurrent commit ordering: the injector holds the lock first, the commit waits then rejects r1', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      const hold = await w.holdRowLock(POOL, 4);
      const commit = w.actions.commit(i.id, fence(i));
      expect(await isSettled(commit)).toBe(false); // waits on the injector's lock
      await hold.commit();
      await commit;
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_version');
      await expectUntouched(w, POOL, v1 + 1, 4);
      expect((await w.resultReceipts(i.id)).length).toBe(0);
      expect(
        (await w.history(POOL))
          .filter((r) => Number(r.version) > v1)
          .map((r) => r.caused_by_actor),
      ).toEqual(['injector']);
    });
  });

  it('G2-04 approval race: approve r1 payload, register r2, the approval callback revalidates and rejects', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1')); // admission == approval of the r1 payload
      await w.advance(POOL, 4, { register: true });
      await w.actions.commit(i.id, fence(i)); // the callback
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_version');
      expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
        'admitted',
        'blocked',
      ]);
      await expectUntouched(w, POOL, v1 + 1, 4);
    });
  });

  describe('G2-05 payload binding', () => {
    it('G2-05a reused idempotency key (same tool call) with a different payload is rejected, same payload returns the stored intent', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const a = await w.propose(w.poolSpec('tc-1', 12));
        const again = await w.propose(w.poolSpec('tc-1', 12));
        expect(again.id).toBe(a.id);
        const tampered = await w.propose(w.poolSpec('tc-1', 13)).then(
          (x) => x,
          (e) => e,
        );
        const rows = (
          await w.admin.query(
            'SELECT id, status, block_reason FROM coordinator.action_intents WHERE tool_call_id=$1',
            ['tc-1'],
          )
        ).rows;
        const conflict = rows.find((r) => r.id !== a.id);
        if (conflict) {
          expect(conflict.status).toBe('blocked');
          expect(conflict.block_reason).toBe('idempotency_conflict');
        } else expect(errText(tampered)).toContain('idempotency_conflict');
        expect((await w.intent(a.id)).status).toBe('proposed');
        await w.actions.admit(a.id, 'd1').catch(() => {});
        await expectUntouched(w, POOL, v1, SETUP_POOL);
      });
    });

    it('G2-05b a new tool call may re-propose an identical payload after a block', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const i1 = await w.propose(w.poolSpec('tc-1'));
        await w.advance(POOL, 4, { register: true });
        await w.actions.admit(i1.id, 'd1');
        expect((await w.intent(i1.id)).status).toBe('blocked');
        // the new tool call re-reads r2 (new payload digest binds the new current value)
        const i2 = await w.proposeAdmit(w.poolSpec('tc-2', 12));
        await w.actions.commit(i2.id, fence(i2));
        expect((await w.intent(i2.id)).status).toBe('committed');
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1 + 2,
          value: 12,
          causedBy: i2.id,
        });
        expect(await w.actionRows()).toBe(1);
        expect((await w.resultReceipts(i2.id)).length).toBe(1);
      });
    });

    it('G2-05c payload, dependency vector, policy or target changed after admission cannot commit without fresh authorization', async () => {
      await withWorld(async (w) => {
        const t1 = (await w.cfg(TIMEOUT)).version;
        const cases = [
          {
            name: 'payload_value',
            sql: `UPDATE coordinator.action_intents SET payload = jsonb_set(payload,'{value}','13') WHERE id=$1`,
          },
          {
            name: 'vector',
            sql: `UPDATE coordinator.action_intents SET dependency_vector='[]'::jsonb WHERE id=$1`,
          },
          {
            name: 'policy',
            sql: `UPDATE coordinator.action_intents SET policy_version='policy-v0' WHERE id=$1`,
          },
          {
            name: 'target',
            sql: `UPDATE coordinator.action_intents SET target = jsonb_set(target,'{sourceKey}','"checkout.config/${TIMEOUT}"') WHERE id=$1`,
          },
        ];
        let n = 0;
        for (const c of cases) {
          n += 1;
          const i = await w.proposeAdmit(w.poolSpec(`tc-bind-${n}`));
          // tampering through the admin role: either the row is immutable (the
          // statement throws) or the commit must refuse the changed intent.
          const tamper = await w.admin.query(c.sql, [i.id]).then(
            () => 'changed',
            (e) => `immutable:${errText(e)}`,
          );
          if (tamper === 'changed') {
            const result = await w.actions.commit(i.id, fence(i)).then(
              () => 'returned',
              (e) => `threw:${errText(e)}`,
            );
            const row = await w.intent(i.id);
            expect(
              row.status,
              `${c.name}: tampered intent must not commit (${result})`,
            ).not.toBe('committed');
            expect(['admitted', 'blocked']).toContain(row.status);
          } else {
            // sealed row: the statement itself was refused, nothing to commit under a different binding
            expect(tamper).toMatch(/immutable/);
            expect((await w.intent(i.id)).status).toBe('admitted');
          }
        }
        const c = await w.cfg(TIMEOUT);
        expect(c.version).toBe(t1);
        const p = await w.cfg(POOL);
        expect(p.value).not.toBe(13);
      });
    });
  });

  describe('G2-06 missing predicates', () => {
    for (const [name, cites] of [
      ['required health omitted', ['member:db.pool_max']],
      ['only an irrelevant valid receipt cited', ['redis']],
    ] as const) {
      it(`G2-06 ${name}: rejected, or the server adds the mandatory support and records it in the vector`, async () => {
        await withWorld(async (w) => {
          const v1 = (await w.cfg(POOL)).version;
          const i = await w.propose(w.poolSpec('tc-1', 12, [...cites]));
          await w.actions.admit(i.id, 'd1').catch(() => {});
          const row = await w.intent(i.id);
          if (row.status === 'blocked')
            expect(row.block_reason).toBe('missing_required_source');
          else {
            expect(row.status).toBe('admitted');
            const keys = (row.dependency_vector as { sourceKey: string }[]).map(
              (e) => e.sourceKey,
            );
            expect(keys).toEqual(
              expect.arrayContaining([
                `checkout.config/${POOL}`,
                'checkout.health',
              ]),
            );
          }
          await expectUntouched(w, POOL, v1, SETUP_POOL);
        });
      });
    }

    it('G2-06c easier policy: out-of-domain value, unknown action kind and a forged extra field never reach the config', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const attempts: [string, () => Promise<unknown>][] = [
          ['domain', () => w.propose(w.poolSpec('tc-d', 50))],
          [
            'kind',
            () =>
              w.propose({
                action: 'drop_table' as never,
                payload: { table: 'checkout.orders' },
                cites: ['member:db.pool_max', 'health'],
                toolCallId: 'tc-k',
              }),
          ],
          [
            'extra',
            () =>
              w.propose({
                ...w.poolSpec('tc-e'),
                payload: { key: POOL, value: 12, causedByActionId: 'forged' },
              }),
          ],
        ];
        for (const [name, run] of attempts) {
          const out = await run().then(
            () => 'returned',
            (e) => errText(e),
          );
          const rows = (
            await w.admin.query(
              'SELECT status, block_reason FROM coordinator.action_intents WHERE tool_call_id = ANY($1)',
              [['tc-d', 'tc-k', 'tc-e']],
            )
          ).rows;
          const bad = rows.filter(
            (r) =>
              r.status !== 'blocked' || r.block_reason !== 'payload_invalid',
          );
          expect(bad, `${name}: ${out}`).toEqual([]);
          if (out !== 'returned') expect(out).toContain('payload_invalid');
        }
        await expectUntouched(w, POOL, v1, SETUP_POOL);
      });
    });

    it('G2-06d an investigator cannot propose (capability)', async () => {
      await withWorld(async (w) => {
        const inv = await w.seedAttempt('investigator');
        const out = await w
          .propose({ ...w.poolSpec('tc-1'), attempt: inv })
          .then(
            async (i) => {
              await w.actions.admit(i.id, 'd1').catch(() => {});
              return await w.intent(i.id);
            },
            (e) => ({ thrown: errText(e) }),
          );
        if ('thrown' in out) expect(out.thrown).toMatch(/capability_denied/);
        else {
          expect(out.status).toBe('blocked');
          expect(out.block_reason).toBe('capability_denied');
        }
        expect(await w.actionRows()).toBe(0);
      });
    });
  });

  it('G2-07 cross-resource vector: superseding a non-target required source blocks the commit (target-only CAS is not enough)', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      // target pool_max is untouched; only the health receipt (another required source) changes
      await w.registerObserved('health', { status: 'degraded' });
      await w.actions.commit(i.id, fence(i));
      const row = await w.intent(i.id);
      expect(row.status).toBe('blocked');
      expect(['stale_version', 'receipt_not_supported']).toContain(
        row.block_reason,
      );
      await expectUntouched(w, POOL, v1, SETUP_POOL);
      // inherited-only premise: a member of another key in the emitting snapshot
      const j = await w.proposeAdmit(
        w.poolSpec('tc-2', 12, [
          'member:db.pool_max',
          'health',
          'member:db.statement_timeout_ms',
        ]),
      );
      expect(
        (await w.intent(j.id)).dependency_vector.map(
          (e: { sourceKey: string }) => e.sourceKey,
        ),
      ).toContain(`checkout.config/${TIMEOUT}`);
      await w.advance(TIMEOUT, 120, { register: true });
      await w.actions.commit(j.id, fence(j));
      const jr = await w.intent(j.id);
      expect(jr.status).toBe('blocked');
      expect(jr.block_reason).toBe('stale_version');
      await expectUntouched(w, POOL, v1, SETUP_POOL);
    });
  });

  it('G2-08 per-resource independence: a change to branch A does not block or fail branch B', async () => {
    await withWorld(async (w) => {
      const vA = (await w.cfg(POOL)).version;
      const vB = (await w.cfg(TIMEOUT)).version;
      const a = await w.proposeAdmit(w.poolSpec('tc-a', 12));
      const b = await w.proposeAdmit({
        action: 'set_config',
        payload: { key: TIMEOUT, value: 120 },
        cites: ['member:db.statement_timeout_ms', 'health'],
        toolCallId: 'tc-b',
      });
      const hold = await w.holdRowLock(POOL, 4); // branch A's source is being changed, uncommitted
      const t0 = Date.now();
      await withTimeout(
        w.actions.commit(b.id, fence(b)),
        5000,
        'branch B must not wait on branch A',
      );
      expect(Date.now() - t0).toBeLessThan(3000);
      await hold.commit();
      await w.registerMember(POOL);
      await w.actions.commit(a.id, fence(a));
      expect((await w.intent(b.id)).status).toBe('committed');
      expect((await w.intent(a.id)).status).toBe('blocked');
      expect(await w.cfg(TIMEOUT)).toMatchObject({
        version: vB + 1,
        value: 120,
        causedBy: b.id,
      });
      expect(await w.cfg(POOL)).toMatchObject({ version: vA + 1, value: 4 });
      expect(await w.actionRows()).toBe(1);
      expect((await w.resultReceipts(b.id)).length).toBe(1);
      expect((await w.resultReceipts(a.id)).length).toBe(0);
    });
  });
});
