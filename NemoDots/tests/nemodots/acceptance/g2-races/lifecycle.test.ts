// TEST_PROMPT gate 2 cases 13, 14, 16 and the documented limits of the guarantee.
import { describe, expect, it } from 'vitest';
import { SETUP_CONFIG } from '../oracle/admission.js';
import {
  POOL,
  authSummary,
  errText,
  isSettled,
  withWorld,
  type Rec,
} from './harness.js';

const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;

describe('G2 compensation, cancellation, self-writes: cases 13, 14, 16', () => {
  it('G2-13a compensation of a set_config restores the prior value only while the version has not moved, through a new authorized intent', async () => {
    await withWorld(async (w) => {
      const before = await w.cfg(POOL);
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      await w.actions.commit(i.id, fence(i));
      await w.watcherPoll(); // history walk settles it verified
      expect((await w.intent(i.id)).status).toBe('verified');
      const comp = await w.actions.compensate(i.id, w.attempt);
      expect(comp.id).not.toBe(i.id);
      const c = await w.actions.admit(comp.id, 'd1');
      await w.actions.commit(comp.id, fence(c));
      expect(await w.cfg(POOL)).toMatchObject({
        value: before.value,
        version: before.version + 2,
        causedBy: comp.id,
      });
      expect((await authSummary(w, comp.id)).map((a) => a.decision)).toEqual([
        'admitted',
        'committed',
      ]);
    });
  });

  it('G2-13b a later valid change survives: compensation is refused and the later value is untouched', async () => {
    await withWorld(async (w) => {
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      await w.actions.commit(i.id, fence(i));
      await w.watcherPoll();
      await w.advance(POOL, 6, { actor: 'owner', register: true }); // later valid change
      const out = await w.actions.compensate(i.id, w.attempt).then(
        async (c) => {
          const a = await w.actions.admit(c.id, 'd1').catch(() => null);
          if (a) await w.actions.commit(c.id, fence(a)).catch(() => {});
          return (await w.intent(c.id)).status as string;
        },
        (e) => `refused:${errText(e)}`,
      );
      expect(out === 'blocked' || out.startsWith('refused:')).toBe(true);
      const c = await w.cfg(POOL);
      expect(c.value).toBe(6);
      expect(c.causedBy).toBeNull();
    });
  });

  it('G2-13c an irreversible Redis flush is never shown as undone', async () => {
    await withWorld(async (w) => {
      const keys = await w.plantCache(3);
      const f = await w.proposeAdmit(w.flushSpec('tc-f'));
      await w.actions.commit(f.id, fence(f));
      await w.actions.dispatch(f.id, fence(f));
      expect(await w.cacheKeysLeft(keys)).toBe(0);
      const out = await w.actions.compensate(f.id, w.attempt).then(
        async (c) => (await w.intent(c.id)).status as string,
        (e) => `refused:${errText(e)}`,
      );
      expect(
        ['blocked', 'failed', 'cancelled'].includes(out) ||
          out.startsWith('refused:'),
      ).toBe(true);
      expect(await w.cacheKeysLeft(keys)).toBe(0); // nothing resurrected
      expect((await w.intent(f.id)).status).not.toBe('cancelled');
    });
  });

  it('G2-14 cancellation: queued work stops, committed effects stay in history, an in-flight dispatch reports its real status', async () => {
    await withWorld(async (w) => {
      const keys = await w.plantCache(3);
      const queued = await w.propose(w.poolSpec('tc-q', 12));
      const admitted = await w.proposeAdmit({
        action: 'set_config',
        payload: { key: 'db.statement_timeout_ms', value: 120 },
        cites: ['member:db.statement_timeout_ms', 'health'],
        toolCallId: 'tc-a',
      });
      const committed = await w.proposeAdmit({
        action: 'set_config',
        payload: { key: 'orders.write_enabled', value: true },
        cites: ['member:orders.write_enabled', 'health'],
        toolCallId: 'tc-c',
      });
      await w.actions.commit(committed.id, fence(committed));
      const flush = await w.proposeAdmit(w.flushSpec('tc-f'));
      await w.actions.commit(flush.id, fence(flush));
      const parked = w.park('after_effect_before_record');
      const dispatch = w.actions
        .dispatch(flush.id, fence(flush))
        .catch((e) => e);
      await parked.reached; // Redis effect applied, result not yet recorded
      expect(await w.cacheKeysLeft(keys)).toBe(0);
      const cancel = w.cancelMission();
      await isSettled(cancel, 300);
      parked.release();
      await dispatch;
      await cancel;

      for (const q of [queued, admitted]) {
        const row = await w.intent(q.id);
        expect(row.status, `${q.id} queued work must stop`).toBe('cancelled');
        const tryCommit = await w.actions
          .commit(q.id, q.dispatch?.fence ?? 0)
          .then(
            () => 'returned',
            (e) => errText(e),
          );
        expect((await w.intent(q.id)).status).not.toBe('committed');
        void tryCommit;
      }
      expect((await w.cfg('db.statement_timeout_ms')).value).toBe(
        SETUP_CONFIG['db.statement_timeout_ms'],
      );
      // committed effect remains and is listed
      expect(await w.cfg('orders.write_enabled')).toMatchObject({
        value: true,
        causedBy: committed.id,
      });
      expect(['committed', 'dispatched', 'verified']).toContain(
        (await w.intent(committed.id)).status,
      );
      // in-flight external request: never relabelled cancelled; effect truthfully recorded
      const fl = (await w.intent(flush.id)).status as string;
      expect(['dispatched', 'verified', 'outcome_unknown']).toContain(fl);
      const m = (
        await w.admin.query(
          'SELECT cancellation FROM coordinator.missions WHERE id=$1',
          [w.mission],
        )
      ).rows[0];
      const listed = JSON.stringify(m.cancellation?.committedEffects ?? []);
      expect(listed).toContain(committed.id);
      expect(listed).toContain(flush.id);
      expect(listed).not.toContain(queued.id);
    });
  });

  describe('G2-16 self-write', () => {
    it('G2-16a a successful self-write r1->r2 with a trusted causedByActionId routes to verification: no replay or repair storm', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const inv0 = await w.invalidationCount();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        await w.actions.commit(i.id, fence(i));
        for (let n = 0; n < 3; n++) await w.watcherPoll(); // repeated polling must not storm
        expect((await w.intent(i.id)).status).toBe('verified');
        const rec = await w.admin.query(
          `SELECT r.* FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id=r.source_id
           WHERE s.key=$1 AND s.environment='test' AND r.status='supported' ORDER BY r.source_revision DESC LIMIT 1`,
          [`checkout.config/${POOL}`],
        );
        expect(Number(rec.rows[0].source_revision)).toBe(v1 + 1);
        expect(rec.rows[0].provenance.selfWrite).toBe('verified');
        expect(rec.rows[0].provenance.causedByActionId).toBe(i.id);
        expect(await w.invalidationCount()).toBe(inv0); // acting lineage not invalidated, no storm
        const states = (
          await w.admin.query(
            'SELECT status FROM coordinator.task_attempts WHERE id=$1',
            [w.attempt.attemptId],
          )
        ).rows;
        expect(states.every((r: Rec) => r.status !== 'invalidated')).toBe(true);
      });
    });

    it('G2-16b a mismatched interleaving still invalidates: an injector write after the commit makes the head selfWrite none', async () => {
      await withWorld(async (w) => {
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        await w.actions.commit(i.id, fence(i));
        const inv0 = await w.invalidationCount();
        await w.advance(POOL, 4); // injector writes r3 before the watcher looks
        await w.watcherPoll();
        expect(await w.invalidationCount()).toBeGreaterThan(inv0);
        const head = (await w.history(POOL)).at(-1) as Rec;
        expect(head.caused_by_action_id ?? null).toBeNull();
        const rec = await w.admin.query(
          `SELECT r.* FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id=r.source_id
           WHERE s.key=$1 AND r.status='supported' ORDER BY r.source_revision DESC LIMIT 1`,
          [`checkout.config/${POOL}`],
        );
        expect(rec.rows[0].provenance.selfWrite).toBe('none');
        expect((await w.intent(i.id)).status).toBe('verified'); // its own history row still verified
      });
    });

    it('G2-16c the model cannot forge the marker: strict payload, injector role and raw updates all leave caused_by_action_id null', async () => {
      await withWorld(async (w) => {
        const forged = await w
          .propose({
            ...w.poolSpec('tc-forge'),
            payload: { key: POOL, value: 12, causedByActionId: 'act_forged' },
          })
          .then(
            () => 'returned',
            (e) => errText(e),
          );
        const rows = (
          await w.admin.query(
            "SELECT status, block_reason FROM coordinator.action_intents WHERE tool_call_id='tc-forge'",
          )
        ).rows;
        expect(
          forged !== 'returned' ||
            (rows[0]?.status === 'blocked' &&
              rows[0]?.block_reason === 'payload_invalid'),
        ).toBe(true);
        const v = (await w.cfg(POOL)).version;
        await w.advance(POOL, 5); // injector through the version authority
        const viaSql = await w.admin
          .query(
            "UPDATE checkout.config_entries SET caused_by_action_id='act_forged' WHERE key=$1 RETURNING caused_by_action_id",
            [POOL],
          )
          .then(
            (r) => r.rows[0]?.caused_by_action_id ?? null,
            () => null,
          );
        expect(viaSql).toBeNull(); // admin is not the app role: the trigger nulls it (or the grant refuses)
        const c = await w.cfg(POOL);
        expect(c.version).toBeGreaterThan(v);
        expect(c.causedBy).toBeNull();
        expect(await w.actionRows()).toBe(0);
      });
    });
  });

  it('G2-OUT outside the guarantee (documented): unobserved changes and uninstrumented remote effects are not checked by admission', async () => {
    await withWorld(async (w) => {
      // A Redis key written by someone else, never observed or registered anywhere.
      const keys = await w.plantCache(2);
      const stranger = await w.plantCache(1, 'acc-ns-a');
      const i = await w.proposeAdmit(w.flushSpec('tc-f'));
      await w.redis.set(`${w.names.prefix}:unobserved:late`, 'x'); // unobserved remote change after admission
      await w.actions.commit(i.id, fence(i));
      await w.actions.dispatch(i.id, fence(i));
      // The flush still applied: the unobserved write is outside the vector, so nothing blocked it,
      // and keys written by a stranger inside the namespace were deleted too.
      expect((await w.intent(i.id)).status).toMatch(/dispatched|verified/);
      expect(await w.cacheKeysLeft([...keys, ...stranger])).toBe(0);
      const vector = (await w.auths(i.id)).flatMap((a: Rec) =>
        (a.checked_vector as { sourceKey: string }[]).map((e) => e.sourceKey),
      );
      expect(vector.some((k) => /unobserved|late/.test(k))).toBe(false);
      // An observed health change that nobody registered is likewise invisible to G1; only the
      // freshness window (maxAgeMs) bounds it, which is the documented residual.
      const j = await w.proposeAdmit(w.poolSpec('tc-2'));
      await w.actions.commit(j.id, fence(j));
      expect((await w.intent(j.id)).status).toBe('committed');
    });
  });
});
