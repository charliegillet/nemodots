// Receipt registration, supersession, freshness and staleness sequences
// (TEST_PROMPT gate 1 items 1-5, 10-13; ARCHITECTURE 5.2; CONTRACTS 2).
// Op indices in `outcomes` refer to positions in `ops`. Config values are
// test-local values seeded by the case itself, never the sandbox baseline.
import type { LedgerCase } from './types.js';

const HEALTH_OK = {
  status: 'ok',
  checks: { postgres: true, redis: true, config_parse: true, writes: true },
  errorClasses: [],
};
const HEALTH_DEGRADED = {
  status: 'degraded',
  checks: { postgres: true, redis: true, config_parse: true, writes: false },
  errorClasses: ['writes_disabled'],
};

export const LEDGER_CASES: readonly LedgerCase[] = [
  {
    id: 'LG-01',
    title: 'receipts are immutable for the app role',
    covers: ['gate1.1'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'tamper_update', label: 'r1', column: 'normalized_value' },
      { op: 'tamper_update', label: 'r1', column: 'content_digest' },
      { op: 'tamper_update', label: 'r1', column: 'source_revision' },
    ],
    expected: {
      outcomes: {
        1: { ok: true, relRevision: 0, newRevision: true },
        2: { ok: false, error: 'immutable' },
        3: { ok: false, error: 'immutable' },
        4: { ok: false, error: 'immutable' },
      },
      final: {
        receiptRowsBySource: { 'test:checkout.config/db.pool_max': 1 },
        receiptStatus: { r1: 'supported' },
      },
    },
  },
  {
    id: 'LG-02',
    title:
      'claimed revision or digest that disagrees with the authority is rejected',
    covers: ['gate1.1'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      {
        op: 'register',
        label: 'bad_rev',
        sourceKey: 'checkout.config/db.pool_max',
        claimRevision: 999,
      },
      {
        op: 'register',
        label: 'bad_digest',
        sourceKey: 'checkout.config/db.pool_max',
        claimDigestMismatch: true,
      },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
    ],
    expected: {
      outcomes: {
        1: { ok: false, error: 'revision_mismatch' },
        2: { ok: false, error: 'digest_mismatch' },
        3: { ok: true, relRevision: 0, newRevision: true },
      },
      final: { receiptRowsBySource: { 'test:checkout.config/db.pool_max': 1 } },
    },
  },
  {
    id: 'LG-03',
    title: 'oversized and malformed observations fail safely',
    covers: ['gate1.1'],
    ops: [
      {
        op: 'register',
        label: 'too_big',
        sourceKey: 'checkout.metrics',
        syntheticBytes: 16_385,
      },
      {
        op: 'register',
        label: 'at_limit',
        sourceKey: 'checkout.metrics',
        syntheticBytes: 16_384,
      },
      {
        op: 'register',
        label: 'bad_key',
        sourceKey: 'checkout.config/Bad Key',
      },
      { op: 'register', label: 'unknown_key', sourceKey: 'billing.ledger' },
      { op: 'register', label: 'traversal', sourceKey: 'runbook/../../.env' },
    ],
    expected: {
      outcomes: {
        0: { ok: false, error: 'too_large' },
        1: { ok: true, revision: 1, newRevision: true },
        2: { ok: false, error: 'invalid_source_key' },
        3: { ok: false, error: 'invalid_source_key' },
        4: { ok: false, error: 'invalid_source_key' },
      },
      final: { receiptRowsBySource: { 'test:checkout.metrics': 1 } },
    },
  },
  {
    id: 'LG-04',
    title: 'same key in two environments: two sources, independent revisions',
    covers: ['gate1.2'],
    ops: [
      {
        op: 'register',
        label: 'h_test_1',
        sourceKey: 'checkout.health',
        environment: 'test',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h_eval_1',
        sourceKey: 'checkout.health',
        environment: 'eval',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h_test_2',
        sourceKey: 'checkout.health',
        environment: 'test',
        normalizedValue: HEALTH_DEGRADED,
      },
    ],
    expected: {
      outcomes: {
        0: { ok: true, revision: 1, newRevision: true },
        1: { ok: true, revision: 1, newRevision: true },
        2: { ok: true, revision: 2, newRevision: true },
      },
      final: {
        distinctSources: 2,
        currentRevisionBySource: {
          'test:checkout.health': 2,
          'eval:checkout.health': 1,
        },
        receiptStatus: {
          h_test_1: 'superseded',
          h_eval_1: 'supported',
          h_test_2: 'supported',
        },
      },
    },
  },
  {
    id: 'LG-05',
    title: 'controlled supersession follows the authority version',
    covers: ['gate1.3'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'advance_config', key: 'db.pool_max', value: 5, actor: 'injector' },
      { op: 'register', label: 'r2', sourceKey: 'checkout.config/db.pool_max' },
    ],
    expected: {
      outcomes: {
        1: { ok: true, relRevision: 0, newRevision: true },
        2: { ok: true },
        3: { ok: true, relRevision: 1, newRevision: true },
      },
      final: {
        receiptStatus: { r1: 'superseded', r2: 'supported' },
        currentRelRevisionBySource: { 'test:checkout.config/db.pool_max': 1 },
        configVersionDelta: { 'db.pool_max': 1 },
        configValue: { 'db.pool_max': 5 },
      },
    },
  },
  {
    id: 'LG-06',
    title: 'late delivery of an old revision cannot resurrect it',
    covers: ['gate1.4'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'advance_config', key: 'db.pool_max', value: 6, actor: 'injector' },
      { op: 'register', label: 'r2', sourceKey: 'checkout.config/db.pool_max' },
      {
        op: 'register',
        label: 'late_r1',
        sourceKey: 'checkout.config/db.pool_max',
        claimRevision: 0,
      },
    ],
    expected: {
      outcomes: {
        1: { ok: true, relRevision: 0, newRevision: true },
        3: { ok: true, relRevision: 1, newRevision: true },
        4: { ok: false, error: 'stale_observation_rejected' },
      },
      final: {
        receiptStatus: { r1: 'superseded', r2: 'supported' },
        currentRelRevisionBySource: { 'test:checkout.config/db.pool_max': 1 },
        receiptRowsBySource: { 'test:checkout.config/db.pool_max': 2 },
      },
    },
  },
  {
    id: 'LG-07',
    title: 'ABA: A -> B -> A mints a third revision; old A stays non-current',
    covers: ['gate1.4'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      {
        op: 'register',
        label: 'rA1',
        sourceKey: 'checkout.config/db.pool_max',
      },
      { op: 'advance_config', key: 'db.pool_max', value: 7, actor: 'injector' },
      { op: 'register', label: 'rB', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'advance_config', key: 'db.pool_max', value: 3, actor: 'owner' },
      {
        op: 'register',
        label: 'rA2',
        sourceKey: 'checkout.config/db.pool_max',
      },
      { op: 'assert_current', labels: ['rA1'], lockMode: 'update' },
      { op: 'assert_current', labels: ['rA2'], lockMode: 'update' },
    ],
    expected: {
      outcomes: {
        1: { ok: true, relRevision: 0, newRevision: true },
        3: { ok: true, relRevision: 1, newRevision: true },
        5: { ok: true, relRevision: 2, newRevision: true },
        6: { ok: false, error: 'stale_version' },
        7: { ok: true },
      },
      final: {
        receiptStatus: {
          rA1: 'superseded',
          rB: 'superseded',
          rA2: 'supported',
        },
        receiptRowsBySource: { 'test:checkout.config/db.pool_max': 3 },
        configValue: { 'db.pool_max': 3 },
        configVersionDelta: { 'db.pool_max': 2 },
      },
    },
  },
  {
    id: 'LG-08',
    title: 'same-digest re-observation appends confirmations, mints nothing',
    covers: ['gate1.10'],
    ops: [
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
    ],
    expected: {
      outcomes: {
        0: { ok: true, revision: 1, newRevision: true },
        1: { ok: true, revision: 1, newRevision: false, confirmation: true },
        2: { ok: true, revision: 1, newRevision: false, confirmation: true },
        3: { ok: true, revision: 1, newRevision: false, confirmation: true },
        4: { ok: true, revision: 1, newRevision: false, confirmation: true },
        5: { ok: true, revision: 1, newRevision: false, confirmation: true },
      },
      final: {
        receiptRowsBySource: { 'test:checkout.health': 1 },
        confirmationsByLabel: { h1: 5 },
        receiptStatus: { h1: 'supported' },
      },
    },
  },
  {
    id: 'LG-09',
    title: 'freshness: an aged receipt fails, a confirmation restores it',
    covers: ['gate1.3', 'gate2.6'],
    ops: [
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      { op: 'age_receipt', label: 'h1', ageMs: 121_000 },
      {
        op: 'assert_current',
        labels: ['h1'],
        lockMode: 'share',
        freshness: { 'checkout.health': 120_000 },
      },
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'assert_current',
        labels: ['h1'],
        lockMode: 'share',
        freshness: { 'checkout.health': 120_000 },
      },
    ],
    expected: {
      outcomes: {
        0: { ok: true, revision: 1, newRevision: true },
        2: { ok: false, error: 'evidence_too_old' },
        3: { ok: true, revision: 1, newRevision: false, confirmation: true },
        4: { ok: true },
      },
      final: { receiptRowsBySource: { 'test:checkout.health': 1 } },
    },
  },
  {
    id: 'LG-10',
    title: 'observed digest change mints exactly one new revision',
    covers: ['gate1.3'],
    ops: [
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'h2',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_DEGRADED,
      },
    ],
    expected: {
      outcomes: {
        0: { ok: true, revision: 1, newRevision: true },
        1: { ok: true, revision: 2, newRevision: true },
      },
      final: {
        receiptStatus: { h1: 'superseded', h2: 'supported' },
        currentRevisionBySource: { 'test:checkout.health': 2 },
      },
    },
  },
  {
    id: 'LG-11',
    title: 'two concurrent registrations of the same new digest: one revision',
    covers: ['gate1.3', 'gate1.4'],
    ops: [
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register_concurrent',
        labels: ['hx', 'hy'],
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_DEGRADED,
      },
    ],
    expected: {
      outcomes: {
        0: { ok: true, revision: 1, newRevision: true },
        1: { ok: true, revision: 2 },
      },
      final: {
        receiptRowsBySource: { 'test:checkout.health': 2 },
        currentRevisionBySource: { 'test:checkout.health': 2 },
        confirmationsByLabel: { hx: 1 },
      },
    },
  },
  {
    id: 'LG-12',
    title: 'contested, retracted and expired receipts do not support',
    covers: ['gate1.3'],
    ops: [
      {
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      },
      {
        op: 'register',
        label: 'm1',
        sourceKey: 'checkout.metrics',
        normalizedValue: {
          errorClasses: [],
          cacheHitDecile: 9,
          errorRateDecile: 0,
        },
      },
      {
        op: 'register',
        label: 's1',
        sourceKey: 'redis.stats',
        normalizedValue: { reachable: true, keysBySuffix: { 'acc-ns:v4': 12 } },
      },
      { op: 'transition', label: 'h1', to: 'contested' },
      { op: 'transition', label: 'm1', to: 'retracted' },
      { op: 'transition', label: 's1', to: 'expired' },
      { op: 'assert_current', labels: ['h1'], lockMode: 'share' },
      { op: 'assert_current', labels: ['m1'], lockMode: 'share' },
      { op: 'assert_current', labels: ['s1'], lockMode: 'share' },
    ],
    expected: {
      outcomes: {
        6: { ok: false, error: 'receipt_not_supported' },
        7: { ok: false, error: 'receipt_not_supported' },
        8: { ok: false, error: 'receipt_not_supported' },
      },
      final: {
        receiptStatus: { h1: 'contested', m1: 'retracted', s1: 'expired' },
      },
    },
  },
  {
    id: 'LG-13',
    title: 'model claims never mint observation receipts',
    covers: ['gate1.5'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'publish_finding', label: 'f1', citing: ['r1'] },
    ],
    expected: {
      outcomes: { 1: { ok: true, relRevision: 0 }, 2: { ok: true } },
      final: { newObservationReceipts: 1, modelClaimFindings: 1 },
    },
  },
  {
    id: 'LG-14',
    title: 'page edit changes page revision only, never ledger values',
    covers: ['gate1.11'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'page_edit', pageId: 'p1' },
    ],
    expected: {
      outcomes: { 2: { ok: true } },
      final: {
        receiptStatus: { r1: 'supported' },
        configVersionDelta: { 'db.pool_max': 0 },
        configValue: { 'db.pool_max': 3 },
        newObservationReceipts: 1,
      },
    },
  },
  {
    id: 'LG-15',
    title:
      'authority advanced before the watcher: old receipt fails immediately',
    covers: ['gate1.13'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      { op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' },
      { op: 'advance_config', key: 'db.pool_max', value: 9, actor: 'injector' },
      { op: 'assert_current', labels: ['r1'], lockMode: 'share' },
      { op: 'assert_current', labels: ['r1'], lockMode: 'update' },
    ],
    expected: {
      outcomes: {
        3: { ok: false, error: 'stale_pending_observation' },
        4: { ok: false, error: 'stale_pending_observation' },
      },
      final: {
        receiptStatus: { r1: 'supported' },
        configVersionDelta: { 'db.pool_max': 1 },
      },
    },
  },
  {
    id: 'LG-16',
    title:
      'membership collection: value update keeps it, insert and delete bump it',
    covers: ['gate1.12', 'gate1.10'],
    ops: [
      { op: 'seed_config', key: 'db.pool_max', value: 3 },
      {
        op: 'seed_config',
        key: 'ui.banner_text',
        value: 'acceptance banner one',
      },
      { op: 'register', label: 'c1', sourceKey: 'checkout.config' },
      {
        op: 'advance_config',
        key: 'ui.banner_text',
        value: 'acceptance banner two',
        actor: 'owner',
      },
      { op: 'assert_current', labels: ['c1'], lockMode: 'share' },
      {
        op: 'advance_config',
        key: 'checkout.restrict_orders',
        value: true,
        actor: 'injector',
        insertIfMissing: true,
      },
      { op: 'assert_current', labels: ['c1'], lockMode: 'share' },
      { op: 'register', label: 'c2', sourceKey: 'checkout.config' },
      { op: 'assert_current', labels: ['c1'], lockMode: 'update' },
      {
        op: 'advance_config',
        key: 'checkout.restrict_orders',
        value: true,
        actor: 'injector',
        deleteKey: true,
      },
      { op: 'register', label: 'c3', sourceKey: 'checkout.config' },
    ],
    expected: {
      outcomes: {
        2: { ok: true, relRevision: 0, newRevision: true },
        4: { ok: true },
        6: { ok: false, error: 'stale_pending_observation' },
        7: { ok: true, relRevision: 1, newRevision: true },
        8: { ok: false, error: 'stale_version' },
        10: { ok: true, relRevision: 2, newRevision: true },
      },
      final: {
        receiptStatus: { c1: 'superseded', c2: 'superseded', c3: 'supported' },
        receiptRowsBySource: { 'test:checkout.config': 3 },
      },
    },
  },
];
