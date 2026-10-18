import {
  EventPayloadSchema,
  MissionEventSchema,
  MissionSnapshotSchema,
  type MissionEvent,
  type MissionSnapshot,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  eventPayloads,
  ids,
  snapshotDto,
  T0,
  T1,
} from '../contracts/fixtures.js';

export { ids, T0, T1 };

/** A MissionEvent validated against the shared schema (D4); throws if a fixture drifts. */
export function ev(
  id: number,
  payload: Record<string, unknown>,
  options: { missionId?: string; at?: string } = {},
): MissionEvent {
  const payloadResult = EventPayloadSchema.safeParse(payload);
  if (!payloadResult.success)
    throw new Error(
      `fixture payload ${String(payload.kind)} invalid: ${payloadResult.error.message}`,
    );
  return MissionEventSchema.parse({
    id,
    missionId: options.missionId ?? ids.mission,
    kind: payload.kind,
    at: options.at ?? T1,
    payload,
  });
}

export const payload = (kind: string, patch: Record<string, unknown> = {}) => ({
  ...eventPayloads()[kind],
  ...patch,
});

export function snapshot(patch: Record<string, unknown> = {}): MissionSnapshot {
  return MissionSnapshotSchema.parse({ ...snapshotDto(), ...patch });
}

export const uuid = () => crypto.randomUUID();
