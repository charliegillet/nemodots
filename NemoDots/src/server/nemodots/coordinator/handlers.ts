import {
  AcceptanceInFlightError,
  MissionStateError,
  OpenInvalidationsError,
} from './errors.js';
import { getMissionRow, acceptMission, evaluateMission } from './missions.js';
import {
  ActionProposedPayloadSchema,
  MissionTopicPayloadSchema,
  type OutboxHandler,
} from './outbox.js';
import type { Recovery } from './recovery.js';
import type { CoordinatorDeps } from './types.js';

// Outbox handlers owned by the coordinator. Handlers run outside any
// transaction, are idempotent, and are safe under redelivery.

export type HandlerDeps = Pick<
  CoordinatorDeps,
  | 'pool'
  | 'config'
  | 'events'
  | 'intents'
  | 'actions'
  | 'providerHealthy'
  | 'probe'
  | 'clock'
  | 'supportValidator'
>;

export const OUTBOX_TOPICS = Object.freeze({
  actionProposed: 'action.proposed',
  missionEvaluate: 'mission.evaluate',
  missionAccept: 'mission.accept',
  invalidationReevaluate: 'invalidation.reevaluate',
} as const);

export function createCoordinatorHandlers(
  deps: HandlerDeps,
  recovery: Recovery,
  options: { dispatcherId: string },
): Record<string, OutboxHandler> {
  return {
    /**
     * Admission is scheduled no earlier than proposedAt + mission.admission.minAgeMs
     * (finding D6). Before that the message stays queued (deferUntil, no attempt used).
     * ActionAdmissionPort.admit is a CAS (proposed -> admitted | blocked), so a
     * redelivery after a crash is harmless.
     */
    [OUTBOX_TOPICS.actionProposed]: async (message) => {
      const payload = ActionProposedPayloadSchema.parse(message.payload);
      const mission = await getMissionRow(deps.pool, payload.missionId);
      if (!mission) return;
      const notBefore = new Date(
        Date.parse(payload.proposedAt) + mission.admission_min_age_ms,
      );
      if (deps.clock().getTime() < notBefore.getTime())
        return { deferUntil: notBefore };
      await deps.actions.admit(payload.actionId, options.dispatcherId);
    },
    [OUTBOX_TOPICS.missionEvaluate]: async (message) => {
      const { missionId } = MissionTopicPayloadSchema.parse(message.payload);
      await evaluateMission(deps, missionId);
    },
    [OUTBOX_TOPICS.missionAccept]: async (message) => {
      if (!deps.probe) return;
      const { missionId } = MissionTopicPayloadSchema.parse(message.payload);
      try {
        await acceptMission(deps, missionId);
      } catch (error) {
        // The mission moved on (repair scheduled, cancelled): nothing to accept.
        if (error instanceof MissionStateError) return;
        // Open invalidations and a probe already running are transient: keep
        // the message queued without using up an attempt, so it can never be
        // parked while the mission waits for recovery (it would be stuck in
        // awaiting_acceptance).
        if (
          error instanceof OpenInvalidationsError ||
          error instanceof AcceptanceInFlightError
        )
          return { deferUntil: new Date(deps.clock().getTime() + 2_000) };
        throw error;
      }
    },
    [OUTBOX_TOPICS.invalidationReevaluate]: async (message) => {
      const { missionId } = MissionTopicPayloadSchema.parse(message.payload);
      await recovery.reevaluate(missionId);
    },
  };
}
