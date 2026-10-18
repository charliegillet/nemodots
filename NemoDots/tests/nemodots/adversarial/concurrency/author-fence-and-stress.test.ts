// Author fences at the proposal boundary, idempotent self-write settlement, and
// a mixed stress of every writer of the authority and the ledger at once.
// Expected (ARCHITECTURE 6): an expired or taken-over author cannot publish a
// proposal; a proposal published by a still-valid author stays valid for
// dispatch after the author's lease ends; the settlement of a committed
// set_config is idempotent per action; and the lock orders of commit, closure,
// publication and injector do not form a cycle (no 40P01 observed before the
// transaction retry).
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  admitAndCommit,
  configState,
  countRows,
  createAttempt,
  externalChange,
  intentStatus,
  memberReceipt,
  observed,
  proposeCtx,
  proposePool,
  resultOutcomes,
  scenario,
  setConfigInput,
  sleep,
  waitForLockWaiters,
  withWorld,
  type ConfigScalar,
} from './harness.js';

describe('author fence at propose', () => {
  it('a takeover (fence bumped) that commits while a proposal waits for the attempt row: the proposal is refused, nothing written', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const state = await configState(world, 'db.pool_max');
      const client = await world.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT 1 FROM coordinator.task_attempts WHERE id = $1 FOR UPDATE',
          [s.attempt.attemptId],
        );
        const proposal = world.service
          .propose(
            setConfigInput(20, state.value as ConfigScalar),
            proposeCtx(s),
          )
          .then(
            (v) => v,
            (e: unknown) => e as Error,
          );
        await waitForLockWaiters(world, 1);
        // The reaper takes over: attempt expired, task fence bumped.
        await client.query(
          "UPDATE coordinator.task_attempts SET status = 'expired' WHERE id = $1",
          [s.attempt.attemptId],
        );
        await client.query(
          'UPDATE coordinator.tasks SET fence_seq = fence_seq + 1 WHERE id = $1',
          [s.attempt.taskId],
        );
        await client.query('COMMIT');
        const outcome = await proposal;
        expect((outcome as Error).name).toBe('FenceError');
      } finally {
        client.release();
      }
      expect(await countRows(world, 'coordinator.action_intents')).toBe(0);
    });
  });

  it('an expired author lease cannot publish a proposal', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      await world.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [s.attempt.attemptId],
      );
      const state = await configState(world, 'db.pool_max');
      await expect(
        world.service.propose(
          setConfigInput(20, state.value as ConfigScalar),
          proposeCtx(s),
        ),
      ).rejects.toMatchObject({ name: 'FenceError' });
      expect(await countRows(world, 'coordinator.action_intents')).toBe(0);
    });
  });

  it('a proposal published while the author was valid remains admissible after the author lease ends', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await world.admin.query(
        "UPDATE coordinator.task_attempts SET status = 'published', lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [s.attempt.attemptId],
      );
      const { committed } = await admitAndCommit(world, intent.id);
      expect(committed.status).toBe('committed');
    });
  });
});

describe('settlement idempotency', () => {
  it('six concurrent settleFromHistory(verified) calls: one transition, one verified receipt', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await admitAndCommit(world, intent.id);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          world.service.settleFromHistory(intent.id, 'verified'),
        ),
      );
      for (const r of results) expect(r.status).toBe('fulfilled');
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
      expect(
        (await resultOutcomes(world, intent.id)).filter(
          (o) => o === 'verified',
        ),
      ).toHaveLength(1);
      // A late contradictory verdict does not rewrite a settled intent.
      await world.service
        .settleFromHistory(intent.id, 'failed')
        .catch(() => undefined);
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
    });
  });
});

describe('mixed stress: commits, closures, publications, injector writes', () => {
  it('no deadlock is raised (before any retry) and every invariant holds', async () => {
    await withWorld(async (world) => {
      const keys: [string, ConfigScalar][] = [
        ['cache.schema_version', 3],
        ['db.pool_max', 12],
        ['db.statement_timeout_ms', 7000],
        ['routing.inventory_source', 'replica_stale'],
        ['orders.write_enabled', false],
      ];
      const intents = [];
      for (const [key, value] of keys) {
        const s = await scenario(world, { key });
        const state = await configState(world, key);
        intents.push(
          await world.service.propose(
            setConfigInput(value, state.value as ConfigScalar, { key }),
            proposeCtx(s),
          ),
        );
      }
      const coordinator = world.coordinator();
      const publishers = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const attempt = await createAttempt(world);
          const member = await memberReceipt(world, 'ui.banner_text');
          return { attempt, member };
        }),
      );
      const work: Promise<unknown>[] = [];
      intents.forEach((intent, i) =>
        work.push(
          (async () => {
            await sleep(i * 4);
            return admitAndCommit(world, intent.id, `d${i}`);
          })(),
        ),
      );
      for (let r = 0; r < 6; r += 1) {
        work.push(observed(world, 'checkout.health', { status: `s${r}` }));
        work.push(externalChange(world, 'ui.banner_text', `b${r}`));
      }
      publishers.forEach(({ attempt, member }, i) =>
        work.push(
          (async () => {
            await sleep(i * 6);
            return coordinator
              .publishOutput(attempt.context, {
                kind: 'finding',
                content: { i },
                dependencyVector: [
                  {
                    sourceKey: member.source.key,
                    sourceRevision: member.sourceRevision,
                    receiptId: member.id,
                  },
                ],
              } as never)
              .catch((error: Error) => error.name); // SupportError is a legitimate outcome
          })(),
        ),
      );
      const settled = await Promise.allSettled(work);
      expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
      expect(world.deadlocks()).toEqual([]);
      for (const intent of intents) {
        const rows = await actionHistory(world, intent.id);
        const status = (await intentStatus(world, intent.id)).status;
        expect(['committed', 'blocked']).toContain(status);
        expect(rows).toHaveLength(status === 'committed' ? 1 : 0);
      }
    });
  });
});
