// The G1 predicates (ARCHITECTURE.md section 4), shared by the admission and
// the commit transaction: both run exactly this function, the commit with
// FOR UPDATE row locks, the admission with FOR SHARE (finding C4).
//
// Preconditions (the caller's transaction):
//   1. the intent row is locked FOR UPDATE and passed in as `intent`;
//   2. the mission row is locked FOR SHARE and passed in as `mission`.
// This function then takes the controlled rows in the order of every writer
// of the version authority (collection first, then member rows in key order),
// the sources registry and the receipt rows (via the ledger's assertCurrent),
// and returns a verdict. It performs no write. No LLM, Redis or HTTP call.
//
// Precedence of reasons (deterministic, first failing wins):
//   binding/policy -> expired -> mission state -> target version (CAS) ->
//   live value digest -> the supporting vector (stale, unsupported, pending,
//   too old).
import {
  assertCurrent,
  SupportError,
  type LedgerOptions,
} from '../ledger/index.js';
import { lockConfigRows } from '../sandbox/version-authority.js';
import {
  configValueDigest,
  type ConfigScalar,
} from '../sandbox/version-authority.js';
import type {
  BlockReason,
  CheckedVector,
  PgClient,
  ReceiptId,
  SetConfigPayload,
} from '../contracts/index.js';
import {
  checkBinding,
  COLLECTION_SOURCE_KEY,
  configKeyOf,
  freshnessFor,
  parsePayload,
} from './policy.js';
import type { IntentRow } from './rows.js';

export interface MissionFacts {
  status: string;
  generation: number;
}

export interface Verdict {
  ok: boolean;
  reason: BlockReason | null;
  detail: string | null;
  checkedVector: CheckedVector;
  /** Live version of the target under the locks (0 = the key does not exist). */
  targetLive: number;
  /** Live value of the target under the locks (set_config reversal needs it). */
  liveValue: unknown;
}

const fail = (
  reason: BlockReason,
  detail: string,
  rest: Pick<Verdict, 'checkedVector' | 'targetLive' | 'liveValue'>,
): Verdict => ({ ok: false, reason, detail, ...rest });

/** The live version of the target without locking, for verdicts that stop before the locks. */
async function peekTarget(
  client: PgClient,
  intent: IntentRow,
): Promise<{ version: number; value: unknown }> {
  const key = configKeyOf(intent.targetSourceKey);
  if (key === null) return { version: 0, value: undefined };
  const { rows } = await client.query<{ version: string; value: unknown }>(
    'SELECT version, value FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return rows[0]
    ? { version: Number(rows[0].version), value: rows[0].value }
    : { version: 0, value: undefined };
}

export async function evaluatePredicates(
  client: PgClient,
  intent: IntentRow,
  mission: MissionFacts,
  options: { lockMode: 'share' | 'update'; ledger?: LedgerOptions },
): Promise<Verdict> {
  const early = async (reason: BlockReason, detail: string) => {
    const peek = await peekTarget(client, intent);
    return fail(reason, detail, {
      checkedVector: [],
      targetLive: peek.version,
      liveValue: peek.value,
    });
  };

  // Binding and policy: re-derived from the stored row, never trusted.
  const binding = checkBinding({
    action: intent.action,
    adapter: intent.adapter,
    payload: intent.payload,
    payloadHash: intent.payloadHash,
    targetSourceKey: intent.targetSourceKey,
    targetEnvironment: intent.targetEnvironment,
    actorCapability: intent.actorCapability,
    dependencyVector: intent.dependencyVector,
    requiredSources: intent.requiredSources,
    expectedTargetVersion: intent.expectedTargetVersion,
    policyVersion: intent.policyVersion,
  });
  if (binding) return early(binding.reason, binding.detail);

  // Expiry is judged by the database clock now, after any lock wait.
  const expired = await client.query<{ expired: boolean }>(
    'SELECT $1::timestamptz <= clock_timestamp() AS expired',
    [intent.expiresAt],
  );
  if (expired.rows[0]?.expired)
    return early('expired', 'the intent passed its expiry');

  if (mission.status !== 'running')
    return early('mission_not_running', `mission is ${mission.status}`);
  if (mission.generation !== intent.generation)
    return early(
      'generation_mismatch',
      `mission generation ${mission.generation}, intent generation ${intent.generation}`,
    );

  // Controlled rows, in writer order: collection first, then members by key.
  const targetKey = configKeyOf(intent.targetSourceKey)!;
  const memberKeys = new Set<string>([targetKey]);
  let collection = false;
  for (const entry of intent.dependencyVector) {
    if (entry.sourceKey === COLLECTION_SOURCE_KEY) collection = true;
    const key = configKeyOf(entry.sourceKey);
    if (key !== null) memberKeys.add(key);
  }
  const locked = await lockConfigRows(client, {
    keys: [...memberKeys],
    collection,
    mode: options.lockMode,
  });
  const targetVersion = locked.versions.get(targetKey);
  const liveRow = await client.query<{ value: unknown }>(
    'SELECT value FROM checkout.config_entries WHERE key = $1',
    [targetKey],
  );
  const liveValue = liveRow.rows[0]?.value;

  // The supporting vector, examined in full (also when the target already
  // failed, so the Authorization shows every receipt).
  let checkedVector: CheckedVector;
  let support: SupportError | null = null;
  try {
    checkedVector = await assertCurrent(
      client,
      intent.dependencyVector.map((entry) => entry.receiptId) as ReceiptId[],
      {
        lockMode: options.lockMode,
        freshness: freshnessFor(intent.action),
      },
      options.ledger,
    );
  } catch (error) {
    if (!(error instanceof SupportError)) throw error;
    support = error;
    checkedVector = error.checkedVector;
  }
  const rest = {
    checkedVector,
    targetLive: targetVersion ?? 0,
    liveValue,
  };

  if (targetVersion === undefined)
    return fail(
      'stale_version',
      `target ${intent.targetSourceKey} no longer exists in the authority`,
      rest,
    );
  if (targetVersion !== intent.expectedTargetVersion)
    return fail(
      'stale_version',
      `target ${intent.targetSourceKey} is at version ${targetVersion}, the intent expects ${intent.expectedTargetVersion}`,
      rest,
    );
  if (intent.action === 'set_config') {
    const parsed = parsePayload(intent.action, intent.payload);
    const payload = parsed?.payload as SetConfigPayload;
    if (
      liveValue === undefined ||
      configValueDigest(liveValue as ConfigScalar) !==
        payload.expectedCurrentValueDigest
    )
      return fail(
        'target_version_mismatch',
        `the live value of ${intent.targetSourceKey} does not match expectedCurrentValueDigest`,
        rest,
      );
  }
  if (support) return fail(support.reason, support.detail, rest);
  return { ok: true, reason: null, detail: null, ...rest };
}
