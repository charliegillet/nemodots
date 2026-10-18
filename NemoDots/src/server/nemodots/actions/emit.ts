// Event emission for the action boundary. Events are appended as the LAST
// statements of a transaction (the events advisory lock is held until COMMIT,
// so the transaction keeps it as short as it can).
import type {
  ActionId,
  Authorization,
  EventPayload,
  MissionId,
  PgClient,
} from '../contracts/index.js';
import { EventBuffer } from '../coordinator/events.js';
import type { ActionsDeps } from './deps.js';
import type { AuthorizationInput } from './rows.js';

export { EventBuffer };

export function decidedEvent(
  input: AuthorizationInput,
  blockDetail: string | null,
): EventPayload {
  return {
    kind: 'action.decided',
    actionId: input.actionId as ActionId,
    stage: input.stage,
    decision: input.decision,
    blockReason: input.blockReason,
    blockDetail,
    checkedVector: input.checkedVector,
    targetVersion: input.targetVersion,
    dispatchFence: input.dispatchFence,
  } as EventPayload;
}

export async function flushEvents(
  client: PgClient,
  deps: Pick<ActionsDeps, 'events'>,
  missionId: string,
  payloads: readonly EventPayload[],
) {
  const buffer = new EventBuffer(deps.events);
  for (const payload of payloads) buffer.add(missionId as MissionId, payload);
  await buffer.flush(client);
}

export type { Authorization };
