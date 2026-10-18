import { describe, expect, it } from 'vitest';
import { checkEvent } from '../../../src/server/nemodots/routes/events-stream.js';
import type { MissionEvent } from '../../../src/server/nemodots/contracts/index.js';

const missionId = '4f3d9ae1-4a63-4a0d-9d36-3b1e5a6c7d80';
const event = (over: Record<string, unknown> = {}): MissionEvent =>
  ({
    id: 5,
    missionId,
    kind: 'heartbeat',
    at: '2026-10-17T10:00:00.000Z',
    payload: { kind: 'heartbeat' },
    ...over,
  }) as MissionEvent;

describe('checkEvent (D4)', () => {
  it('passes a schema-valid event of the path mission', () => {
    expect(checkEvent(event(), missionId)).toEqual(event());
  });

  it('refuses a payload that fails EventPayloadSchema', () => {
    expect(
      checkEvent(
        event({
          kind: 'task.status',
          payload: { kind: 'task.status', taskId: 'x' },
        }),
        missionId,
      ),
    ).toBeNull();
    expect(
      checkEvent(
        event({ payload: { kind: 'heartbeat', control: { oracle: 1 } } }),
        missionId,
      ),
    ).toBeNull();
  });

  it('refuses a kind that disagrees with the payload kind and an event of another mission', () => {
    expect(
      checkEvent(
        event({
          kind: 'heartbeat',
          payload: {
            kind: 'mission.status',
            from: 'created',
            to: 'running',
            reason: null,
          },
        }),
        missionId,
      ),
    ).toBeNull();
    expect(
      checkEvent(event(), '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
  });
});
