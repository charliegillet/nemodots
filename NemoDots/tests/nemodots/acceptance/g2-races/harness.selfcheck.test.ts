// Harness self-check (not an acceptance case). These tests prove that the
// verifier's own harness drives the REAL, existing ledger, coordinator,
// version authority and Redis correctly, so a later failure in the gate-2
// suites is a product finding and never a harness bug (the first revision of
// this suite read `r.id` where the ledger returns `r.receipt.id`). They need
// no actions, watcher or mission-control entry point.
import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';
import {
  POOL,
  REDIS_DB,
  type Rec,
  SETUP_CONFIG,
  TIMEOUT,
  errText,
  isSettled,
  withWorld,
  type World,
} from './harness.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONE = { need: [] as never[] };

describe('G2 harness self-check', () => {
  it('H-8 planner: every mission has exactly one succeeded planner with a published attempt and no replan yet (under replanCap); planner:false creates none', async () => {
    const plannerRows = async (w: World, m: string) =>
      (
        await w.admin.query(
          `SELECT t.status, (SELECT count(*)::int FROM coordinator.task_attempts a
                              WHERE a.task_id = t.id AND a.status = 'published') AS published
             FROM coordinator.tasks t WHERE t.mission_id = $1 AND t.role = 'planner'`,
          [m],
        )
      ).rows;
    await withWorld(async (w) => {
      expect(await plannerRows(w, w.mission)).toEqual([
        { status: 'succeeded', published: 1 },
      ]);
      const other = await w.seedMission();
      expect(await plannerRows(w, other)).toEqual([
        { status: 'succeeded', published: 1 },
      ]);
      const replans = await w.admin.query(
        "SELECT count(*)::int n FROM coordinator.recovery_events WHERE kind IN ('replan_scheduled','replan_coalesced')",
      );
      expect(replans.rows[0].n).toBe(0);
      expect((w.deps as Rec).config.replanCap).toBeGreaterThan(0);
    }, NONE);
    await withWorld(
      async (w) => {
        expect(await plannerRows(w, w.mission)).toEqual([]);
      },
      { need: [], planner: false },
    );
  });

  it('H-1 setup: version authority holds the setup values, one supported receipt per label at the live revision', async () => {
    await withWorld(async (w) => {
      for (const [k, v] of Object.entries(SETUP_CONFIG)) {
        const c = await w.cfg(k);
        expect(c.value).toEqual(v);
        const r = w.receipts.get(`member:${k}`)!;
        expect(r.id).toMatch(UUID);
        expect(r.revision).toBe(c.version);
        const row = await w.admin.query(
          'SELECT status, source_revision FROM ledger.observation_receipts WHERE id=$1',
          [r.id],
        );
        expect(row.rows[0]).toMatchObject({ status: 'supported' });
      }
      for (const label of ['health', 'redis', 'foreign'])
        expect(w.receiptId(label)).toMatch(UUID);
      // the foreign receipt is in another mission and never superseded the primary ones
      const f = await w.admin.query(
        'SELECT mission_id FROM ledger.observation_receipts WHERE id=$1',
        [w.receiptId('foreign')],
      );
      expect(f.rows[0].mission_id).not.toBe(w.mission);
    }, NONE);
  });

  it('H-2 attempts: real claim/start gives a running attempt with a fencing token; reads create read-set and evidence edges; a model call is stored with its tool call', async () => {
    await withWorld(async (w) => {
      const att = await w.newAttempt('database_specialist', {
        reads: ['member:db.pool_max', 'health'],
      });
      const row = (
        await w.admin.query(
          'SELECT status, fencing_token, read_set_receipt_ids, lease_expires_at > now() AS live FROM coordinator.task_attempts WHERE id=$1',
          [att.ctx.attemptId],
        )
      ).rows[0];
      expect(row.status).toBe('running');
      expect(row.live).toBe(true);
      expect(row.fencing_token).toBe(att.ctx.fencingToken);
      expect(row.read_set_receipt_ids.sort()).toEqual(
        [w.receiptId('member:db.pool_max'), w.receiptId('health')].sort(),
      );
      const edges = await w.admin.query(
        "SELECT from_id FROM ledger.dependency_edges WHERE to_kind='attempt' AND to_id=$1 AND kind='evidence'",
        [att.ctx.attemptId],
      );
      expect(edges.rows.map((e) => e.from_id).sort()).toEqual(
        row.read_set_receipt_ids.sort(),
      );
      const call = await w.modelCallFor(att, 'tc-selfcheck');
      expect(call).toMatch(UUID);
      expect(await w.modelCallFor(att, 'tc-selfcheck')).toBe(call);
      const stored = await w.admin.query(
        'SELECT tool_calls FROM ledger.model_call_records WHERE id=$1',
        [call],
      );
      expect(stored.rows[0].tool_calls[0].toolCallId).toBe('tc-selfcheck');
    }, NONE);
  });

  it('H-3 closure wiring: a REGISTERED change invalidates the attempt that read the old revision; an unregistered change and an unrelated read do not', async () => {
    await withWorld(async (w) => {
      const reader = await w.newAttempt('database_specialist', {
        reads: ['member:db.pool_max', 'health'],
      });
      const bystander = await w.newAttempt('investigator', {
        reads: ['member:orders.write_enabled'],
      });
      const status = async (a: { ctx: { attemptId: string } }) =>
        (
          await w.admin.query(
            'SELECT status FROM coordinator.task_attempts WHERE id=$1',
            [a.ctx.attemptId],
          )
        ).rows[0].status;
      await w.advance(POOL, 4, { register: false });
      expect(await status(reader)).toBe('running'); // nothing registered yet
      const before = (await w.cfg(POOL)).version;
      await w.registerMember(POOL);
      expect(w.receipts.get(`member:${POOL}`)!.revision).toBe(before);
      expect(await status(reader)).toBe('invalidated');
      expect(await status(bystander)).toBe('running');
      const events = await w.invalidationsFor(`checkout.config/${POOL}`);
      expect(events).toHaveLength(1);
      expect(events[0].affected.attemptIds).toContain(reader.ctx.attemptId);
    }, NONE);
  });

  it('H-4 injector and owner writes go through the version authority; holdRowLock blocks a second writer and anyBlocked sees it', async () => {
    await withWorld(async (w) => {
      const v = (await w.cfg(TIMEOUT)).version;
      await w.advance(TIMEOUT, 90);
      await w.advance(TIMEOUT, 95, { via: 'owner' });
      const h = await w.history(TIMEOUT);
      expect(h.at(-2)).toMatchObject({ caused_by_actor: 'injector' });
      expect(h.at(-1)).toMatchObject({ caused_by_actor: 'owner' });
      expect((await w.cfg(TIMEOUT)).version).toBe(v + 2);
      const hold = await w.holdRowLock(TIMEOUT, 100);
      const second = w.advance(TIMEOUT, 101, { via: 'owner' }).then(
        () => 'ok',
        (e) => errText(e),
      );
      expect(await isSettled(second, 300)).toBe(false);
      expect(await w.anyBlocked()).toBe(true);
      await hold.commit();
      expect(await second).toContain('stale_version');
      expect(await w.anyBlocked()).toBe(false);
    }, NONE);
  });

  it('H-5 redis fault proxy: drop_reply loses the reply AFTER a real effect, fail_before never reaches Redis, MONITOR counts script-issued UNLINKs', async () => {
    await withWorld(async (w) => {
      const rc = createClient({ url: w.fault.url(REDIS_DB) });
      rc.on('error', () => {});
      await rc.connect();
      const key = `${w.names.prefix}:selfcheck:a`;
      const keyB = `${w.names.prefix}:selfcheck:b`;
      const key2 = `${w.names.prefix}:selfcheck:v`;
      const script = `redis.call('SET', KEYS[1], 'x'); return redis.call('UNLINK', KEYS[2])`;
      await w.redis.set(key2, 'v');
      w.fault.mode = 'drop_reply';
      const lost = await rc.eval(script, { keys: [key, key2] }).then(
        () => 'reply',
        (e) => `lost:${(e as Error).message}`,
      );
      w.fault.mode = 'ok';
      expect(lost).toMatch(/^lost:/);
      expect(await w.redis.get(key)).toBe('x'); // the effect happened
      expect(await w.redis.exists(key2)).toBe(0);
      await w.redis.set(key2, 'v');
      w.fault.mode = 'fail_before';
      const refused = await rc.eval(script, { keys: [keyB, key2] }).then(
        () => 'reply',
        (e) => `failed:${(e as Error).message}`,
      );
      w.fault.mode = 'ok';
      expect(refused).toMatch(/^failed:/);
      expect(await w.redis.get(keyB)).toBeNull(); // nothing happened
      expect(await w.redis.exists(key2)).toBe(1);
      await rc.eval(script, { keys: [keyB, key2] }); // reconnected, passthrough
      await new Promise((r) => setTimeout(r, 150));
      expect(w.watch.mentions([key2])).toBe(2); // one lost-reply effect, one normal
      expect(w.watch.mentions([key])).toBe(0); // SET is not an unlink
      rc.destroy();
    }, NONE);
  });

  it('H-6 leases: expiry plus the real reaper requeues the task; the next claim gets a strictly higher token', async () => {
    await withWorld(async (w) => {
      const a1 = await w.newAttempt('investigator');
      await w.expireLease(a1.ctx.attemptId);
      const reaped = await w.reap();
      expect(reaped).toHaveLength(1);
      const a2 = await w.claim('investigator');
      expect(a2).not.toBeNull();
      expect(a2!.ctx.taskId).toBe(a1.ctx.taskId);
      expect(a2!.ctx.fencingToken).toBeGreaterThan(a1.ctx.fencingToken);
    }, NONE);
  });

  it('H-7 propose plumbing: one attempt per tool call reading exactly what it cites, role by action kind, a recorded model call carrying the tool call, strict extras, no read of the foreign receipt', async () => {
    await withWorld(async (w) => {
      const seen: { input: Rec; ctx: Rec }[] = [];
      const stub = {
        propose: async (input: Rec, ctx: Rec) => {
          seen.push({ input, ctx });
          return { id: 'stub' };
        },
      } as never;
      await w.proposeVia(stub, w.poolSpec('tc-a'));
      await w.proposeVia(stub, w.poolSpec('tc-a')); // a replay reuses the attempt and the call
      await w.proposeVia(stub, w.poolSpec('tc-b', 12, ['foreign', 'health']));
      await w.proposeVia(stub, {
        ...w.flushSpec('tc-f'),
        extra: { policyVersion: 'x' },
      });
      expect(seen).toHaveLength(4);
      expect(seen[1].ctx.attemptId).toBe(seen[0].ctx.attemptId);
      expect(seen[1].ctx.modelCallId).toBe(seen[0].ctx.modelCallId);
      expect(seen[2].ctx.attemptId).not.toBe(seen[0].ctx.attemptId);
      expect(seen[0].ctx).toMatchObject({
        toolCallId: 'tc-a',
        role: 'database_specialist',
      });
      expect(seen[3].ctx.role).toBe('cache_specialist'); // propose_cache_flush is granted to that role only
      expect(seen[0].input.supportingReceiptIds).toEqual([
        w.receiptId('member:db.pool_max'),
        w.receiptId('health'),
      ]);
      expect(seen[0].input.payload).toMatchObject({ key: POOL, value: 12 });
      expect(seen[0].input.payload.expectedCurrentValueDigest).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(seen[3].input.policyVersion).toBe('x');
      const readSet = async (attemptId: string) =>
        (
          await w.admin.query(
            'SELECT read_set_receipt_ids FROM coordinator.task_attempts WHERE id=$1',
            [attemptId],
          )
        ).rows[0].read_set_receipt_ids as string[];
      expect((await readSet(seen[0].ctx.attemptId)).sort()).toEqual(
        [w.receiptId('member:db.pool_max'), w.receiptId('health')].sort(),
      );
      expect(await readSet(seen[2].ctx.attemptId)).toEqual([
        w.receiptId('health'),
      ]);
      const call = await w.admin.query(
        'SELECT attempt_id, tool_calls FROM ledger.model_call_records WHERE id=$1',
        [seen[0].ctx.modelCallId],
      );
      expect(call.rows[0].attempt_id).toBe(seen[0].ctx.attemptId);
      expect(call.rows[0].tool_calls[0].toolCallId).toBe('tc-a');
    }, NONE);
  });
});
