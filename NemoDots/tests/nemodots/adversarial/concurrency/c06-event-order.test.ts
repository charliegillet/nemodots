// C6 (medium): events.id insert order must equal commit order, so a tailer
// reading `WHERE id > $last` never skips a row.
// Expected (ARCHITECTURE 8, 14 C6): every inserting transaction takes
// pg_advisory_xact_lock(hashtext('nemodots_events')) immediately before the
// INSERT, so a transaction cannot obtain an id while an earlier id is still
// uncommitted. A negative control without the lock shows the hazard is real.
import { describe, expect, it } from 'vitest';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  latch,
  randomUUID,
  sleep,
  until,
  waitForLockWaiters,
  withWorld,
  type World,
} from './harness.js';

const event = (actionId: string) =>
  ({
    kind: 'action.verified',
    actionId,
    postcondition: { kind: 'observation', receiptId: null, configVersion: 1 },
  }) as never;

async function append(world: World, client: unknown) {
  return createEventSink().append(client as never, {
    missionId: world.missionId as never,
    kind: 'action.verified',
    payload: event(randomUUID()),
  });
}

describe('C6 event order', () => {
  it('a writer that starts after an uncommitted one cannot take a higher id and commit first', async () => {
    await withWorld(async (world) => {
      const one = await world.app.connect();
      const two = await world.app.connect();
      try {
        await one.query('BEGIN');
        const first = await append(world, one); // id N, uncommitted, lock held
        await two.query('BEGIN');
        let secondId: number | null = null;
        const second = append(world, two).then((id) => (secondId = id));
        await waitForLockWaiters(world, 1);
        expect(secondId).toBeNull(); // blocked: no id handed out yet
        await one.query('COMMIT');
        await second;
        await two.query('COMMIT');
        expect(secondId!).toBeGreaterThan(first);
      } finally {
        one.release();
        two.release();
      }
    });
  });

  it('forty writers with random hold times and a concurrent tailer: the tailer sees every id exactly once, in order', async () => {
    await withWorld(async (world) => {
      const seen: number[] = [];
      let last = 0;
      let stop = false;
      const tailer = (async () => {
        while (!stop) {
          const { rows } = await world.admin.query<{ id: string }>(
            'SELECT id FROM coordinator.events WHERE mission_id = $1 AND id > $2 ORDER BY id',
            [world.missionId, last],
          );
          for (const row of rows) {
            seen.push(Number(row.id));
            last = Number(row.id);
          }
          await sleep(2);
        }
      })();
      const written: number[] = [];
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          withTransaction(world.app, async (client) => {
            const id = await append(world, client);
            await sleep((i * 7) % 23); // hold the transaction open a random while
            written.push(id);
          }),
        ),
      );
      await until(async () => seen.length >= 40, 'tailer to catch up');
      stop = true;
      await tailer;
      expect([...seen].sort((a, b) => a - b)).toEqual(
        [...written].sort((a, b) => a - b),
      );
      for (let i = 1; i < seen.length; i += 1)
        expect(seen[i]).toBeGreaterThan(seen[i - 1]);
      expect(new Set(seen).size).toBe(40);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('negative control: inserts WITHOUT the advisory lock let the higher id commit first and the tailer skips the lower one', async () => {
    await withWorld(async (world) => {
      const insert = (client: {
        query: (q: string, v: unknown[]) => Promise<unknown>;
      }) =>
        client.query(
          `INSERT INTO coordinator.events (mission_id, kind, payload)
           VALUES ($1, 'action.verified', $2::jsonb)`,
          [world.missionId, JSON.stringify(event(randomUUID()))],
        );
      const one = await world.app.connect();
      const two = await world.app.connect();
      try {
        const gate = latch();
        await one.query('BEGIN');
        await insert(one as never); // lower id, uncommitted
        await two.query('BEGIN');
        await insert(two as never); // higher id
        await two.query('COMMIT'); // higher id commits first
        const { rows } = await world.admin.query<{ id: string }>(
          'SELECT id FROM coordinator.events WHERE mission_id = $1 ORDER BY id',
          [world.missionId],
        );
        const tailerLast = Number(rows.at(-1)!.id);
        await one.query('COMMIT');
        const later = await world.admin.query<{ id: string }>(
          'SELECT id FROM coordinator.events WHERE mission_id = $1 AND id > $2',
          [world.missionId, tailerLast],
        );
        expect(later.rows).toHaveLength(0); // the lower id is invisible to `id > last`
        gate.open(undefined);
      } finally {
        one.release();
        two.release();
      }
    });
  });
});
