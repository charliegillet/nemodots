// The G1 predicate set, run by BOTH the admission and the commit transaction
// (finding C4): the commit re-executes every predicate under FOR UPDATE.
//
// Caller contract (lock order, ARCHITECTURE 5.1 / ledger prelock.ts):
//   1. the intent row is locked FOR UPDATE and the mission row FOR SHARE
//      (coordinator rows first),
//   2. evaluate() locks the controlled config rows (collection first, members
//      by key; FOR SHARE for admission, FOR UPDATE for commit),
//   3. then the ledger rows through SupportValidator.assertCurrent
//      (registry rows, receipt rows).
// Nothing in here touches Redis, an LLM or the network.
import {
  actionTargetSourceKey,
  digest,
  FlushCachePayloadSchema,
  POLICY_VERSION,
  requiredSourcesFor,
  SetConfigPayloadSchema,
  type BlockReason,
  type MissionId,
  type CheckedVector,
  type PgClient,
  type SupportValidator,
} from '../contracts/index.js';
import { lockConfigRows } from '../sandbox/version-authority.js';
import {
  capabilityFor,
  maxAgeFor,
  memberKeysOf,
  payloadHashOf,
  payloadInDomain,
  type ActionPayload,
} from './policy.js';
import { ActionNotFoundError } from './errors.js';
import { getIntentRow, type IntentRow } from './rows.js';

const MEMBER_PREFIX = 'checkout.config/';

export interface MissionState {
  id: string;
  status: string;
  generation: number;
}

export interface Evaluation {
  ok: boolean;
  reason: BlockReason | null;
  detail: string | null;
  checked: CheckedVector;
  targetVersion: { expected: number; live: number };
  /** The locked live value of a set_config target (null for other actions). */
  liveValue: unknown;
}

const memberOf = (sourceKey: string) =>
  sourceKey.startsWith(MEMBER_PREFIX)
    ? sourceKey.slice(MEMBER_PREFIX.length)
    : sourceKey;

function supportErrorShape(error: unknown): {
  reason: BlockReason;
  detail: string;
  checkedVector: CheckedVector;
} | null {
  if (
    error instanceof Error &&
    error.name === 'SupportError' &&
    typeof (error as { reason?: unknown }).reason === 'string'
  ) {
    const shaped = error as unknown as {
      reason: BlockReason;
      detail?: string;
      checkedVector?: CheckedVector;
    };
    return {
      reason: shaped.reason,
      detail: shaped.detail ?? error.message,
      checkedVector: shaped.checkedVector ?? [],
    };
  }
  return null;
}

async function readMissionState(
  client: PgClient,
  missionId: string,
): Promise<MissionState> {
  const { rows } = await client.query<MissionState>(
    'SELECT id, status, generation FROM coordinator.missions WHERE id = $1',
    [missionId],
  );
  return rows[0];
}

/** Locks the mission row FOR SHARE (a cancel waits for us) and returns it. */
export async function lockMissionShared(
  client: PgClient,
  missionId: string,
): Promise<MissionState> {
  const { rows } = await client.query<MissionState>(
    'SELECT id, status, generation FROM coordinator.missions WHERE id = $1 FOR SHARE',
    [missionId],
  );
  return rows[0] ?? (await readMissionState(client, missionId));
}

/**
 * Lock order of every action transaction: the MISSION row (FOR SHARE) first,
 * then the intent row (FOR UPDATE). It matches the coordinator's own order
 * (mission -> attempt -> task -> intent) and keeps a commit, a pause (mission
 * FOR UPDATE then attempt rows) and a closure registration (attempt rows, then
 * intents) from forming a cycle (adversarial finding C-02).
 */
export async function lockMissionThenIntent(
  client: PgClient,
  actionId: string,
): Promise<{ intent: IntentRow; mission: MissionState }> {
  const { rows } = await client.query<{ mission_id: string }>(
    'SELECT mission_id FROM coordinator.action_intents WHERE id = $1',
    [actionId],
  );
  if (!rows[0]) throw new ActionNotFoundError(actionId);
  const mission = await lockMissionShared(client, rows[0].mission_id);
  const intent = await getIntentRow(client, actionId, 'update');
  return { intent, mission };
}

function blocked(
  reason: BlockReason,
  detail: string,
  expected: number,
  live: number,
  checked: CheckedVector = [],
  liveValue: unknown = null,
): Evaluation {
  return {
    ok: false,
    reason,
    detail,
    checked,
    targetVersion: { expected, live },
    liveValue,
  };
}

export async function evaluate(
  client: PgClient,
  validator: SupportValidator,
  intent: IntentRow,
  mission: MissionState,
  lockMode: 'share' | 'update',
): Promise<Evaluation> {
  const expected = intent.expected_target_version;
  const targetKey = memberOf(
    (intent.target as { sourceKey: string }).sourceKey,
  );
  const lockedLive = async () => {
    const { keys, collection } = memberKeysOf(
      intent.dependency_vector,
      (intent.target as { sourceKey: string }).sourceKey,
    );
    return lockConfigRows(client, { keys, collection, mode: lockMode });
  };

  // 1. mission lifecycle (the mission row is share-locked by the caller)
  if (mission.status !== 'running') {
    const locked = await lockedLive();
    return blocked(
      'mission_not_running',
      `mission is ${mission.status}`,
      expected,
      locked.versions.get(targetKey) ?? 0,
    );
  }
  if (mission.generation !== intent.generation) {
    const locked = await lockedLive();
    return blocked(
      'generation_mismatch',
      `mission generation ${mission.generation}, intent ${intent.generation}`,
      expected,
      locked.versions.get(targetKey) ?? 0,
    );
  }

  // 2. config rows (collection first, members by key) BEFORE any ledger row
  const locked = await lockedLive();
  const live = locked.versions.get(targetKey) ?? 0;
  const fail = (reason: BlockReason, detail: string, checked?: CheckedVector) =>
    blocked(reason, detail, expected, live, checked);

  // 3. server-side policy: version, expiry, capability, payload binding
  if (intent.policy_version !== POLICY_VERSION)
    return fail(
      'policy_version_mismatch',
      `intent policy ${intent.policy_version}, server ${POLICY_VERSION}`,
    );
  const { rows: clock } = await client.query<{ expired: boolean }>(
    'SELECT $1::timestamptz <= clock_timestamp() AS expired',
    [intent.expires_at],
  );
  if (clock[0].expired) return fail('expired', 'the intent passed its expiry');
  const { rows: tasks } = await client.query<{ capabilities: string[] }>(
    'SELECT capabilities FROM coordinator.tasks WHERE id = $1',
    [intent.task_id],
  );
  const expectedCapability = capabilityFor(
    intent.action as 'set_config' | 'flush_cache_namespace',
  );
  if (
    intent.actor_capability !== expectedCapability ||
    !tasks[0]?.capabilities.includes(expectedCapability)
  )
    return fail(
      'capability_denied',
      `the author task does not hold ${expectedCapability}`,
    );

  const action = intent.action as 'set_config' | 'flush_cache_namespace';
  const parsed =
    action === 'set_config'
      ? SetConfigPayloadSchema.safeParse(intent.payload)
      : FlushCachePayloadSchema.safeParse(intent.payload);
  if (!parsed.success)
    return fail('payload_invalid', 'stored payload fails the strict schema');
  const payload = parsed.data as ActionPayload;
  if (!payloadInDomain(action, payload))
    return fail('payload_invalid', 'payload is outside the value domain');
  if (
    payloadHashOf(action, payload, intent.supporting_receipt_ids) !==
      intent.payload_hash ||
    (intent.target as { sourceKey: string }).sourceKey !==
      actionTargetSourceKey(action, payload)
  )
    return fail('payload_invalid', 'payload does not match its bound hash');

  // 4. required sources are part of the vector (no easier policy, no irrelevant receipt)
  const have = new Set(intent.dependency_vector.map((e) => e.sourceKey));
  const missing = requiredSourcesFor(action, payload).filter(
    (key) => !have.has(key as never),
  );
  if (missing.length > 0)
    return fail(
      'missing_required_source',
      `required source(s) not in the dependency vector: ${missing.join(', ')}`,
    );

  // 5. the FULL vector is current, freshness included (ledger locks follow)
  let checked: CheckedVector;
  try {
    // missionId is a ledger extension of the port options (F4 scope check).
    const options = {
      lockMode,
      freshness: maxAgeFor(action),
      missionId: intent.mission_id as MissionId,
    };
    checked = await validator.assertCurrent(
      client,
      intent.dependency_vector.map((entry) => entry.receiptId),
      options,
    );
  } catch (error) {
    const support = supportErrorShape(error);
    if (!support) throw error;
    return fail(support.reason, support.detail, support.checkedVector);
  }

  // 6. the target itself: version and (set_config) the value the model saw
  if (live !== expected)
    return fail(
      'target_version_mismatch',
      `${targetKey} is at version ${live}, the intent was made against ${expected}`,
      checked,
    );
  let liveValue: unknown = null;
  if (action === 'set_config') {
    const { rows } = await client.query<{ value: unknown }>(
      'SELECT value FROM checkout.config_entries WHERE key = $1',
      [targetKey],
    );
    liveValue = rows[0]?.value ?? null;
    if (
      rows.length === 0 ||
      digest(liveValue) !==
        (payload as { expectedCurrentValueDigest: string })
          .expectedCurrentValueDigest
    )
      return fail(
        'target_version_mismatch',
        `the current value of ${targetKey} is not the value the intent assumed`,
        checked,
      );
  }
  return {
    ok: true,
    reason: null,
    detail: null,
    checked,
    targetVersion: { expected, live },
    liveValue,
  };
}
