// Durable ordered SSE (ARCHITECTURE.md section 8, CONTRACTS.md section 8):
// replay from Last-Event-ID, live tail via LISTEN with a poll fallback,
// heartbeat, per-mission scope, EventPayloadSchema validation before every
// write, and a bounded write so a stalled client cannot pin the server.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  MissionEventSchema,
  type MissionId,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  createEventSink,
  replayEvents,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  claimStart,
  invalidationFor,
  plannedMission,
  sleep,
  until,
  withHarness,
  type Harness,
} from '../coordinator/harness.js';
import { mountRoutes, openStream, type OpenStream } from './harness.js';

const sink = createEventSink();

async function heartbeat(h: Harness, missionId: string) {
  return withTransaction(h.pool, (client) =>
    sink.append(client, {
      missionId: missionId as MissionId,
      kind: 'heartbeat',
      payload: { kind: 'heartbeat' },
    }),
  );
}

const allIds = async (h: Harness, missionId: string) =>
  (await replayEvents(h.pool, missionId as MissionId, 0, 10_000)).map(
    (e) => e.id,
  );

const waitIds = (stream: OpenStream, count: number, label: string) =>
  until(
    async () => (stream.ids().length >= count ? stream.ids() : null),
    label,
  );

const listeners = async (admin: pg.Pool) =>
  Number(
    (
      await admin.query(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE application_name = 'nemodots-sse-listen' AND datname = current_database()`,
      )
    ).rows[0].n,
  );

describe.each([
  ['LISTEN wake (poll disabled in practice)', true],
  ['poll fallback only', false],
])('replay then live tail: %s', (_name, useListen) => {
  it('replays exactly the missing ids after Last-Event-ID, then streams events inserted while connected', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {
        listenUrl: useListen ? h.db.urls.app : undefined,
        stream: {
          pollMs: useListen ? 60_000 : 50,
          heartbeatMs: 60_000,
          writeTimeoutMs: 5_000,
        },
      });
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      await h.coordinator.control.start(mission.id);
      for (let i = 0; i < 4; i += 1) await heartbeat(h, mission.id);
      const ids = await allIds(h, mission.id);
      expect(ids.length).toBeGreaterThanOrEqual(6);
      const seen = ids[2];
      const missing = ids.filter((id) => id > seen);

      const stream = await openStream(r, `/missions/${mission.id}/events`, {
        'last-event-id': String(seen),
      });
      try {
        expect(stream.response.status).toBe(200);
        expect(stream.response.headers.get('content-type')).toMatch(
          /^text\/event-stream/,
        );
        await waitIds(stream, missing.length, 'replay');
        expect(stream.ids()).toEqual(missing);

        // live: inserted while connected, delivered in commit order
        const live = [
          await heartbeat(h, mission.id),
          await heartbeat(h, mission.id),
        ];
        await waitIds(stream, missing.length + 2, 'live events');
        expect(stream.ids()).toEqual([...missing, ...live]);

        // framing: id line equals coordinator.events.id; data is the whole event
        const last = stream.messages.at(-1)!;
        const event = MissionEventSchema.parse(JSON.parse(last.data));
        expect(String(event.id)).toBe(last.id);
        expect(last.event).toBe(event.kind);
        expect(event.missionId).toBe(mission.id);
        expect(stream.raw()).toContain(`id: ${live[1]}\n`);
      } finally {
        await stream.close();
        r.close();
      }
    });
  });
});

describe('reconnect', () => {
  it('a client resuming with its last id receives no gap and no duplicate', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      await h.coordinator.control.start(mission.id);
      const first = await openStream(r, `/missions/${mission.id}/events`);
      const total = (await allIds(h, mission.id)).length;
      await waitIds(first, total, 'initial replay');
      const got = [...first.ids()];
      await first.close();

      const added = [
        await heartbeat(h, mission.id),
        await heartbeat(h, mission.id),
      ];
      const second = await openStream(r, `/missions/${mission.id}/events`, {
        'last-event-id': String(got.at(-1)),
      });
      await waitIds(second, 2, 'resume');
      expect(second.ids()).toEqual(added);
      expect(new Set([...got, ...second.ids()]).size).toBe(got.length + 2);
      await second.close();
      r.close();
    });
  });

  it('a malformed Last-Event-ID is a 400, not a replay from zero', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      for (const bad of ['abc', '-1', '1.5', '99999999999999999999']) {
        const response = await r.fetchApi(`/missions/${mission.id}/events`, {
          headers: { 'last-event-id': bad },
        });
        expect(response.status, bad).toBe(400);
      }
      expect(
        (await r.get('/missions/4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80/events'))
          .status,
      ).toBe(404);
      r.close();
    });
  });
});

describe('validation before write (C6/D4)', () => {
  it('never writes an event whose payload fails EventPayloadSchema, and keeps streaming later events', async () => {
    await withHarness(async (h) => {
      const invalid: { eventId: number; kind: string }[] = [];
      const r = mountRoutes(h, {
        onInvalidEvent: (info) => invalid.push(info),
      });
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      const base = (await allIds(h, mission.id)).length;
      const stream = await openStream(r, `/missions/${mission.id}/events`);
      try {
        await waitIds(stream, base, 'baseline');

        // written around the sink, as a buggy or hostile writer would
        const insert = async (kind: string, payload: unknown) =>
          Number(
            (
              await h.admin.query(
                `INSERT INTO coordinator.events (mission_id, kind, payload)
                 VALUES ($1, $2, $3::jsonb) RETURNING id`,
                [mission.id, kind, JSON.stringify(payload)],
              )
            ).rows[0].id,
          );
        const badShape = await insert('task.status', {
          kind: 'task.status',
          taskId: 'not-a-uuid',
          prompt: 'RAW PROMPT MUST NOT LEAK',
        });
        const extraKey = await insert('heartbeat', {
          kind: 'heartbeat',
          control: { oracle: 'secret' },
        });
        const good = await heartbeat(h, mission.id);

        await until(async () => stream.ids().includes(good), 'later event');
        expect(stream.ids()).not.toContain(badShape);
        expect(stream.ids()).not.toContain(extraKey);
        expect(stream.raw()).not.toContain('RAW PROMPT');
        expect(stream.raw()).not.toContain('oracle');
        expect(invalid.map((i) => i.eventId)).toEqual([badShape, extraKey]);
        expect(invalid.map((i) => i.kind)).toEqual([
          'task.status',
          'heartbeat',
        ]);
        // every message that was written is itself schema-valid
        for (const message of stream.messages)
          MissionEventSchema.parse(JSON.parse(message.data));
      } finally {
        await stream.close();
        r.close();
      }
    });
  });
});

describe('heartbeat and scope', () => {
  it('writes a heartbeat comment while idle', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {
        stream: { pollMs: 30, heartbeatMs: 120, writeTimeoutMs: 5_000 },
      });
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      const stream = await openStream(r, `/missions/${mission.id}/events`);
      try {
        await until(
          async () =>
            (stream.raw().match(/: heartbeat\n\n/g)?.length ?? 0) >= 2,
          'two heartbeats',
        );
        expect(stream.raw().startsWith(': connected\n\n')).toBe(true);
      } finally {
        await stream.close();
        r.close();
      }
    });
  });

  it("another mission's events never appear in a stream", async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, { listenUrl: h.db.urls.app });
      const one = await h.coordinator.control.create({ goal: 'mission one' });
      const two = await h.coordinator.control.create({ goal: 'mission two' });
      await h.coordinator.control.start(two.id);
      const stream = await openStream(r, `/missions/${one.id}/events`);
      try {
        const base = (await allIds(h, one.id)).length;
        await waitIds(stream, base, 'baseline');
        const foreign = await Promise.all([
          heartbeat(h, two.id),
          heartbeat(h, two.id),
          heartbeat(h, two.id),
        ]);
        const own = await heartbeat(h, one.id);
        await until(async () => stream.ids().includes(own), 'own event');
        await sleep(200);
        for (const id of foreign) expect(stream.ids()).not.toContain(id);
        for (const message of stream.messages)
          expect(JSON.parse(message.data).missionId).toBe(one.id);
        expect(stream.raw()).not.toContain(two.id);
      } finally {
        await stream.close();
        r.close();
      }
    });
  });

  it('an invalidation touching two missions appears in each stream with only that mission subset (I10)', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h);
      const one = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const other = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const claimed = await claimStart(h, {
        taskId: one.taskIds[0],
        missionId: one.missionId,
      });
      const otherClaimed = await claimStart(h, {
        taskId: other.taskIds[0],
        missionId: other.missionId,
      });
      const base = invalidationFor({
        missionId: one.missionId,
        taskIds: [one.taskIds[0]],
        attemptIds: [claimed.context.attemptId],
        preserved: [one.taskIds[1]],
      });
      await h.coordinator.onInvalidation({
        ...base,
        missionIds: [one.missionId, other.missionId],
        affected: {
          ...base.affected,
          attemptIds: [
            claimed.context.attemptId,
            otherClaimed.context.attemptId,
          ],
          taskIds: [one.taskIds[0], other.taskIds[0]],
        },
        perMission: [
          base.perMission[0],
          {
            missionId: other.missionId,
            affected: {
              modelCallIds: [],
              attemptIds: [otherClaimed.context.attemptId],
              outputIds: [],
              actionIds: [],
              taskIds: [other.taskIds[0]],
            },
            preserved: { taskIds: [other.taskIds[1]] },
          },
        ],
      });

      // The coordinator stores each mission's subset in coordinator.invalidations
      // (its snapshot copy) but its onInvalidation path does not append the
      // `invalidation.recorded` event itself (reported as a dependency). This
      // double appends that event for each mission from the coordinator's own
      // mission-scoped copy, through the real sink, exactly as section 8
      // specifies; what is under test is that each stream carries only its
      // mission's subset.
      for (const m of [one, other]) {
        const [stored] = (await h.coordinator.control.snapshot(m.missionId))
          .invalidations;
        await withTransaction(h.pool, (client) =>
          sink.append(client, {
            missionId: m.missionId,
            kind: 'invalidation.recorded',
            payload: {
              kind: 'invalidation.recorded',
              invalidationEventId: stored.id,
              sourceKey: stored.sourceKey,
              oldReceiptId: stored.oldReceiptId,
              newReceiptId: stored.newReceiptId,
              reason: stored.reason,
              selfWrite: stored.selfWrite,
              affected: stored.perMission[0].affected,
              preserved: stored.perMission[0].preserved,
              closure: stored.closure,
            },
          }),
        );
      }

      const streams = await Promise.all(
        [one, other].map((m) =>
          openStream(r, `/missions/${m.missionId}/events`),
        ),
      );
      try {
        const subsets = [];
        for (const [i, stream] of streams.entries()) {
          const missionId = [one, other][i].missionId;
          const total = (await allIds(h, missionId)).length;
          await waitIds(stream, total, `replay ${i}`);
          const recorded = stream.messages
            .map((m) => JSON.parse(m.data))
            .filter((e) => e.kind === 'invalidation.recorded');
          expect(recorded).toHaveLength(1);
          subsets.push(recorded[0].payload);
        }
        expect(subsets[0].affected.taskIds).toEqual([one.taskIds[0]]);
        expect(subsets[0].preserved.taskIds).toEqual([one.taskIds[1]]);
        expect(subsets[1].affected.taskIds).toEqual([other.taskIds[0]]);
        expect(subsets[1].preserved.taskIds).toEqual([other.taskIds[1]]);
        expect(streams[0].raw()).not.toContain(other.taskIds[0]);
        expect(streams[0].raw()).not.toContain(other.taskIds[1]);
        expect(streams[1].raw()).not.toContain(one.taskIds[0]);
        expect(streams[1].raw()).not.toContain(one.taskIds[1]);
      } finally {
        await Promise.all(streams.map((s) => s.close()));
        r.close();
      }
    });
  });
});

describe('connection hygiene', () => {
  it('shares one LISTEN connection, drops it with the last stream, and ends a stalled writer', async () => {
    await withHarness(async (h) => {
      const errors: string[] = [];
      const r = mountRoutes(h, {
        listenUrl: h.db.urls.app,
        stream: { pollMs: 50, heartbeatMs: 60_000, writeTimeoutMs: 150 },
        onError: (info) => errors.push(info.name),
      });
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      expect(await listeners(h.admin)).toBe(0);

      const a = await openStream(r, `/missions/${mission.id}/events`);
      const b = await openStream(r, `/missions/${mission.id}/events`);
      await until(
        async () => (await listeners(h.admin)) === 1,
        'one shared listener',
      );
      await sleep(100);
      expect(await listeners(h.admin)).toBe(1);

      // a client that never reads: the first write stalls and the stream ends
      const stalled = await r.fetchApi(`/missions/${mission.id}/events`);
      expect(stalled.status).toBe(200);
      await sleep(500);
      expect(await listeners(h.admin)).toBe(1); // a and b still hold it
      expect(errors).toEqual([]);

      // the healthy streams are unaffected by the stalled one
      const id = await heartbeat(h, mission.id);
      await until(
        async () => a.ids().includes(id) && b.ids().includes(id),
        'delivery',
      );

      await a.close();
      await b.close();
      await stalled.body?.cancel().catch(() => {});
      await until(
        async () => (await listeners(h.admin)) === 0,
        'listener released',
      );
      r.close();
    });
  });

  it('a stalled client alone releases the listener without being read', async () => {
    await withHarness(async (h) => {
      const r = mountRoutes(h, {
        listenUrl: h.db.urls.app,
        stream: { pollMs: 50, heartbeatMs: 60_000, writeTimeoutMs: 150 },
      });
      const mission = await h.coordinator.control.create({
        goal: 'restore checkout',
      });
      const stalled = await r.fetchApi(`/missions/${mission.id}/events`);
      expect(stalled.status).toBe(200);
      await sleep(600);
      await until(
        async () => (await listeners(h.admin)) === 0,
        'listener released',
      );
      await stalled.body?.cancel().catch(() => {});
      r.close();
    });
  });
});
