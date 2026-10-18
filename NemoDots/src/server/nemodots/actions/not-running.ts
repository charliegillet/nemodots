import type { EventPayload, PgClient } from '../contracts/index.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import {
  insertAuthorization,
  transition,
  updateResultReceipt,
  type AuthorizationInput,
  type IntentRow,
} from './rows.js';

/**
 * A committed but undispatched flush of a mission that is no longer running
 * ends here: Authorization(dispatch, blocked, mission_not_running) records the
 * reason, the intent becomes failed(effect_not_applied) with the explicit
 * reason in blockDetail, the receipt outcome is failed and no Redis command is
 * issued. FailureReason has no member for it, hence blockDetail (contract gap
 * reported to the lead). The caller holds the mission share lock and the
 * intent row FOR UPDATE.
 */
export async function failNotRunning(
  client: PgClient,
  deps: Pick<ActionsDeps, 'events'>,
  intent: IntentRow,
  fenceToken: number,
  why: string,
  /** The status the intent is moved from (committed, or dispatched / outcome_unknown via reconcile). */
  from: 'committed' | 'dispatched' | 'outcome_unknown' = 'committed',
): Promise<IntentRow> {
  const detail = `mission_not_running: ${why}`;
  const authorization: AuthorizationInput = {
    actionId: intent.id,
    stage: 'dispatch',
    checkedVector: [],
    targetVersion: {
      expected:
        intent.committed_target_version ?? intent.expected_target_version,
      live: intent.committed_target_version ?? intent.expected_target_version,
    },
    authorFence: { token: intent.author_fencing_token, valid: true },
    idempotencyBinding: 'same_payload',
    decision: 'blocked',
    blockReason: 'mission_not_running',
    dispatchFence: { token: fenceToken, valid: false },
  };
  await insertAuthorization(client, authorization);
  const failed = await transition(client, intent.id, from, 'failed', {
    failureReason: 'effect_not_applied',
    set: [['block_detail', detail]],
  });
  await updateResultReceipt(client, intent.id, { outcome: 'failed' });
  await flushEvents(client, deps, intent.mission_id, [
    decidedEvent(authorization, detail),
    {
      kind: 'action.failed',
      actionId: intent.id,
      failureReason: 'effect_not_applied',
      detail,
    } as unknown as EventPayload,
  ]);
  return failed;
}
