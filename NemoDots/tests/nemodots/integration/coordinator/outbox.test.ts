// Outbox: at-least-once delivery, idempotent handlers, LISTEN + poll, and the
// admission scheduling rule of finding D6.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createCoordinatorHandlers,
  createOutbox,
  enqueueOutbox,
  type OutboxHelpers,
  OUTBOX_TOPICS,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { latch } from '../../helpers/barrier.js';
import {
  count,
  createRunningMission,
  sleep,
  until,
  withHarness,
} from './harness.js';

async function messageRow(admin: import('pg').Pool, id: number) {
  const { rows } = await admin.query(
    `SELECT * FROM coordinator.outbox WHERE id = $1`,
    [id],
  );
  return rows[0];
}

it('duplicate delivery of one message applies its database effect exactly once', async () => {
  await withHarness(async (h) => {
    await h.admin.query(
      `CREATE TABLE public.coord_effects (n integer NOT NULL);
       INSERT INTO public.coord_effects VALUES (0);
       GRANT SELECT, UPDATE ON public.coord_effects TO nemodots_app`,
    );
    const firstStarted = latch();
    const releaseFirst = latch();
    const deliveries: string[] = [];
    const handlerFor =
      (name: string, hold: boolean) =>
      async (_message: unknown, helpers: OutboxHelpers) => {
        deliveries.push(name);
        if (hold) {
          firstStarted.open();
          await releaseFirst.promise;
        }
        await helpers.runOnce(async (client: import('pg').PoolClient) => {
          await client.query('UPDATE public.coord_effects SET n = n + 1');
        });
      };
    // claimMs is shorter than the first handler's runtime: the lease lapses
    // and a second worker legitimately receives the same message (at-least-once).
    const first = createOutbox(h.coordinator.deps, {
      workerId: 'worker-1',
      claimMs: 80,
      handlers: { 'test.effect': handlerFor('worker-1', true) as never },
    });
    const second = createOutbox(h.coordinator.deps, {
      workerId: 'worker-2',
      claimMs: 80,
      handlers: { 'test.effect': handlerFor('worker-2', false) as never },
    });
    const client = await h.pool.connect();
    const id = (await enqueueOutbox(client, {
      topic: 'test.effect',
      payload: { n: 1 },
    }))!;
    client.release();

    const firstRun = first.processBatch();
    await firstStarted.promise;
    await sleep(150); // worker-1's claim lapsed
    expect(await second.processBatch()).toBe(1);
    releaseFirst.open();
    await firstRun;

    expect(deliveries.sort()).toEqual(['worker-1', 'worker-2']); // delivered twice ...
    const { rows } = await h.admin.query('SELECT n FROM public.coord_effects');
    expect(rows[0].n).toBe(1); // ... applied once
    expect(
      await count(h, 'coordinator.outbox_applied', 'outbox_id = $1', [id]),
    ).toBe(1);
    const row = await messageRow(h.admin, id);
    expect(row.processed_at).not.toBeNull();
  });
});

it('dedupeKey makes enqueue idempotent', async () => {
  await withHarness(async (h) => {
    const client = await h.pool.connect();
    const a = await enqueueOutbox(client, {
      topic: 't',
      payload: {},
      dedupeKey: 'k',
    });
    const b = await enqueueOutbox(client, {
      topic: 't',
      payload: {},
      dedupeKey: 'k',
    });
    client.release();
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await count(h, 'coordinator.outbox', "dedupe_key = 'k'")).toBe(1);
  });
});

it('a failing handler is retried with backoff and parked as failed after maxAttempts', async () => {
  await withHarness(async (h) => {
    let calls = 0;
    const errors: unknown[] = [];
    const outbox = createOutbox(h.coordinator.deps, {
      workerId: 'w',
      maxAttempts: 2,
      handlers: {
        'test.fail': async () => {
          calls += 1;
          throw new Error('handler exploded');
        },
      },
      onError: (error) => errors.push(error),
    });
    const client = await h.pool.connect();
    const id = (await enqueueOutbox(client, {
      topic: 'test.fail',
      payload: {},
    }))!;
    client.release();
    expect(await outbox.processBatch()).toBe(1);
    let row = await messageRow(h.admin, id);
    expect(row.attempts).toBe(1);
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBe('handler exploded');
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now()); // backoff
    // Fast-forward the backoff and deliver again: second failure parks it.
    await h.admin.query(
      'UPDATE coordinator.outbox SET available_at = now() WHERE id = $1',
      [id],
    );
    expect(await outbox.processBatch()).toBe(1);
    row = await messageRow(h.admin, id);
    expect(row.failed_at).not.toBeNull();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    await h.admin.query(
      'UPDATE coordinator.outbox SET available_at = now() WHERE id = $1',
      [id],
    );
    expect(await outbox.processBatch()).toBe(0); // parked messages are not redelivered
  });
});

it('an unknown topic is not silently dropped', async () => {
  await withHarness(async (h) => {
    const outbox = createOutbox(h.coordinator.deps, {
      workerId: 'w',
      handlers: {},
    });
    const client = await h.pool.connect();
    const id = (await enqueueOutbox(client, {
      topic: 'nobody.listens',
      payload: {},
    }))!;
    client.release();
    await outbox.processBatch();
    const row = await messageRow(h.admin, id);
    expect(row.processed_at).toBeNull();
    expect(row.last_error).toMatch(/no handler/);
  });
});

it('LISTEN nemodots_outbox wakes the loop faster than the poll interval', async () => {
  await withHarness(async (h) => {
    const handled = latch<number>();
    const outbox = createOutbox(h.coordinator.deps, {
      workerId: 'listener',
      pollMs: 30_000,
      handlers: {
        'test.wake': async (message) => {
          handled.open(message.id);
        },
      },
    });
    await outbox.start();
    try {
      await sleep(200); // let the first (empty) tick finish and the loop park
      const started = Date.now();
      const client = await h.pool.connect();
      const id = (await enqueueOutbox(client, {
        topic: 'test.wake',
        payload: {},
      }))!;
      client.release();
      expect(await handled.promise).toBe(id);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await outbox.stop();
    }
  });
});

it('the action.proposed handler schedules admission no earlier than proposedAt + mission.admission.minAgeMs (D6)', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h, {
      admission: { minAgeMs: 600 },
    });
    const instant = await createRunningMission(h, {
      admission: { minAgeMs: 0 },
    });
    expect(mission.admission.minAgeMs).toBe(600);
    const outbox = createOutbox(h.coordinator.deps, {
      workerId: 'dispatcher-1',
      handlers: {
        [OUTBOX_TOPICS.actionProposed]: createCoordinatorHandlers(
          h.coordinator.deps,
          h.coordinator.recovery,
          { dispatcherId: 'dispatcher-1' },
        )[OUTBOX_TOPICS.actionProposed],
      },
    });
    const proposedAt = new Date();
    const delayed = randomUUID();
    const immediate = randomUUID();
    const client = await h.pool.connect();
    const delayedMsg = (await enqueueOutbox(client, {
      missionId: mission.id,
      topic: OUTBOX_TOPICS.actionProposed,
      payload: {
        actionId: delayed,
        missionId: mission.id,
        proposedAt: proposedAt.toISOString(),
      },
    }))!;
    await enqueueOutbox(client, {
      missionId: instant.id,
      topic: OUTBOX_TOPICS.actionProposed,
      payload: {
        actionId: immediate,
        missionId: instant.id,
        proposedAt: proposedAt.toISOString(),
      },
    });
    client.release();

    await outbox.drain();
    // minAgeMs 0 admits at once; minAgeMs 600 stays queued without using an attempt.
    expect(h.admits.map((call) => call.actionId)).toEqual([immediate]);
    const queued = await messageRow(h.admin, delayedMsg);
    expect(queued.processed_at).toBeNull();
    expect(queued.attempts).toBe(0);
    expect(new Date(queued.available_at).getTime()).toBe(
      proposedAt.getTime() + 600,
    );

    await until(async () => {
      await outbox.drain();
      return h.admits.length === 2;
    }, 'delayed admission');
    const call = h.admits.find((item) => item.actionId === delayed)!;
    expect(call.at).toBeGreaterThanOrEqual(proposedAt.getTime() + 600);
    expect(call.dispatcher).toBe('dispatcher-1');
    expect(h.admits.filter((item) => item.actionId === delayed)).toHaveLength(
      1,
    );
    expect((await messageRow(h.admin, delayedMsg)).processed_at).not.toBeNull();
  });
});
