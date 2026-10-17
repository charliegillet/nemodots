import { describe, expect, it } from 'vitest';
import {
  EventKindSchema,
  EventPayloadSchema,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  LIMITS,
  applyMissionEvent,
  createMissionState,
  mergeMissionSnapshot,
  missionReducer,
  selectDependencyEdges,
  type MissionState,
} from '../../../src/client/nemodots/mission-events';
import { eventPayloads, invalidationId } from '../contracts/fixtures.js';
import { ev, ids, payload, snapshot, T0, uuid } from './helpers';

const fresh = () => createMissionState(ids.mission);
const apply = (state: MissionState, ...events: ReturnType<typeof ev>[]) =>
  events.reduce((s, e) => applyMissionEvent(s, e).state, state);

describe('fixtures', () => {
  it.each(EventKindSchema.options)(
    '%s fixture validates against EventPayloadSchema',
    (kind) => {
      const result = EventPayloadSchema.safeParse(eventPayloads()[kind]);
      expect(result.error?.issues ?? []).toEqual([]);
    },
  );

  it('the reducer accepts one event of every kind', () => {
    let state = fresh();
    EventKindSchema.options.forEach((kind, index) => {
      const result = applyMissionEvent(state, ev(index + 1, payload(kind)));
      expect(result.outcome).toBe('applied');
      state = result.state;
    });
    expect(state.lastEventId).toBe(EventKindSchema.options.length);
    expect(state.mission?.id).toBe(ids.mission);
    expect(state.actions[0].status).toBe('outcome_unknown');
  });
});

describe('ordering, dedupe and scope', () => {
  it('drops a duplicate id and counts it', () => {
    const event = ev(4, payload('task.created'));
    const once = applyMissionEvent(fresh(), event);
    const twice = applyMissionEvent(once.state, event);
    expect(twice.outcome).toBe('duplicate');
    expect(twice.state.events).toHaveLength(1);
    expect(twice.state.tasks).toHaveLength(1);
    expect(twice.state.counters.duplicates).toBe(1);
  });

  it('accepts out-of-order ids and keeps events ascending', () => {
    const state = apply(
      fresh(),
      ev(3, payload('task.status', { to: 'running' })),
      ev(1, payload('task.created')),
      ev(2, payload('mission.created')),
    );
    expect(state.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(state.lastEventId).toBe(3);
    expect(state.counters.applied).toBe(3);
    expect(state.tasks[0]).toMatchObject({
      title: 'Investigate',
      status: 'running',
      known: true,
    });
  });

  it('a late lower-id status never overwrites a higher-id status', () => {
    const state = apply(
      fresh(),
      ev(10, payload('task.status', { to: 'succeeded' })),
      ev(4, payload('task.status', { to: 'leased' })),
      ev(1, payload('task.created')),
    );
    expect(state.tasks[0].status).toBe('succeeded');
    expect(state.tasks[0].statusEventId).toBe(10);
  });

  it('an early mission.status survives a later mission.created', () => {
    const state = apply(
      fresh(),
      ev(9, payload('mission.status', { from: 'running', to: 'paused' })),
      ev(1, payload('mission.created')),
    );
    expect(state.mission?.status).toBe('paused');
  });

  it('keeps the maximum confirmation time regardless of arrival order', () => {
    const later = ev(
      8,
      payload('receipt.confirmed', {
        confirmedAt: T0.replace('18:00:00', '18:30:00'),
      }),
    );
    const earlier = ev(7, payload('receipt.confirmed', { confirmedAt: T0 }));
    const state = apply(fresh(), later, earlier);
    expect(state.receipts[0].lastConfirmedAt).toBe(
      T0.replace('18:00:00', '18:30:00'),
    );
  });

  it('rejects events for another mission', () => {
    const before = apply(fresh(), ev(1, payload('task.created')));
    const result = applyMissionEvent(
      before,
      ev(2, payload('task.created'), { missionId: ids.mission2 }),
    );
    expect(result.outcome).toBe('wrong_mission');
    expect(result.state.tasks).toEqual(before.tasks);
    expect(result.state.events).toHaveLength(1);
    expect(result.state.lastEventId).toBe(1);
    expect(result.state.counters.wrongMission).toBe(1);
  });

  it('rejects an event whose payload kind disagrees with its kind', () => {
    const bad = {
      ...ev(1, payload('task.created')),
      kind: 'heartbeat',
    } as never;
    expect(applyMissionEvent(fresh(), bad).outcome).toBe('malformed');
  });

  it('heartbeats advance lastEventId without being stored', () => {
    const state = apply(fresh(), ev(5, payload('heartbeat')));
    expect(state.lastEventId).toBe(5);
    expect(state.events).toHaveLength(0);
    expect(state.lastHeartbeatAt).not.toBeNull();
    expect(applyMissionEvent(state, ev(5, payload('heartbeat'))).outcome).toBe(
      'duplicate',
    );
  });

  it('lastEventId is the max of everything accepted', () => {
    const state = apply(
      fresh(),
      ev(20, payload('heartbeat')),
      ev(7, payload('task.created')),
    );
    expect(state.lastEventId).toBe(20);
  });
});

describe('bounds', () => {
  it('bounds events, entities and the seen-id set', () => {
    let state = fresh();
    for (let id = 1; id <= 700; id += 1)
      state = apply(
        state,
        ev(id, payload('receipt.registered', { receiptId: uuid() })),
      );
    expect(state.events).toHaveLength(LIMITS.events);
    expect(state.events[0].id).toBe(201);
    expect(state.receipts.length).toBeLessThanOrEqual(LIMITS.receipts);
    for (let id = 701; id <= 4900; id += 1)
      state = apply(state, ev(id, payload('heartbeat')));
    expect(state.seenIds.size).toBeLessThanOrEqual(LIMITS.seenIds);
    expect(state.floorId).toBeGreaterThan(0);
    expect(
      applyMissionEvent(state, ev(2, payload('task.created'))).outcome,
    ).toBe('stale');
  }, 20000);
});

describe('stray payload keys', () => {
  it('never copies unknown fields into the entity views', () => {
    const dirty = ev(1, payload('action.decided'));
    (dirty.payload as Record<string, unknown>).control = {
      probeSecret: 'SECRET',
    };
    (dirty.payload as Record<string, unknown>).prompt = 'SYSTEM PROMPT';
    const state = apply(fresh(), dirty);
    const views = JSON.stringify({
      ...state,
      events: undefined,
      seenIds: undefined,
    });
    expect(views).not.toContain('SECRET');
    expect(views).not.toContain('SYSTEM PROMPT');
  });
});

describe('snapshot merge', () => {
  it('builds the views from a snapshot', () => {
    const { state, outcome } = mergeMissionSnapshot(fresh(), snapshot());
    expect(outcome).toBe('applied');
    expect(state.lastEventId).toBe(17);
    expect(state.snapshotEventId).toBe(17);
    expect(state.tasks[0].title).toBe('Investigate checkout errors');
    expect(state.receipts[0].lastConfirmedAt).toBe('2026-10-17T18:00:05.000Z');
    expect(state.actions[0].decisions.admission?.decision).toBe('admitted');
    expect(state.actions[0].dispatched?.scriptResult).toBe('applied');
    expect(state.invalidations[0].preservedTaskIds).toEqual([ids.task2]);
    expect(state.telemetry?.calls).toBe(3);
  });

  it('rejects a snapshot for another mission', () => {
    const wrong = snapshot({
      mission: {
        ...snapshot().mission,
        id: ids.mission2,
        scope: { ...snapshot().mission.scope, missionId: ids.mission2 },
      },
    });
    const before = fresh();
    const result = mergeMissionSnapshot(before, wrong);
    expect(result.outcome).toBe('wrong_mission');
    expect(result.state.tasks).toEqual([]);
  });

  it('replays newer retained events over the snapshot and skips covered ones', () => {
    let state = apply(
      fresh(),
      // covered by the snapshot (<= 17): kept for the timeline, not folded
      ev(12, payload('task.status', { to: 'failed' })),
      // newer than the snapshot: folded on top
      ev(20, payload('receipt.transition', { receiptId: ids.receipt })),
    );
    state = mergeMissionSnapshot(state, snapshot()).state;
    expect(state.tasks[0].status).toBe('running');
    expect(state.receipts.find((r) => r.id === ids.receipt)?.status).toBe(
      'superseded',
    );
    expect(state.events.map((e) => e.id)).toEqual([12, 20]);
    expect(state.lastEventId).toBe(20);
  });

  it('events at or below the snapshot id are not folded after the merge', () => {
    let state = mergeMissionSnapshot(fresh(), snapshot()).state;
    const result = applyMissionEvent(
      state,
      ev(15, payload('task.status', { to: 'failed' })),
    );
    expect(result.outcome).toBe('applied');
    state = result.state;
    expect(state.tasks[0].status).toBe('running');
    expect(state.events.map((e) => e.id)).toEqual([15]);
    state = apply(state, ev(18, payload('task.status', { to: 'succeeded' })));
    expect(state.tasks[0].status).toBe('succeeded');
  });

  it('ignores a snapshot older than the one merged', () => {
    const newer = mergeMissionSnapshot(
      fresh(),
      snapshot({ lastEventId: 30 }),
    ).state;
    const result = mergeMissionSnapshot(newer, snapshot({ lastEventId: 17 }));
    expect(result.outcome).toBe('stale');
    expect(result.state.snapshotEventId).toBe(30);
  });
});

describe('missionReducer', () => {
  it('handles event, events, snapshot and reset actions', () => {
    let state = missionReducer(fresh(), {
      type: 'events',
      events: [ev(1, payload('task.created')), ev(2, payload('heartbeat'))],
    });
    expect(state.lastEventId).toBe(2);
    state = missionReducer(state, { type: 'snapshot', snapshot: snapshot() });
    expect(state.lastEventId).toBe(17);
    state = missionReducer(state, {
      type: 'event',
      event: ev(
        18,
        payload('mission.status', { from: 'running', to: 'paused' }),
      ),
    });
    expect(state.mission?.status).toBe('paused');
    expect(
      missionReducer(state, { type: 'reset', missionId: ids.mission2 })
        .lastEventId,
    ).toBe(0);
  });
});

describe('selectDependencyEdges', () => {
  it('derives scheduling edges from prerequisites and evidence edges from read sets and action vectors', () => {
    const state = apply(
      fresh(),
      ev(1, payload('task.created')),
      ev(
        2,
        payload('task.created', {
          task: {
            ...(eventPayloads()['task.created'].task as object),
            id: ids.task2,
            title: 'Verify',
            prerequisites: [ids.task],
          },
        }),
      ),
      ev(3, payload('attempt.finished')),
      ev(4, payload('action.proposed')),
    );
    const edges = selectDependencyEdges(state);
    const scheduling = edges.filter((e) => e.kind === 'scheduling');
    const evidence = edges.filter((e) => e.kind === 'evidence');
    expect(scheduling).toHaveLength(1);
    expect(scheduling[0].from.label).toBe('Investigate');
    expect(scheduling[0].to.label).toBe('Verify');
    expect(evidence.some((e) => e.to.kind === 'task')).toBe(true);
    expect(evidence.some((e) => e.to.kind === 'action')).toBe(true);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });
});

it('keeps the changed-evidence ids stable for timeline tests', () => {
  expect(invalidationId).toMatch(/^[0-9a-f]{64}$/);
});
