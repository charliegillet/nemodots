import type {
  CreateMissionRequest,
  Mission,
  MissionControlPort,
  MissionId,
  MissionSnapshot,
  ReceiptId,
} from '../contracts/index.js';
import {
  acceptMission,
  cancelMission,
  completeAcceptance,
  createMission,
  evaluateMission,
  failMission,
  getMission,
  pauseMission,
  resumeMission,
  startMission,
  type EvaluationOutcome,
} from './missions.js';
import { buildSnapshot } from './snapshot.js';
import type { CoordinatorDeps } from './types.js';

// MissionControlPort (CONTRACTS.md section 10) over the CAS lifecycle in
// missions.ts. `succeeded` is reachable only through awaiting_acceptance with a
// ledger-verified, current acceptance probe receipt whose verdict is pass AND
// nothing blocking the mission from settling (completeAcceptance / acceptMission).

export type ControlDeps = Pick<
  CoordinatorDeps,
  | 'pool'
  | 'config'
  | 'events'
  | 'intents'
  | 'actions'
  | 'providerHealthy'
  | 'probe'
  | 'snapshotReader'
  | 'supportValidator'
>;

export interface MissionControl extends MissionControlPort {
  get(missionId: MissionId): Promise<Mission>;
  /** Drive completion/failure after a task settles (also an outbox handler). */
  evaluate(missionId: MissionId): Promise<EvaluationOutcome>;
  /** Run the acceptance probe and settle an awaiting_acceptance mission. */
  accept(missionId: MissionId): Promise<Mission>;
  /**
   * Settle an awaiting_acceptance mission from a probe receipt id. The receipt
   * is re-read from the ledger and re-validated under the mission lock; nothing
   * but the id is trusted.
   */
  completeAcceptance(
    missionId: MissionId,
    receiptId: ReceiptId,
  ): Promise<Mission>;
  fail(missionId: MissionId, reason: string): Promise<Mission>;
}

export function createMissionControl(deps: ControlDeps): MissionControl {
  return {
    create: (request: CreateMissionRequest) => createMission(deps, request),
    start: (missionId) => startMission(deps, missionId),
    pause: (missionId) => pauseMission(deps, missionId),
    resume: (missionId) => resumeMission(deps, missionId),
    cancel: (missionId) => cancelMission(deps, missionId),
    snapshot: (missionId): Promise<MissionSnapshot> =>
      buildSnapshot(deps, missionId),
    get: (missionId) => getMission(deps, missionId),
    evaluate: (missionId) => evaluateMission(deps, missionId),
    accept: (missionId) => acceptMission(deps, missionId),
    completeAcceptance: (missionId, receiptId) =>
      completeAcceptance(deps, missionId, receiptId),
    fail: (missionId, reason) => failMission(deps, missionId, reason),
  };
}
