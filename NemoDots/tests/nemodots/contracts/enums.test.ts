import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';

// Expected enum members are read from docs/nemodots/CONTRACTS.md itself so the
// implementation cannot drift from the reviewed specification.
const doc = readFileSync(
  new URL('../../../docs/nemodots/CONTRACTS.md', import.meta.url),
  'utf8',
);

/** Members of `Name = 'a' | 'b' ...` (possibly continued over `|` lines). */
function docEnum(name: string): string[] {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm').exec(doc);
  if (!match) throw new Error(`enum ${name} not found in CONTRACTS.md`);
  const lines = [match[1]];
  const rest = doc
    .slice(match.index + match[0].length)
    .split('\n')
    .slice(1);
  for (const line of rest) {
    if (!/^\s*\|/.test(line)) break;
    lines.push(line);
  }
  const text = lines.map((line) => line.replace(/\/\/.*$/, '')).join(' ');
  return [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const named: [string, readonly string[]][] = [
  ['ReceiptStatus', C.ReceiptStatusSchema.options],
  ['TrustClass', C.TrustClassSchema.options],
  ['TransitionReason', C.TransitionReasonSchema.options],
  ['ModelRole', C.ModelRoleSchema.options],
  ['ContextLayout', C.ContextLayoutSchema.options],
  ['MissionStatus', C.MissionStatusSchema.options],
  ['TaskStatus', C.TaskStatusSchema.options],
  ['TaskRole', C.TaskRoleSchema.options],
  ['Capability', C.CapabilitySchema.options],
  ['AttemptStatus', C.AttemptStatusSchema.options],
  ['EdgeKind', C.EdgeKindSchema.options],
  ['ActionKind', C.ActionKindSchema.options],
  ['ActionStatus', C.ActionStatusSchema.options],
  ['BlockReason', C.BlockReasonSchema.options],
  ['FailureReason', C.FailureReasonSchema.options],
  ['PolicyVersion', [C.PolicyVersionSchema.value]],
  ['ConfigKey', C.ConfigKeySchema.options],
];

// Inline enums of CONTRACTS.md, transcribed from the field definitions.
const inline: [string, readonly string[], string[]][] = [
  ['Scope.environment', C.EnvironmentSchema.options, ['dev', 'test', 'eval']],
  [
    'SourceRef.sourceType',
    C.SourceTypeSchema.options,
    [
      'controlled_config',
      'controlled_collection',
      'observed_endpoint',
      'observed_store',
      'probe',
      'runbook',
      'page_snapshot',
      'memory_snapshot',
    ],
  ],
  [
    'provenance.kind',
    C.ProvenanceKindSchema.options,
    ['watcher', 'tool_call', 'probe', 'commit_postcondition', 'owner_edit'],
  ],
  ['selfWrite', C.SelfWriteSchema.options, ['none', 'verified', 'mismatch']],
  [
    'InferenceAttempt.finishReason',
    C.FinishReasonSchema.options,
    ['stop', 'tool_calls', 'length', 'content_filter', 'cancelled', 'error'],
  ],
  [
    'InferenceAttempt.error.class',
    C.InferenceErrorClassSchema.options,
    [
      'rate_limited',
      'provider_unavailable',
      'timeout',
      'provider_error',
      'network',
      'invalid_response',
      'cancelled',
    ],
  ],
  [
    'ModelCallRecord.outcome',
    C.ModelCallOutcomeSchema.options,
    ['completed', 'tool_calls', 'aborted', 'failed', 'invalid_output'],
  ],
  [
    'TaskAttempt.kind',
    C.AttemptKindSchema.options,
    ['initial', 'retry', 'repair', 'replan', 'postcondition'],
  ],
  [
    'TaskAttempt.abortReason',
    C.AbortReasonSchema.options,
    [
      'readset_invalidated',
      'mission_paused',
      'mission_cancelled',
      'lease_lost',
      'budget_exhausted',
      'provider_unreachable',
      'publication_rejected',
    ],
  ],
  [
    'TaskOutput.kind',
    C.TaskOutputKindSchema.options,
    ['finding', 'handoff', 'plan', 'verification'],
  ],
  [
    'adapter',
    C.ActionAdapterSchema.options,
    ['checkout_config', 'redis_cache'],
  ],
  [
    'Authorization.stage',
    C.AuthorizationStageSchema.options,
    ['admission', 'commit', 'dispatch'],
  ],
  [
    'Authorization.decision',
    C.AuthorizationDecisionSchema.options,
    ['admitted', 'committed', 'blocked', 'dispatched'],
  ],
  [
    'externalEffect.scriptResult',
    C.ScriptResultSchema.options,
    ['applied', 'already_applied', 'fence_newer'],
  ],
  [
    'InvalidationEvent.reason',
    C.InvalidationReasonSchema.options,
    [
      'newer_observation',
      'conflicting_observation',
      'retraction',
      'expiry',
      'self_write_mismatch',
      'collection_changed',
      'publication_rejected',
      'closure_cap_exceeded',
    ],
  ],
  [
    'RecoveryEvent.kind',
    C.RecoveryKindSchema.options,
    [
      'repair_scheduled',
      'replan_scheduled',
      'postcondition_scheduled',
      'intent_blocked',
      'attempt_aborted',
      'branch_preserved',
      'repair_coalesced',
      'replan_coalesced',
      'invalidation_resolved',
      'mission_paused_closure_cap',
    ],
  ],
  [
    'Finding.confidence',
    C.FindingConfidenceSchema.options,
    ['low', 'medium', 'high'],
  ],
];

describe('enums match CONTRACTS.md exactly', () => {
  it.each(named)('%s', (name, actual) => {
    const expected = docEnum(name);
    expect(expected.length).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each(inline)('%s', (_name, actual, expected) => {
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('rev2 members are present', () => {
    expect(C.BlockReasonSchema.options).toContain('evidence_too_old');
    expect(C.BlockReasonSchema.options).toContain('citation_out_of_scope');
    expect(C.RecoveryKindSchema.options).toContain('invalidation_resolved');
    expect(C.RecoveryKindSchema.options).toContain(
      'mission_paused_closure_cap',
    );
  });

  it('LIVE_STATUSES equals the documented list', () => {
    const match = /LIVE_STATUSES\s*=\s*\[([^\]]*)\]/.exec(doc);
    expect(match).not.toBeNull();
    const expected = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...C.LIVE_STATUSES]).toEqual(expected);
    for (const status of C.LIVE_STATUSES)
      expect(C.ActionStatusSchema.options).toContain(status);
    for (const closed of [
      'blocked',
      'failed',
      'cancelled',
      'verified',
    ] as const)
      expect(C.isLiveStatus(closed)).toBe(false);
  });

  it('EventKind covers every kind listed in CONTRACTS section 8 and nothing else', () => {
    const section = doc.slice(doc.indexOf('## 8.'), doc.indexOf('## 9.'));
    const expected = [...section.matchAll(/\|\s*\{\s*kind:\s*'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(expected.length).toBe(28);
    expect([...C.EventKindSchema.options].sort()).toEqual([...expected].sort());
  });

  it('ConfigKey value domains cover exactly the config keys', () => {
    expect(Object.keys(C.CONFIG_VALUE_DOMAINS).sort()).toEqual(
      [...C.ConfigKeySchema.options].sort(),
    );
  });
});
