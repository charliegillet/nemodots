// Expected admission/commit/dispatch outcomes for every TEST_PROMPT gate-2
// case (items 1-16) plus the reviewed findings that refine them (C2-C5,
// C10, C11, I2, I8). Derived from CONTRACTS 5 and ARCHITECTURE 4-6 only.
//
// Conventions:
// - Every case starts from SETUP_CONFIG (test-local values seeded by the
//   driver through the version authority, never the sandbox baseline) with
//   fresh member + health receipts registered for the cited keys.
// - `versionDelta` is the authority version change of a key over the whole
//   case; `actionRows` counts checkout.config_versions rows whose
//   caused_by_action_id is set; `authorizations` lists the expected
//   coordinator.authorizations rows for the labelled intent in order.
// - `anyOf` lists alternative acceptable outcomes where the contract allows
//   more than one fail-closed behaviour; every alternative is still strict.
import type {
  ActionStatus,
  BlockReason,
  ConfigKey,
  ConfigValue,
  FailureReason,
} from './spec-enums.js';

export const SETUP_CONFIG: Readonly<Record<ConfigKey, ConfigValue>> = {
  'cache.namespace': 'acc-ns-a',
  'cache.schema_version': 4,
  'db.pool_max': 2,
  'db.statement_timeout_ms': 80,
  'routing.inventory_source': 'replica_stale',
  'orders.write_enabled': false,
  'ui.banner_text': 'acceptance setup banner',
};

export type HookPoint =
  | 'after_preliminary_read'
  | 'before_lock'
  | 'after_lock_before_commit'
  | 'after_commit_before_dispatch'
  | 'after_effect_before_record';

export type AdmissionStep =
  | {
      do: 'propose';
      intent: string;
      action: 'set_config' | 'flush_cache_namespace' | 'unknown_kind';
      payload: Record<string, unknown>;
      /** Receipt labels cited: 'member:<key>', 'health', 'redis', 'foreign_mission_receipt'. */
      cites: string[];
      toolCallId: string;
      /** Role of the proposing attempt (default database_specialist / cache_specialist). */
      role?:
        | 'investigator'
        | 'database_specialist'
        | 'cache_specialist'
        | 'routing_specialist';
      /** Author lease state when proposing. */
      authorLease?: 'valid' | 'expired';
      /** Receipt inherited through the emitting snapshot but not in the readset. */
      inheritedOnly?: string[];
    }
  | { do: 'admit'; intent: string; dispatcher?: string }
  | { do: 'commit'; intent: string; dispatcher?: string }
  | {
      do: 'commit_concurrent';
      intent: string;
      callers: number;
      barrier: HookPoint;
    }
  | { do: 'dispatch'; intent: string; dispatcher?: string }
  | { do: 'reconcile'; intent: string }
  | {
      do: 'advance';
      key: string;
      value: ConfigValue;
      actor: 'injector' | 'owner';
      /** Register the new observation afterwards (watcher ran). */
      register: boolean;
    }
  | {
      /** Park the next production step at a barrier, run `during`, then resume. */
      do: 'hooked';
      point: HookPoint;
      step: AdmissionStep;
      during: AdmissionStep[];
    }
  | {
      /** A raw transaction (injector role) locks the target row first and holds it. */
      do: 'hold_row_lock_then_advance';
      key: string;
      value: ConfigValue;
      whileHeld: AdmissionStep[];
    }
  | { do: 'expire_dispatcher_lease'; intent: string }
  | { do: 'expire_author_lease' }
  | { do: 'complete_author_attempt' }
  | { do: 'reclaim'; intent: string; dispatcher: string }
  | { do: 'crash'; at: HookPoint | 'after_admission'; intent: string }
  | { do: 'drop_redis_reply'; intent: string }
  | { do: 'redis_unreachable_before_script'; intent: string }
  | { do: 'advance_redis_fence'; namespace: 'current'; by: number }
  | { do: 'mutate_redis_unobserved' }
  | {
      do: 'tamper_intent';
      intent: string;
      field:
        | 'payload_value'
        | 'dependency_vector_drop_target'
        | 'policy_version'
        | 'target_key';
      value?: ConfigValue | string;
    }
  | { do: 'age_health'; ageMs: number }
  | { do: 'confirm_health' }
  | { do: 'cancel_mission' }
  | { do: 'compensate'; intent: string; as: string }
  | { do: 'injector_forges_marker'; key: string; value: ConfigValue };

export interface IntentExpectation {
  status: ActionStatus;
  blockReason?: BlockReason;
  failureReason?: FailureReason;
  /** Expected Authorization rows (stage/decision/blockReason) in order. */
  authorizations?: {
    stage: 'admission' | 'commit' | 'dispatch';
    decision: 'admitted' | 'committed' | 'blocked' | 'dispatched';
    blockReason?: BlockReason;
  }[];
  /** The stored dependency vector must contain these source keys. */
  vectorContains?: string[];
  /** Listed in mission.cancellation.committedEffects. */
  inCommittedEffects?: boolean;
}

export interface AdmissionOutcome {
  intents: Record<string, IntentExpectation>;
  config: Partial<
    Record<string, { versionDelta: number; value: ConfigValue | 'unchanged' }>
  >;
  actionRows: number;
  resultReceipts?: number;
  /** Real Redis UNLINK effects on the namespace (counted by a wrapper/MONITOR). */
  redisEffects?: number;
  /** Errors thrown to callers, in step order (class or code names). */
  thrown?: string[];
  /** Concurrent callers all received the same ResultReceipt id. */
  sameReceiptForAllCallers?: boolean;
  /** The step that must finish without waiting on another key's lock (ms). */
  nonBlockingWithinMs?: number;
  /** Serialization order of writers to the target key, from config_versions. */
  serialization?: ('action' | 'injector' | 'owner')[];
  /** Rows of coordinator.action_intents for the case's idempotency key. */
  intentRowsForKey?: number;
  /** The configured value that must never appear. */
  neverValue?: { key: string; value: ConfigValue };
  /** Outside-the-guarantee documentation case (expected to pass through). */
  outsideGuarantee?: string;
}

export interface AdmissionCase {
  id: string;
  title: string;
  covers: string[];
  steps: AdmissionStep[];
  expected: AdmissionOutcome | { anyOf: AdmissionOutcome[] };
}

const POOL = 'db.pool_max';
const SET_POOL_12 = { key: POOL, value: 12 };
const CITE_POOL = ['member:db.pool_max', 'health'];
const proposePool = (intent = 'I', toolCallId = 'tc-1') =>
  ({
    do: 'propose',
    intent,
    action: 'set_config',
    payload: SET_POOL_12,
    cites: CITE_POOL,
    toolCallId,
  }) as const satisfies AdmissionStep;
const FLUSH = { namespace: 'acc-ns-a', reason: 'acceptance flush' };
const proposeFlush = (intent = 'F', toolCallId = 'tc-f') =>
  ({
    do: 'propose',
    intent,
    action: 'flush_cache_namespace',
    payload: FLUSH,
    cites: ['member:cache.namespace', 'redis'],
    toolCallId,
    role: 'cache_specialist',
  }) as const satisfies AdmissionStep;

const ADMITTED = { stage: 'admission', decision: 'admitted' } as const;
const COMMITTED = { stage: 'commit', decision: 'committed' } as const;

export const ADMISSION_CASES: readonly AdmissionCase[] = [
  {
    id: 'ADM-01',
    title: 'stale before admission (r2 registered)',
    covers: ['gate2.1'],
    steps: [
      proposePool(),
      { do: 'advance', key: POOL, value: 4, actor: 'injector', register: true },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_version',
          authorizations: [
            {
              stage: 'admission',
              decision: 'blocked',
              blockReason: 'stale_version',
            },
          ],
        },
      },
      config: { [POOL]: { versionDelta: 1, value: 4 } },
      actionRows: 0,
      resultReceipts: 0,
    },
  },
  {
    id: 'ADM-01b',
    title: 'stale before admission, replacement not yet observed',
    covers: ['gate2.1', 'gate1.13'],
    steps: [
      proposePool(),
      {
        do: 'advance',
        key: POOL,
        value: 4,
        actor: 'injector',
        register: false,
      },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_pending_observation',
          authorizations: [
            {
              stage: 'admission',
              decision: 'blocked',
              blockReason: 'stale_pending_observation',
            },
          ],
        },
      },
      config: { [POOL]: { versionDelta: 1, value: 4 } },
      actionRows: 0,
      resultReceipts: 0,
    },
  },
  {
    id: 'ADM-02',
    title: 'stale between preliminary read and commit lock',
    covers: ['gate2.2'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      {
        do: 'hooked',
        point: 'after_preliminary_read',
        step: { do: 'commit', intent: 'I' },
        during: [
          {
            do: 'advance',
            key: POOL,
            value: 4,
            actor: 'injector',
            register: true,
          },
        ],
      },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_version',
          authorizations: [
            ADMITTED,
            {
              stage: 'commit',
              decision: 'blocked',
              blockReason: 'stale_version',
            },
          ],
        },
      },
      config: { [POOL]: { versionDelta: 1, value: 4 } },
      actionRows: 0,
      resultReceipts: 0,
      serialization: ['injector'],
    },
  },
  {
    id: 'ADM-03a',
    title:
      'commit holds the lock first; the racing injector write serializes after and fails',
    covers: ['gate2.3'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      {
        do: 'hooked',
        point: 'after_lock_before_commit',
        step: { do: 'commit', intent: 'I' },
        during: [
          {
            do: 'advance',
            key: POOL,
            value: 4,
            actor: 'injector',
            register: false,
          },
        ],
      },
    ],
    expected: {
      intents: {
        I: { status: 'committed', authorizations: [ADMITTED, COMMITTED] },
      },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
      thrown: ['stale_version'],
      serialization: ['action'],
    },
  },
  {
    id: 'ADM-03b',
    title:
      'injector holds the lock first; the commit waits and then rejects r1',
    covers: ['gate2.3'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      {
        do: 'hold_row_lock_then_advance',
        key: POOL,
        value: 4,
        whileHeld: [{ do: 'commit', intent: 'I' }],
      },
    ],
    // acceptance-v2: the replacement is never registered in this case, so the
    // fail-closed code is stale_pending_observation (G3); v1 said stale_version.
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_pending_observation',
          authorizations: [
            ADMITTED,
            {
              stage: 'commit',
              decision: 'blocked',
              blockReason: 'stale_pending_observation',
            },
          ],
        },
      },
      config: { [POOL]: { versionDelta: 1, value: 4 } },
      actionRows: 0,
      resultReceipts: 0,
      serialization: ['injector'],
    },
  },
  {
    id: 'ADM-04',
    title: 'approved (admitted) r1, r2 registered, then the callback commits',
    covers: ['gate2.4'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      { do: 'advance', key: POOL, value: 4, actor: 'injector', register: true },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_version',
          authorizations: [
            ADMITTED,
            {
              stage: 'commit',
              decision: 'blocked',
              blockReason: 'stale_version',
            },
          ],
        },
      },
      config: { [POOL]: { versionDelta: 1, value: 4 } },
      actionRows: 0,
      resultReceipts: 0,
    },
  },
  {
    id: 'ADM-05a',
    title: 'reused idempotency key (same tool call) with a different payload',
    covers: ['gate2.5'],
    steps: [
      proposePool('I', 'tc-1'),
      {
        do: 'propose',
        intent: 'I_tampered',
        action: 'set_config',
        payload: { key: POOL, value: 13 },
        cites: CITE_POOL,
        toolCallId: 'tc-1',
      },
    ],
    expected: {
      intents: {
        I: { status: 'proposed' },
        I_tampered: { status: 'blocked', blockReason: 'idempotency_conflict' },
      },
      config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      neverValue: { key: POOL, value: 13 },
    },
  },
  {
    id: 'ADM-05b',
    title: 'same key and same payload returns the stored intent',
    covers: ['gate2.5', 'gate2.10'],
    steps: [proposePool('I', 'tc-1'), proposePool('I_again', 'tc-1')],
    expected: {
      intents: { I: { status: 'proposed' }, I_again: { status: 'proposed' } },
      config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      intentRowsForKey: 1,
    },
  },
  {
    id: 'ADM-05c',
    title: 'a new tool call may re-propose an identical payload after a block',
    covers: ['gate2.5'],
    steps: [
      proposePool('I', 'tc-1'),
      { do: 'advance', key: POOL, value: 4, actor: 'injector', register: true },
      { do: 'admit', intent: 'I' },
      proposePool('I2', 'tc-2'),
      { do: 'admit', intent: 'I2' },
      { do: 'commit', intent: 'I2' },
    ],
    expected: {
      intents: {
        I: { status: 'blocked', blockReason: 'stale_version' },
        I2: { status: 'committed', authorizations: [ADMITTED, COMMITTED] },
      },
      config: { [POOL]: { versionDelta: 2, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
    },
  },
  {
    id: 'ADM-05d',
    title: 'payload changed after admission requires fresh authorization',
    covers: ['gate2.5'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      { do: 'tamper_intent', intent: 'I', field: 'payload_value', value: 13 },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      anyOf: [
        {
          intents: { I: { status: 'admitted' } },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          thrown: ['immutable_intent'],
          neverValue: { key: POOL, value: 13 },
        },
        {
          intents: { I: { status: 'blocked', blockReason: 'payload_invalid' } },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          neverValue: { key: POOL, value: 13 },
        },
        {
          intents: {
            I: { status: 'blocked', blockReason: 'idempotency_conflict' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          neverValue: { key: POOL, value: 13 },
        },
      ],
    },
  },
  {
    id: 'ADM-05e',
    title: 'dependency vector, policy or target changed after admission',
    covers: ['gate2.5', 'gate2.6'],
    steps: [
      proposePool('I', 'tc-1'),
      { do: 'admit', intent: 'I' },
      {
        do: 'tamper_intent',
        intent: 'I',
        field: 'dependency_vector_drop_target',
      },
      { do: 'commit', intent: 'I' },
      proposePool('J', 'tc-2'),
      { do: 'admit', intent: 'J' },
      {
        do: 'tamper_intent',
        intent: 'J',
        field: 'policy_version',
        value: 'policy-v0',
      },
      { do: 'commit', intent: 'J' },
      proposePool('K', 'tc-3'),
      { do: 'admit', intent: 'K' },
      {
        do: 'tamper_intent',
        intent: 'K',
        field: 'target_key',
        value: 'db.statement_timeout_ms',
      },
      { do: 'commit', intent: 'K' },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I: { status: 'admitted' },
            J: { status: 'admitted' },
            K: { status: 'admitted' },
          },
          config: {
            [POOL]: { versionDelta: 0, value: 'unchanged' },
            'db.statement_timeout_ms': { versionDelta: 0, value: 'unchanged' },
          },
          actionRows: 0,
          thrown: ['immutable_intent', 'immutable_intent', 'immutable_intent'],
        },
        {
          intents: {
            I: { status: 'blocked', blockReason: 'missing_required_source' },
            J: { status: 'blocked', blockReason: 'policy_version_mismatch' },
            K: { status: 'blocked', blockReason: 'payload_invalid' },
          },
          config: {
            [POOL]: { versionDelta: 0, value: 'unchanged' },
            'db.statement_timeout_ms': { versionDelta: 0, value: 'unchanged' },
          },
          actionRows: 0,
        },
      ],
    },
  },
  {
    id: 'ADM-06a',
    title: 'required health omitted from citations',
    covers: ['gate2.6'],
    steps: [
      {
        do: 'propose',
        intent: 'I',
        action: 'set_config',
        payload: SET_POOL_12,
        cites: ['member:db.pool_max'],
        toolCallId: 'tc-1',
      },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I: {
              status: 'admitted',
              vectorContains: [
                'checkout.config/db.pool_max',
                'checkout.health',
              ],
            },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
        {
          intents: {
            I: { status: 'blocked', blockReason: 'missing_required_source' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
      ],
    },
  },
  {
    id: 'ADM-06b',
    title: 'only an irrelevant valid receipt cited',
    covers: ['gate2.6'],
    steps: [
      {
        do: 'propose',
        intent: 'I',
        action: 'set_config',
        payload: SET_POOL_12,
        cites: ['redis'],
        toolCallId: 'tc-1',
      },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I: {
              status: 'admitted',
              vectorContains: [
                'checkout.config/db.pool_max',
                'checkout.health',
              ],
            },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
        {
          intents: {
            I: { status: 'blocked', blockReason: 'missing_required_source' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
      ],
    },
  },
  {
    id: 'ADM-06c',
    title: 'out-of-domain value, unknown action kind, extra payload field',
    covers: ['gate2.6', 'gate3'],
    steps: [
      {
        do: 'propose',
        intent: 'I_domain',
        action: 'set_config',
        payload: { key: POOL, value: 50 },
        cites: CITE_POOL,
        toolCallId: 'tc-1',
      },
      {
        do: 'propose',
        intent: 'I_kind',
        action: 'unknown_kind',
        payload: { table: 'checkout.orders' },
        cites: CITE_POOL,
        toolCallId: 'tc-2',
      },
      {
        do: 'propose',
        intent: 'I_extra',
        action: 'set_config',
        payload: { key: POOL, value: 12, causedByActionId: 'forged' },
        cites: CITE_POOL,
        toolCallId: 'tc-3',
      },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I_domain: { status: 'blocked', blockReason: 'payload_invalid' },
            I_kind: { status: 'blocked', blockReason: 'payload_invalid' },
            I_extra: { status: 'blocked', blockReason: 'payload_invalid' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          neverValue: { key: POOL, value: 50 },
        },
        {
          intents: {},
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          thrown: ['payload_invalid', 'payload_invalid', 'payload_invalid'],
          neverValue: { key: POOL, value: 50 },
        },
      ],
    },
  },
  {
    id: 'ADM-06d',
    title: 'an investigator cannot propose (capability)',
    covers: ['gate2.6', 'gate4.2'],
    steps: [
      { ...proposePool(), role: 'investigator' },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I: { status: 'blocked', blockReason: 'capability_denied' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
        {
          intents: {},
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          thrown: ['capability_denied'],
        },
      ],
    },
  },
  {
    id: 'ADM-07',
    title:
      'cross-resource vector: a non-target cited source changes before commit',
    covers: ['gate2.7'],
    steps: [
      {
        do: 'propose',
        intent: 'I',
        action: 'set_config',
        payload: SET_POOL_12,
        cites: [
          'member:db.pool_max',
          'member:db.statement_timeout_ms',
          'health',
        ],
        toolCallId: 'tc-1',
      },
      { do: 'admit', intent: 'I' },
      {
        do: 'advance',
        key: 'db.statement_timeout_ms',
        value: 90,
        actor: 'injector',
        register: true,
      },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_version',
          authorizations: [
            ADMITTED,
            {
              stage: 'commit',
              decision: 'blocked',
              blockReason: 'stale_version',
            },
          ],
        },
      },
      config: {
        [POOL]: { versionDelta: 0, value: 'unchanged' },
        'db.statement_timeout_ms': { versionDelta: 1, value: 90 },
      },
      actionRows: 0,
    },
  },
  {
    id: 'ADM-07b',
    title:
      'inherited receipt in the emitting snapshot (not the readset) is in the vector',
    covers: ['gate2.7', 'gate1.6'],
    steps: [
      {
        do: 'propose',
        intent: 'I',
        action: 'set_config',
        payload: SET_POOL_12,
        cites: CITE_POOL,
        toolCallId: 'tc-1',
        inheritedOnly: ['member:routing.inventory_source'],
      },
      { do: 'admit', intent: 'I' },
      {
        do: 'advance',
        key: 'routing.inventory_source',
        value: 'primary',
        actor: 'injector',
        register: true,
      },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: {
          status: 'blocked',
          blockReason: 'stale_version',
          vectorContains: [
            'checkout.config/db.pool_max',
            'checkout.config/routing.inventory_source',
            'checkout.health',
          ],
        },
      },
      config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
    },
  },
  {
    id: 'ADM-08',
    // acceptance-v2: the v1 step (register IA's change, then park IA's commit at
    // after_lock_before_commit) could not be reached; IA is no longer blocked.
    title:
      'per-resource independence: a commit parked holding its rows never delays a commit on another key',
    covers: ['gate2.8'],
    steps: [
      {
        do: 'propose',
        intent: 'IA',
        action: 'set_config',
        payload: { key: 'routing.inventory_source', value: 'primary' },
        cites: ['member:routing.inventory_source', 'health'],
        toolCallId: 'tc-a',
        role: 'routing_specialist',
      },
      {
        do: 'propose',
        intent: 'IB',
        action: 'set_config',
        payload: { key: 'orders.write_enabled', value: true },
        cites: ['member:orders.write_enabled', 'health'],
        toolCallId: 'tc-b',
      },
      { do: 'admit', intent: 'IA' },
      { do: 'admit', intent: 'IB' },
      {
        do: 'hooked',
        point: 'after_lock_before_commit',
        step: { do: 'commit', intent: 'IA' },
        during: [{ do: 'commit', intent: 'IB' }],
      },
    ],
    expected: {
      intents: {
        IA: { status: 'committed', authorizations: [ADMITTED, COMMITTED] },
        IB: { status: 'committed', authorizations: [ADMITTED, COMMITTED] },
      },
      config: {
        'routing.inventory_source': { versionDelta: 1, value: 'primary' },
        'orders.write_enabled': { versionDelta: 1, value: true },
      },
      actionRows: 2,
      resultReceipts: 2,
      nonBlockingWithinMs: 2000,
    },
  },
  {
    id: 'ADM-09',
    title:
      'stale author fence cannot propose; stale dispatch fence cannot commit',
    covers: ['gate2.9'],
    steps: [
      { do: 'expire_author_lease' },
      { ...proposePool('I_stale_author', 'tc-1'), authorLease: 'expired' },
      proposePool('I', 'tc-2'),
      { do: 'admit', intent: 'I', dispatcher: 'd1' },
      { do: 'expire_dispatcher_lease', intent: 'I' },
      { do: 'commit', intent: 'I', dispatcher: 'd1' },
    ],
    expected: {
      intents: { I: { status: 'admitted', authorizations: [ADMITTED] } },
      config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      thrown: ['FenceError', 'DispatchFenceError'],
    },
  },
  {
    id: 'ADM-10',
    title:
      'duplicate delivery: two simultaneous identical commits, then a third',
    covers: ['gate2.10'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      {
        do: 'commit_concurrent',
        intent: 'I',
        callers: 2,
        barrier: 'before_lock',
      },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      intents: {
        I: { status: 'committed', authorizations: [ADMITTED, COMMITTED] },
      },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
      sameReceiptForAllCallers: true,
    },
  },
  {
    id: 'ADM-11a',
    title: 'crash after admission: lease expiry, re-claim, exactly one commit',
    covers: ['gate2.11', 'gate2.15'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I', dispatcher: 'd1' },
      { do: 'crash', at: 'after_admission', intent: 'I' },
      { do: 'expire_dispatcher_lease', intent: 'I' },
      { do: 'reclaim', intent: 'I', dispatcher: 'd2' },
      { do: 'commit', intent: 'I', dispatcher: 'd2' },
    ],
    expected: {
      intents: { I: { status: 'committed' } },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
    },
  },
  {
    id: 'ADM-11b',
    title:
      'crash before the commit lock: nothing written, intent still claimable',
    covers: ['gate2.11'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I', dispatcher: 'd1' },
      { do: 'crash', at: 'before_lock', intent: 'I' },
      { do: 'expire_dispatcher_lease', intent: 'I' },
      { do: 'reclaim', intent: 'I', dispatcher: 'd2' },
      { do: 'commit', intent: 'I', dispatcher: 'd2' },
    ],
    expected: {
      intents: { I: { status: 'committed' } },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
    },
  },
  {
    id: 'ADM-11c',
    title: 'crash after commit (set_config): no re-commit on recovery',
    covers: ['gate2.11'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      { do: 'crash', at: 'after_commit_before_dispatch', intent: 'I' },
      { do: 'commit', intent: 'I' },
    ],
    expected: {
      intents: { I: { status: 'committed' } },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
    },
  },
  {
    id: 'ADM-11d',
    title: 'flush: dispatcher crash after the Redis effect, second dispatcher',
    covers: ['gate2.11', 'gate2.12'],
    steps: [
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      { do: 'crash', at: 'after_effect_before_record', intent: 'F' },
      { do: 'dispatch', intent: 'F', dispatcher: 'd2' },
    ],
    expected: {
      intents: { F: { status: 'verified' } },
      config: { 'cache.namespace': { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      redisEffects: 1,
    },
  },
  {
    id: 'ADM-12a',
    title:
      'flush: Redis reply lost after a real effect -> outcome_unknown -> verified',
    covers: ['gate2.12'],
    steps: [
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      { do: 'drop_redis_reply', intent: 'F' },
      { do: 'reconcile', intent: 'F' },
    ],
    expected: {
      intents: { F: { status: 'verified' } },
      config: { 'cache.namespace': { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      redisEffects: 1,
    },
  },
  {
    id: 'ADM-12b',
    title:
      'flush: Redis unreachable before the script -> reconcile fails it, no retry',
    covers: ['gate2.12'],
    steps: [
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      { do: 'redis_unreachable_before_script', intent: 'F' },
      { do: 'reconcile', intent: 'F' },
    ],
    expected: {
      intents: { F: { status: 'failed', failureReason: 'effect_not_applied' } },
      config: { 'cache.namespace': { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      redisEffects: 0,
    },
  },
  {
    id: 'ADM-13',
    title: 'compensation respects a later valid change; flush is irreversible',
    covers: ['gate2.13'],
    steps: [
      proposePool(),
      { do: 'admit', intent: 'I' },
      { do: 'commit', intent: 'I' },
      { do: 'advance', key: POOL, value: 5, actor: 'owner', register: true },
      { do: 'compensate', intent: 'I', as: 'I_comp' },
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      { do: 'dispatch', intent: 'F' },
      { do: 'compensate', intent: 'F', as: 'F_comp' },
    ],
    expected: {
      intents: {
        I: { status: 'committed' },
        I_comp: { status: 'blocked', blockReason: 'stale_version' },
        F: { status: 'verified' },
      },
      config: { [POOL]: { versionDelta: 2, value: 5 } },
      actionRows: 1,
      redisEffects: 1,
      thrown: ['irreversible'],
    },
  },
  {
    id: 'ADM-14',
    title: 'cancellation stops queued work and lists committed effects',
    covers: ['gate2.14'],
    steps: [
      proposePool('P', 'tc-p'),
      {
        do: 'propose',
        intent: 'Q',
        action: 'set_config',
        payload: { key: 'orders.write_enabled', value: true },
        cites: ['member:orders.write_enabled', 'health'],
        toolCallId: 'tc-q',
      },
      {
        do: 'propose',
        intent: 'C',
        action: 'set_config',
        payload: { key: 'db.statement_timeout_ms', value: 2500 },
        cites: ['member:db.statement_timeout_ms', 'health'],
        toolCallId: 'tc-c',
      },
      { do: 'admit', intent: 'Q' },
      { do: 'admit', intent: 'C' },
      { do: 'commit', intent: 'C' },
      { do: 'cancel_mission' },
      { do: 'commit', intent: 'Q' },
    ],
    expected: {
      intents: {
        P: { status: 'cancelled' },
        Q: { status: 'cancelled' },
        C: { status: 'committed', inCommittedEffects: true },
      },
      config: {
        [POOL]: { versionDelta: 0, value: 'unchanged' },
        'orders.write_enabled': { versionDelta: 0, value: 'unchanged' },
        'db.statement_timeout_ms': { versionDelta: 1, value: 2500 },
      },
      actionRows: 1,
    },
  },
  {
    id: 'ADM-15',
    title:
      'separate lease lifecycles: completed author, expired dispatcher, re-claim',
    covers: ['gate2.15'],
    steps: [
      proposePool(),
      { do: 'complete_author_attempt' },
      { do: 'admit', intent: 'I', dispatcher: 'd1' },
      { do: 'expire_dispatcher_lease', intent: 'I' },
      { do: 'commit', intent: 'I', dispatcher: 'd1' },
      { do: 'reclaim', intent: 'I', dispatcher: 'd2' },
      { do: 'commit', intent: 'I', dispatcher: 'd2' },
    ],
    expected: {
      intents: { I: { status: 'committed' } },
      config: { [POOL]: { versionDelta: 1, value: 12 } },
      actionRows: 1,
      resultReceipts: 1,
      thrown: ['DispatchFenceError'],
    },
  },
  {
    id: 'ADM-16',
    title: 'the self-write marker cannot be forged by the injector',
    covers: ['gate2.16'],
    steps: [{ do: 'injector_forges_marker', key: POOL, value: 6 }],
    expected: {
      intents: {},
      config: { [POOL]: { versionDelta: 1, value: 6 } },
      actionRows: 0,
    },
  },
  {
    id: 'ADM-17',
    title: 'freshness: aged health blocks admission; a confirmation admits',
    covers: ['gate2.6', 'gate1.3'],
    steps: [
      proposePool('I', 'tc-1'),
      { do: 'age_health', ageMs: 121_000 },
      { do: 'admit', intent: 'I' },
      { do: 'confirm_health' },
      proposePool('I2', 'tc-2'),
      { do: 'admit', intent: 'I2' },
    ],
    expected: {
      intents: {
        I: { status: 'blocked', blockReason: 'evidence_too_old' },
        I2: { status: 'admitted' },
      },
      config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
    },
  },
  {
    id: 'ADM-18',
    title: 'a receipt id from another mission is a citation out of scope',
    covers: ['gate3', 'gate2.6'],
    steps: [
      {
        do: 'propose',
        intent: 'I',
        action: 'set_config',
        payload: SET_POOL_12,
        cites: ['foreign_mission_receipt', 'health'],
        toolCallId: 'tc-1',
      },
      { do: 'admit', intent: 'I' },
    ],
    expected: {
      anyOf: [
        {
          intents: {
            I: { status: 'blocked', blockReason: 'citation_out_of_scope' },
          },
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
        },
        {
          intents: {},
          config: { [POOL]: { versionDelta: 0, value: 'unchanged' } },
          actionRows: 0,
          thrown: ['citation_out_of_scope'],
        },
      ],
    },
  },
  {
    id: 'ADM-19a',
    title: 'flush: namespace authority advanced after commit, before dispatch',
    covers: ['gate2.12', 'gate2.9'],
    steps: [
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      {
        do: 'advance',
        key: 'cache.namespace',
        value: 'acc-ns-b',
        actor: 'injector',
        register: false,
      },
      { do: 'dispatch', intent: 'F' },
    ],
    expected: {
      intents: {
        F: { status: 'failed', failureReason: 'dispatch_fence_invalid' },
      },
      config: { 'cache.namespace': { versionDelta: 1, value: 'acc-ns-b' } },
      actionRows: 0,
      redisEffects: 0,
    },
  },
  {
    id: 'ADM-19b',
    title:
      'flush: Redis effect fence strictly newer than the committed version',
    covers: ['gate2.12', 'gate2.9'],
    steps: [
      proposeFlush(),
      { do: 'admit', intent: 'F' },
      { do: 'commit', intent: 'F' },
      { do: 'advance_redis_fence', namespace: 'current', by: 1 },
      { do: 'dispatch', intent: 'F' },
    ],
    expected: {
      intents: {
        F: { status: 'failed', failureReason: 'dispatch_fence_invalid' },
      },
      config: { 'cache.namespace': { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      redisEffects: 0,
    },
  },
  {
    id: 'ADM-20',
    title:
      'OUTSIDE THE GUARANTEE: unobserved Redis change within maxAge is admitted',
    covers: ['gate2.limits'],
    steps: [
      proposeFlush(),
      { do: 'mutate_redis_unobserved' },
      { do: 'admit', intent: 'F' },
    ],
    expected: {
      intents: { F: { status: 'admitted' } },
      config: { 'cache.namespace': { versionDelta: 0, value: 'unchanged' } },
      actionRows: 0,
      outsideGuarantee:
        'observed sources are freshness-at-admission only; an unobserved change inside maxAgeMs is not detected (ARCHITECTURE 4 limits)',
    },
  },
];

// Lease and fence outcomes (TEST_PROMPT gate 2 items 9, 15; ARCHITECTURE 6).
export interface LeaseCase {
  id: string;
  title: string;
  covers: string[];
  scenario: string;
  expected: {
    /** Errors each listed operation must throw. */
    throws: Record<string, string>;
    /** Rows that must not be written by the rejected operations. */
    rowsWritten: number;
    /** Extra facts. */
    facts?: Record<string, number | string | boolean>;
  };
}

export const LEASE_CASES: readonly LeaseCase[] = [
  {
    id: 'LS-1',
    title: 'two workers race to claim one runnable task',
    covers: ['gate2.9'],
    scenario: 'claim(task) from two connections behind a barrier',
    expected: {
      throws: { loser: 'claim_lost' },
      rowsWritten: 0,
      facts: { winners: 1, attemptsCreated: 1, fencingTokenIncrement: 1 },
    },
  },
  {
    id: 'LS-2',
    title: 'heartbeat with a stale token',
    covers: ['gate2.9'],
    scenario: 'renew(attempt, token - 1)',
    expected: { throws: { renew: 'FenceError' }, rowsWritten: 0 },
  },
  {
    id: 'LS-3',
    title: 'reaper takeover: every fenced write of the old worker fails',
    covers: ['gate2.9', 'gate4.5'],
    scenario:
      'expire lease, run reaper, then old worker calls publishOutput, delegate, publishFinding, recordModelCall, propose',
    expected: {
      throws: {
        publishOutput: 'FenceError',
        delegate: 'FenceError',
        publishFinding: 'FenceError',
        recordModelCall: 'FenceError',
        propose: 'FenceError',
      },
      rowsWritten: 0,
      facts: {
        oldAttemptStatus: 'expired',
        taskStatus: 'runnable',
        fenceSeqIncrement: 1,
        orphanedInferenceAttemptRows: 1,
        orphanedRowsHaveEdges: false,
      },
    },
  },
  {
    id: 'LS-4',
    title: 'renew after expiry',
    covers: ['gate2.9'],
    scenario: 'renew(attempt, token) after lease_expires_at <= now()',
    expected: { throws: { renew: 'FenceError' }, rowsWritten: 0 },
  },
  {
    id: 'LS-5',
    title:
      'expired dispatcher cannot admit or commit; re-claim fence is higher',
    covers: ['gate2.9', 'gate2.15'],
    scenario:
      'admit with d1, expire, commit with d1, reclaim with d2, commit with d2',
    expected: {
      throws: { commitD1: 'DispatchFenceError' },
      rowsWritten: 0,
      facts: {
        d2FenceGreaterThanD1: true,
        finalStatus: 'committed',
        actionRows: 1,
      },
    },
  },
  {
    id: 'LS-6',
    title: 'cancel waits for an in-flight publication then rejects the next',
    covers: ['gate2.14', 'gate2.9'],
    scenario:
      'publication holds mission FOR SHARE (barrier), cancel bumps generation, publication commits, next publication fails',
    expected: {
      throws: { nextPublication: 'FenceError' },
      rowsWritten: 0,
      facts: { firstPublicationCommitted: true, generationIncrement: 1 },
    },
  },
  {
    id: 'LS-7',
    title: 'fencing tokens strictly increase across takeovers',
    covers: ['gate2.9'],
    scenario: 'three successive claims of one task after two reaper takeovers',
    expected: {
      throws: {},
      rowsWritten: 0,
      facts: { strictlyIncreasing: true, claims: 3 },
    },
  },
];
