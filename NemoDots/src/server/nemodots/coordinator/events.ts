import {
  EventPayloadSchema,
  type EventPayload,
  type EventSinkPort,
  type MissionEvent,
  type MissionId,
  type PgClient,
} from '../contracts/index.js';
import { iso } from './rows.js';

// ARCHITECTURE.md section 8, finding C6: events.id is a BIGSERIAL, and every
// inserting transaction takes pg_advisory_xact_lock(hashtext('nemodots_events'))
// immediately before the INSERT. The lock is held until commit/rollback, so a
// transaction cannot obtain an id while an earlier id is still uncommitted:
// id order equals commit order and `WHERE id > $last` never skips a row.
//
// Consequence for callers: append events as the LAST statements of a
// transaction (see EventBuffer), because the lock serialises event-writing
// transactions until they commit.

export const EVENTS_CHANNEL = 'nemodots_events';
export const EVENTS_LOCK_KEY = 'nemodots_events';

export function createEventSink(): EventSinkPort {
  return {
    async append(client, event) {
      const payload = EventPayloadSchema.parse(event.payload);
      if (payload.kind !== event.kind)
        throw new TypeError(
          `event kind ${event.kind} does not match payload kind ${payload.kind}`,
        );
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        EVENTS_LOCK_KEY,
      ]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO coordinator.events (mission_id, kind, payload)
         VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [event.missionId, event.kind, JSON.stringify(payload)],
      );
      const id = Number(rows[0].id);
      await client.query(`SELECT pg_notify($1, $2)`, [
        EVENTS_CHANNEL,
        JSON.stringify({ missionId: event.missionId, id }),
      ]);
      return id;
    },
  };
}

/**
 * Collects the events of one transaction and appends them in order at the end,
 * keeping the events advisory lock as short as possible. Create a new buffer
 * inside the transaction callback so a retried callback starts empty.
 */
export class EventBuffer {
  private readonly pending: Omit<MissionEvent, 'id' | 'at'>[] = [];
  constructor(private readonly sink: EventSinkPort) {}

  add(missionId: MissionId | string, payload: EventPayload) {
    this.pending.push({
      missionId: missionId as MissionId,
      kind: payload.kind,
      payload,
    });
  }

  get size() {
    return this.pending.length;
  }

  async flush(client: PgClient): Promise<number[]> {
    const ids: number[] = [];
    for (const event of this.pending)
      ids.push(await this.sink.append(client, event));
    this.pending.length = 0;
    return ids;
  }
}

interface EventRow {
  id: string;
  mission_id: string;
  kind: string;
  payload: EventPayload;
  created_at: Date;
}

/** Replay for the SSE endpoint: events of one mission with id > afterId, ascending. */
export async function replayEvents(
  client: PgClient,
  missionId: MissionId | string,
  afterId: number,
  limit = 500,
): Promise<MissionEvent[]> {
  const { rows } = await client.query<EventRow>(
    `SELECT id, mission_id, kind, payload, created_at
       FROM coordinator.events
      WHERE mission_id = $1 AND id > $2
      ORDER BY id
      LIMIT $3`,
    [missionId, afterId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    missionId: row.mission_id as MissionId,
    kind: row.kind as MissionEvent['kind'],
    at: iso(row.created_at),
    payload: row.payload,
  }));
}

export async function lastEventId(
  client: PgClient,
  missionId: MissionId | string,
): Promise<number> {
  const { rows } = await client.query<{ id: string | null }>(
    `SELECT max(id) AS id FROM coordinator.events WHERE mission_id = $1`,
    [missionId],
  );
  return rows[0].id === null ? 0 : Number(rows[0].id);
}
