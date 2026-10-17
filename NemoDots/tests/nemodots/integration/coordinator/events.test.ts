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
    const idA = await sink.append(a, {
      missionId,
      kind: 'heartbeat',
      payload: heartbeat,
    });
    let bAppended = false;
    const bAppend = sink
      .append(b, { missionId, kind: 'heartbeat', payload: heartbeat })
      .then((id) => {
        bAppended = true;
        return id;
      });
    await sleep(300);
    // B is parked on the events advisory lock: it holds no id yet, so it cannot
    // commit a higher id before A's lower one.
    expect(bAppended).toBe(false);

    // A reader that polls now sees nothing past the baseline.
    expect(
      (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
    ).toEqual([]);

    await a.query('COMMIT');
    a.release();
    const idB = await withTimeout(bAppend, 5_000, 'B append after A commits');
    expect(idB).toBeGreaterThan(idA);
    // After A's commit the reader sees exactly A ...
    expect(
      (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
    ).toEqual([idA]);
    await b.query('COMMIT');
    b.release();
    // ... and then exactly the gap [B] when resuming from A.
    expect(
      (await replayEvents(h.pool, missionId, idA)).map((e) => e.id),
    ).toEqual([idB]);
    expect(
      (await replayEvents(h.pool, missionId, baseline)).map((e) => e.id),
    ).toEqual([idA, idB]);
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

it('many concurrent writers: ids are strictly commit-ordered with no skipped row visible to a polling tailer', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const sink = createEventSink();
    const baseline = (await replayEvents(h.pool, missionId, 0)).at(-1)!.id;
    const commitOrder: number[] = [];
    let writing = true;
    const seen: number[] = [];
    let last = baseline;
    const tailer = (async () => {
      while (writing) {
        for (const event of await replayEvents(h.pool, missionId, last)) {
          seen.push(event.id);
          last = event.id;
        }
        await sleep(2);
      }
    })();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        (async () => {
          for (let i = 0; i < 12; i += 1) {
            const client = await begin(h.pool);
            const id = await sink.append(client, {
              missionId,
              kind: 'heartbeat',
              payload: heartbeat,
            });
            await client.query('COMMIT');
            commitOrder.push(id);
            client.release();
          }
        })(),
      ),
    );
    writing = false;
    await tailer;
    for (const event of await replayEvents(h.pool, missionId, last))
      seen.push(event.id);
    expect(commitOrder).toEqual([...commitOrder].sort((x, y) => x - y));
    expect(seen).toHaveLength(72);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(72);
  });
});

it('pg_notify nemodots_events is delivered on commit, carrying mission id and event id', async () => {
  await withHarness(async (h) => {
    const mission = await createRunningMission(h);
    const missionId = mission.id as MissionId;
    const listener = new pg.Client({ connectionString: h.db.urls.app });
    await listener.connect();
    const notified = latch<{ missionId: string; id: number }>();
    listener.on('notification', (message) => {
      notified.open(JSON.parse(message.payload ?? '{}'));
    });
    await listener.query('LISTEN nemodots_events');
    try {
      const client = await begin(h.pool);
      const id = await createEventSink().append(client, {
        missionId,
        kind: 'heartbeat',
        payload: heartbeat,
      });
      await sleep(150);
      expect(notified.isOpen).toBe(false); // not before commit
      await client.query('COMMIT');
      client.release();
      expect(
        await withTimeout(notified.promise, 5_000, 'notification'),
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
