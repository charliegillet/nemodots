// Ordered, durable events (ARCHITECTURE.md section 8, finding C6).
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  replayEvents,
  createEventSink,
} from '../../../../src/server/nemodots/coordinator/index.js';
import type {
  EventPayload,
  MissionId,
} from '../../../../src/server/nemodots/contracts/index.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import { createRunningMission, sleep, until, withHarness } from './harness.js';

const heartbeat = { kind: 'heartbeat' } as EventPayload;

async function begin(pool: pg.Pool) {
  const client = await pool.connect();
  await client.query('BEGIN');
  return client;
}

it('events.id order equals commit order: the higher id cannot commit first, and replay returns the exact gap (C6)', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const sink = createEventSink();
    const baseline = (await replayEvents(h.pool, missionId, 0)).at(-1)!.id;

    // Two concurrent inserting transactions. A inserts first and is held open;
    // B tries to insert second and then to commit first.
    const a = await begin(h.pool);
    const b = await begin(h.pool);
    const finished = new Set<pg.PoolClient>();
    const finish = async (client: pg.PoolClient) => {
      finished.add(client);
      await client.query('COMMIT');
      client.release();
    };
    let bAppend: Promise<number> = Promise.resolve(0);
    try {
      const idA = await sink.append(a, {
        missionId,
        kind: 'heartbeat',
        payload: heartbeat,
      });
      let bAppended = false;
      bAppend = sink
        .append(b, { missionId, kind: 'heartbeat', payload: heartbeat })
        .then((id) => {
          bAppended = true;
          return id;
        });
      // Barrier: B's backend is waiting on an ungranted advisory lock in this
      // database. Only then is "B holds no id yet" a statement about the lock
      // and not about how long we happened to wait.
      await until(async () => {
        const { rows } = await h.admin.query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        return rows.length > 0;
      }, 'B parked on the events advisory lock');
      // B is parked on the events advisory lock: it holds no id yet, so it
      // cannot commit a higher id before A's lower one.
      expect(bAppended).toBe(false);

      // A reader that polls now sees nothing past the baseline.
      expect(
        (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
      ).toEqual([]);

      await finish(a);
      const idB = await withTimeout(bAppend, 5_000, 'B append after A commits');
      expect(idB).toBeGreaterThan(idA);
      // After A's commit the reader sees exactly A ...
      expect(
        (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
      ).toEqual([idA]);
      await finish(b);
      // ... and then exactly the gap [B] when resuming from A.
      expect(
        (await replayEvents(h.pool, missionId, idA)).map((e) => e.id),
      ).toEqual([idB]);
      expect(
        (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
      ).toEqual([idA, idB]);
    } finally {
      // A failed assertion must not leave a transaction open: the harness
      // cannot close its pool while a client is checked out.
      if (!finished.has(a)) {
        await a.query('ROLLBACK').catch(() => undefined);
        a.release();
      }
      await bAppend.catch(() => undefined);
      if (!finished.has(b)) {
        await b.query('ROLLBACK').catch(() => undefined);
        b.release();
      }
    }
  });
});

it('control: without the advisory lock the higher id commits first and a tailing reader loses the lower one', async () => {
  // This is the failure the lock prevents; it proves the test above is meaningful.
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id;
    const baseline = (await replayEvents(h.pool, missionId as MissionId, 0)).at(
      -1,
    )!.id;
    const a = await begin(h.pool);
    const b = await begin(h.pool);
    const insert = (client: pg.PoolClient) =>
      client.query(
        `INSERT INTO coordinator.events (mission_id, kind, payload)
         VALUES ($1, 'heartbeat', '{"kind":"heartbeat"}'::jsonb) RETURNING id`,
        [missionId],
      );
    const lowId = Number((await insert(a)).rows[0].id);
    const highId = Number((await insert(b)).rows[0].id);
    expect(highId).toBeGreaterThan(lowId);
    await b.query('COMMIT'); // the higher id commits first
    b.release();
    const seen = (
      await replayEvents(h.pool, missionId as MissionId, baseline)
    ).map((e) => e.id);
    expect(seen).toEqual([highId]);
    await a.query('COMMIT');
    a.release();
    // A tailer resuming from the highest id it saw never receives lowId.
    expect(
      (await replayEvents(h.pool, missionId as MissionId, highId)).map(
        (e) => e.id,
      ),
    ).toEqual([]);
  });
});

it('many concurrent writers: no instant of the stream shows a skipped row, and a cursor tailer receives every id once, in order', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const sink = createEventSink();
    const baseline = (await replayEvents(h.pool, missionId, 0)).at(-1)!.id;
    const ascending = (x: number, y: number) => x - y;
    // C6 is about what a reader can SEE: the order in which commits become
    // visible must equal id order. The order in which the writers' COMMIT
    // acknowledgements reach this process is not that order: a backend that
    // commits first can be descheduled between releasing the lock and replying,
    // so the next writer's whole round trip can finish before the earlier
    // writer's reply is read. Visibility is therefore observed from the reader
    // side only.
    const polls: number[][] = []; // every id visible at a poll, ascending
    const seen: number[] = []; // what a cursor tailer ("id > last") receives
    let last = baseline;
    let writing = true;
    const poll = async () => {
      polls.push(
        (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
      );
      for (const event of await replayEvents(h.pool, missionId, last)) {
        seen.push(event.id);
        last = event.id;
      }
    };
    const tailer = (async () => {
      while (writing) {
        await poll();
        await sleep(2);
      }
    })();
    const handed = await Promise.all(
      Array.from({ length: 6 }, () =>
        (async () => {
          const own: number[] = [];
          for (let i = 0; i < 12; i += 1) {
            const client = await begin(h.pool);
            own.push(
              await sink.append(client, {
                missionId,
                kind: 'heartbeat',
                payload: heartbeat,
              }),
            );
            await client.query('COMMIT');
            client.release();
          }
          return own;
        })(),
      ),
    );
    writing = false;
    await tailer;
    await poll();
    const final = (await replayEvents(h.pool, missionId, baseline)).map(
      (event) => event.id,
    );
    expect(final).toHaveLength(72);
    expect(final).toEqual([...final].sort(ascending));
    // Every id a writer was handed is in the table, once.
    expect(handed.flat().sort(ascending)).toEqual(final);
    // A writer's successive transactions get strictly increasing ids.
    for (const own of handed) expect(own).toEqual([...own].sort(ascending));
    // At no poll was an id visible while a lower one was not.
    for (const visible of polls)
      expect(visible).toEqual(final.slice(0, visible.length));
    // The cursor tailer received exactly the stream, in order, nothing skipped.
    expect(seen).toEqual(final);
  });
});

it('pg_notify nemodots_events is delivered on commit, carrying mission id and event id', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const listener = new pg.Client({ connectionString: h.db.urls.app });
    await listener.connect();
    const delivered = latch<{ missionId: string; id: number }>();
    const sentinel = latch();
    listener.on('notification', (message) => {
      const payload = JSON.parse(message.payload ?? '{}');
      if (payload.sentinel) sentinel.open();
      else delivered.open(payload);
    });
    await listener.query('LISTEN nemodots_events');
    try {
      const client = await begin(h.pool);
      const id = await createEventSink().append(client, {
        missionId,
        kind: 'heartbeat',
        payload: heartbeat,
      });
      // Barrier: a sentinel committed AFTER the append's pg_notify call. The
      // listener receives notifications in queue order, so once the sentinel has
      // arrived, an event notification delivered at append time (before commit)
      // would already have arrived too.
      await h.pool.query(`SELECT pg_notify('nemodots_events', $1)`, [
        JSON.stringify({ sentinel: true }),
      ]);
      await withTimeout(sentinel.promise, 5_000, 'sentinel notification');
      expect(delivered.isOpen).toBe(false); // not before commit
      await client.query('COMMIT');
      client.release();
      expect(
        await withTimeout(delivered.promise, 5_000, 'notification'),
      ).toEqual({ missionId, id });
    } finally {
      await listener.end();
    }
  });
});

it('rejects events whose kind or payload violates the shared schemas', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const sink = createEventSink();
    const client = await begin(h.pool);
    await expect(
      sink.append(client, {
        missionId,
        kind: 'task.status',
        payload: heartbeat,
      }),
    ).rejects.toThrow(/does not match/);
    await expect(
      sink.append(client, {
        missionId,
        kind: 'task.status',
        payload: { kind: 'task.status', taskId: 'nope' } as never,
      }),
    ).rejects.toThrow();
    // A stray key (e.g. leaked control data) is rejected by the strict schema.
    await expect(
      sink.append(client, {
        missionId,
        kind: 'heartbeat',
        payload: { kind: 'heartbeat', control: { secret: 1 } } as never,
      }),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
    client.release();
  });
});

it('the events table is append-only for the app role and CHECK constraints reject unknown kinds', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    await expect(
      h.pool.query(
        `UPDATE coordinator.events SET kind = 'heartbeat' WHERE mission_id = $1`,
        [mission.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      h.pool.query(`DELETE FROM coordinator.events WHERE mission_id = $1`, [
        mission.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      h.pool.query(
        `INSERT INTO coordinator.events (mission_id, kind, payload)
         VALUES ($1, 'not.a.kind', '{"kind":"not.a.kind"}'::jsonb)`,
        [mission.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.pool.query(
        `INSERT INTO coordinator.events (mission_id, kind, payload)
         VALUES ($1, 'heartbeat', '{"kind":"task.status"}'::jsonb)`,
        [mission.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

it('the whole lifecycle produces a gap-free, schema-valid stream whose ids replay in order', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    await h.coordinator.control.pause(mission.id);
    await h.coordinator.control.resume(mission.id);
    await h.coordinator.control.cancel(mission.id);
    const events = await h.coordinator.events.replay(mission.id, 0);
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.map((event) => event.id)).toEqual(
      [...events.map((event) => event.id)].sort((x, y) => x - y),
    );
    const statuses = events
      .filter((event) => event.payload.kind === 'mission.status')
      .map((event) => (event.payload as { to: string }).to);
    expect(statuses).toEqual(['running', 'paused', 'running', 'cancelled']);
    const resumeFrom = events[3].id;
    expect(
      (await h.coordinator.events.replay(mission.id, resumeFrom)).map(
        (event) => event.id,
      ),
    ).toEqual(events.slice(4).map((event) => event.id));
    await until(async () => true, 'noop');
  });
});
