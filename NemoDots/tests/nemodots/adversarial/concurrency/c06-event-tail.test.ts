// C6 (medium) through the REAL SSE tail (routes/events-stream.ts), not only
// through a SELECT loop of our own. The tail replays `id > cursor` for the
// mission, advances its cursor to the highest id it saw, and wakes on LISTEN
// nemodots_events or a poll. If a higher id could become visible before a
// lower one, the cursor would jump over the lower id and the client would
// never receive that event.
// Expected (ARCHITECTURE 8, 14 C6): every inserting transaction takes
// pg_advisory_xact_lock(hashtext('nemodots_events')) immediately before the
// INSERT, so ids are handed out in commit order and the stream delivers every
// id exactly once, in order. A negative control that inserts WITHOUT the lock
// shows the stream really does skip the lower id (so the positive tests can
// fail). The hub is exercised in both wake modes: poll only (no LISTEN
// connection) and LISTEN with a poll interval so long that only NOTIFY can
// wake the stream in time.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MissionId } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  EventHub,
  missionEventStream,
  type EventStreamOptions,
} from '../../../../src/server/nemodots/routes/events-stream.js';
import {
  randomUUID,
  sleep,
  until,
  waitForLockWaiters,
  withWorld,
  type World,
} from './harness.js';

const payload = (actionId: string) =>
  ({
    kind: 'action.verified',
    actionId,
    postcondition: { kind: 'observation', receiptId: null, configVersion: 1 },
  }) as never;

const append = (world: World, client: unknown) =>
  createEventSink().append(client as never, {
    missionId: world.missionId as never,
    kind: 'action.verified',
    payload: payload(randomUUID()),
  });

/** The SSE endpoint's own handler behind a Hono route; reads the response as a client would. */
async function openTail(
  world: World,
  options: { listen: boolean; pollMs: number },
) {
  const invalid: { eventId: number; kind: string }[] = [];
  const errors: unknown[] = [];
  const streamOptions: EventStreamOptions = {
    pollMs: options.pollMs,
    heartbeatMs: 60_000,
    writeTimeoutMs: 10_000,
    batchSize: 50,
    maxReplayFailures: 5,
  };
  const hub = new EventHub(options.listen ? world.db.urls.app : undefined);
  const app = new Hono();
  app.get('/events', (c) =>
    missionEventStream(
      c,
      {
        pool: world.app,
        hub,
        options: streamOptions,
        now: Date.now,
        onInvalidEvent: (info) => invalid.push(info),
        onError: (error) => errors.push(error),
      },
      world.missionId as MissionId,
      0,
    ),
  );
  const response = await app.request('http://localhost/events');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const ids: number[] = [];
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({
        value: undefined,
        done: true,
      }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find((l) => l.startsWith('id: '));
        if (line) ids.push(Number(line.slice(4)));
      }
    }
  })();
  return {
    ids,
    invalid,
    errors,
    waitForCount: (count: number, timeoutMs = 8_000) =>
      until(
        async () => ids.length >= count,
        `${count} streamed events`,
        timeoutMs,
        5,
      ),
    async close() {
      await reader.cancel().catch(() => undefined);
      await pump;
      await hub.close();
    },
  };
}

describe.each([
  ['poll only', { listen: false, pollMs: 5 }],
  ['LISTEN wake-up (poll interval 20 s)', { listen: true, pollMs: 20_000 }],
] as const)('C6 through the SSE tail: %s', (_label, options) => {
  it('a writer that starts after an uncommitted one cannot take a higher id and be streamed first: the stream shows N then N+1', async () => {
    await withWorld(async (world) => {
      const tail = await openTail(world, options);
      try {
        const one = await world.app.connect();
        const two = await world.app.connect();
        try {
          await one.query('BEGIN');
          const first = await append(world, one); // id N, uncommitted, lock held
          await two.query('BEGIN');
          let secondId: number | null = null;
          const second = append(world, two).then((id) => (secondId = id));
          await waitForLockWaiters(world, 1);
          expect(secondId).toBeNull(); // no id handed out while N is uncommitted
          await sleep(60);
          expect(tail.ids).toEqual([]); // nothing visible yet
          await one.query('COMMIT');
          await second;
          await two.query('COMMIT');
          await tail.waitForCount(2);
          expect(tail.ids).toEqual([first, secondId]);
          expect(secondId!).toBeGreaterThan(first);
        } finally {
          one.release();
          two.release();
        }
        expect(tail.invalid).toEqual([]);
        expect(tail.errors).toEqual([]);
      } finally {
        await tail.close();
      }
    });
  });

  it('thirty writers with random hold times against a live tail: every id exactly once, in increasing order, none skipped', async () => {
    await withWorld(async (world) => {
      const tail = await openTail(world, options);
      try {
        const written: number[] = [];
        await Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            withTransaction(world.app, async (client) => {
              const id = await append(world, client);
              await sleep((i * 7) % 19); // hold the lock a random while
              written.push(id);
            }),
          ),
        );
        await tail.waitForCount(30);
        await sleep(50); // nothing extra may arrive
        expect([...tail.ids].sort((a, b) => a - b)).toEqual(
          [...written].sort((a, b) => a - b),
        );
        for (let i = 1; i < tail.ids.length; i += 1)
          expect(tail.ids[i]).toBeGreaterThan(tail.ids[i - 1]);
        expect(new Set(tail.ids).size).toBe(30);
        expect(tail.invalid).toEqual([]);
        expect(world.deadlocks()).toEqual([]);
      } finally {
        await tail.close();
      }
    });
  });
});

describe('C6 negative control through the SSE tail', () => {
  it('inserts WITHOUT the advisory lock: the higher id commits first, the stream moves its cursor past it and never delivers the lower id', async () => {
    await withWorld(async (world) => {
      const tail = await openTail(world, { listen: false, pollMs: 5 });
      try {
        const insert = (client: {
          query: (
            q: string,
            v: unknown[],
          ) => Promise<{ rows: { id: string }[] }>;
        }) =>
          client.query(
            `INSERT INTO coordinator.events (mission_id, kind, payload)
             VALUES ($1, 'action.verified', $2::jsonb) RETURNING id`,
            [world.missionId, JSON.stringify(payload(randomUUID()))],
          );
        const one = await world.app.connect();
        const two = await world.app.connect();
        try {
          await one.query('BEGIN');
          const lower = Number((await insert(one as never)).rows[0].id);
          await two.query('BEGIN');
          const higher = Number((await insert(two as never)).rows[0].id);
          await two.query('COMMIT'); // higher id visible first
          await tail.waitForCount(1);
          expect(tail.ids).toEqual([higher]);
          await one.query('COMMIT'); // the lower id appears behind the cursor
          await sleep(150);
          expect(lower).toBeLessThan(higher);
          expect(tail.ids).toEqual([higher]); // skipped for good
        } finally {
          one.release();
          two.release();
        }
      } finally {
        await tail.close();
      }
    });
  });
});
