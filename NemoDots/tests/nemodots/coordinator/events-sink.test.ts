// EventSink statement order and payload validation, with a recording client
// (the ordering against real PostgreSQL is in integration/coordinator/events).
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  EventBuffer,
  createEventSink,
} from '../../../src/server/nemodots/coordinator/events.js';
import type {
  EventPayload,
  MissionId,
  PgClient,
} from '../../../src/server/nemodots/contracts/index.js';

function recorder() {
  const statements: { text: string; values: unknown[] }[] = [];
  let nextId = 41;
  const client: PgClient = {
    async query(text: string, values: unknown[] = []) {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (/INSERT INTO coordinator\.events/.test(text))
        return { rows: [{ id: String(++nextId) }] as never[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, statements };
}

const missionId = randomUUID() as MissionId;
const heartbeat = { kind: 'heartbeat' } as EventPayload;

describe('createEventSink', () => {
  it('takes pg_advisory_xact_lock(hashtext) as the statement immediately before the INSERT, then notifies', async () => {
    const { client, statements } = recorder();
    const id = await createEventSink().append(client, {
      missionId,
      kind: 'heartbeat',
      payload: heartbeat,
    });
    expect(id).toBe(42);
    expect(
      statements.map((s) => s.text.split(' ').slice(0, 3).join(' ')),
    ).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'INSERT INTO coordinator.events',
      'SELECT pg_notify($1, $2)',
    ]);
    expect(statements[0].values).toEqual(['nemodots_events']);
    expect(statements[2].values[0]).toBe('nemodots_events');
    expect(JSON.parse(statements[2].values[1] as string)).toEqual({
      missionId,
      id: 42,
    });
  });

  it('validates before touching the database', async () => {
    const { client, statements } = recorder();
    const sink = createEventSink();
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
        kind: 'heartbeat',
        payload: { kind: 'heartbeat', prompt: 'leak' } as never,
      }),
    ).rejects.toThrow();
    expect(statements).toEqual([]);
  });
});

describe('EventBuffer', () => {
  it('appends in insertion order only on flush, and is empty afterwards', async () => {
    const { client, statements } = recorder();
    const buffer = new EventBuffer(createEventSink());
    buffer.add(missionId, heartbeat);
    buffer.add(missionId, {
      kind: 'mission.status',
      from: 'created',
      to: 'running',
      reason: null,
    });
    expect(buffer.size).toBe(2);
    expect(statements).toHaveLength(0);
    expect(await buffer.flush(client)).toEqual([42, 43]);
    const inserts = statements.filter((s) => s.text.startsWith('INSERT'));
    expect(inserts.map((s) => s.values[1])).toEqual([
      'heartbeat',
      'mission.status',
    ]);
    expect(buffer.size).toBe(0);
    expect(await buffer.flush(client)).toEqual([]);
  });
});
