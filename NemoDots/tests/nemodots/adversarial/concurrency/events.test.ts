// W5.2: event-id ordering under concurrent commits (ARCHITECTURE 8, finding
// C6): id order equals commit order, so a reader that replays `id > last`
// never skips a row that commits later with a lower id.
import { afterEach, describe, expect, it } from 'vitest';
import { clearHooks } from '../../../../src/server/nemodots/actions/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  createWorld,
  proposeSetConfig,
  waitForLockWaiters,
  withEnv,
} from './harness.js';

afterEach(() => clearHooks());

describe('event ids', () => {
  it('cleared: while an earlier event-writing transaction is open, no later id becomes visible', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const sc = await proposeSetConfig(env, { world });
      const sink = createEventSink();
      const inserted = latch<number>();
      const release = latch();
      // T1 appends an event and stays open
      const first = withTransaction(env.app, async (client) => {
        const id = await sink.append(client, {
          missionId: world.missionId as never,
          kind: 'mission.status',
          payload: {
            kind: 'mission.status',
            from: 'running',
            to: 'running',
            reason: 'adversary T1',
          },
        } as never);
        inserted.open(id);
        await release.promise;
        return id;
      });
      const firstId = await withTimeout(inserted.promise, 5_000, 'T1 inserted');
      // T2: a real admission, which appends events at its end
      let admitted = false;
      const second = env.actions.admit(sc.intent.id, 'd1').then((intent) => {
        admitted = true;
        return intent;
      });
      await waitForLockWaiters(env, 1);
      expect(admitted).toBe(false);
      const visible = await env.admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM coordinator.events WHERE id > $1',
        [firstId],
      );
      expect(Number(visible.rows[0].n)).toBe(0);
      release.open();
      await first;
      expect((await second).status).toBe('admitted');
      const { rows } = await env.admin.query<{ id: string; kind: string }>(
        'SELECT id, kind FROM coordinator.events WHERE mission_id = $1 AND id >= $2 ORDER BY id',
        [world.missionId, firstId],
      );
      expect(Number(rows[0].id)).toBe(firstId);
      expect(rows.slice(1).every((row) => Number(row.id) > firstId)).toBe(true);
      expect(rows.some((row) => row.kind === 'action.decided')).toBe(true);
    }));

  it('cleared: concurrent commits in two missions produce ids in commit order', () =>
    withEnv(async (env) => {
      const a = await proposeSetConfig(env);
      const b = await proposeSetConfig(env, {
        key: 'db.statement_timeout_ms',
        value: 4_000,
      });
      const fa = (await env.actions.admit(a.intent.id, 'd1')) as unknown as {
        dispatch: { fence: number };
      };
      const fb = (await env.actions.admit(b.intent.id, 'd2')) as unknown as {
        dispatch: { fence: number };
      };
      const [ra, rb] = await Promise.all([
        env.actions.commitDetailed(a.intent.id, fa.dispatch.fence),
        env.actions.commitDetailed(b.intent.id, fb.dispatch.fence),
      ]);
      expect(ra.intent.status).toBe('committed');
      expect(rb.intent.status).toBe('committed');
      // xmin order of the event rows (commit order of their transactions
      // under the advisory lock) must match id order
      const { rows } = await env.admin.query<{ id: string; xmin: string }>(
        `SELECT id, xmin::text FROM coordinator.events
          WHERE mission_id = ANY($1::uuid[]) ORDER BY id`,
        [[a.world.missionId, b.world.missionId]],
      );
      const xmins = rows.map((row) => Number(row.xmin));
      const runs = xmins.filter((x, i) => i === 0 || x !== xmins[i - 1]);
      // each transaction's ids are contiguous: no interleaving of two
      // open transactions inside the id sequence
      expect(new Set(runs).size).toBe(runs.length);
    }));
});
