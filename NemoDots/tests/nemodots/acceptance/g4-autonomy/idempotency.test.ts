// TEST_PROMPT gate 4 / gate 8 mutation `accept_duplicate_differing_payloads`
// at application level. CONTRACTS section 5: an idempotency key is
// sha256(missionId, taskId, attemptId, action, expectedTargetVersion,
// toolCallId); the same key with a different payloadHash must end
// blocked(idempotency_conflict) with an authorization whose idempotencyBinding
// is 'conflict'. The scripted model replays one tool call id (call_replay_1)
// on two consecutive turns with different values. The mapped gate-2 catchers
// (ADM-05a/d) remain the primary proof; this proves the binding survives the
// real tool loop.
//
// Hand-enumerated expectation: of the two intents carrying call_replay_1 the
// first (value A) stays live and commits once; the second (value B) is blocked
// with idempotency_conflict; the stored value is A and never B; at most one
// config_versions row caused by an action exists.
import { describe, expect, it } from 'vitest';
import { ofKind } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import {
  alternateValue,
  distinctSchemaVersion,
  finish,
  launchMission,
  lazySystem,
} from './flow.js';
import type { ProviderCall, ProviderReply } from './provider.js';
import {
  ALPHA,
  BRAVO,
  BRAVO_SOURCE,
  CHARLIE,
  ALPHA_SOURCE,
  compose,
  observeCall,
  observeThenReport,
  planReply,
  receiptIdAt,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import { SPEC_LIVE_OR_DONE, specDigest } from './spec.js';
import { committedActionRows, readConfig } from './system.js';

const REPLAY_ID = 'call_replay_1';
const values = { a: 0 as number, b: 0 as number, digest: '0'.repeat(64) };

function replayer(call: ProviderCall): ProviderReply | null {
  if (!call.text.includes(ALPHA) || call.text.includes(CHARLIE)) return null;
  const n = call.toolResults;
  if (n === 0) return observeCall(ALPHA_SOURCE);
  if (n === 1) return observeCall('checkout.health');
  if (n === 2 || n === 3) {
    return {
      type: 'tool_calls',
      calls: [
        {
          id: REPLAY_ID,
          name: 'propose_action',
          args: {
            action: 'set_config',
            payload: {
              key: 'cache.schema_version',
              value: n === 2 ? values.a : values.b,
              expectedCurrentValueDigest: values.digest,
            },
            supportingReceiptIds: [
              receiptIdAt(call, 0),
              receiptIdAt(call, 1),
            ].filter((id): id is string => Boolean(id)),
            rationale: `${ALPHA} proposes a schema version (turn ${n - 1}).`,
          },
        },
      ],
    };
  }
  return { type: 'content', text: `${ALPHA} complete.` };
}

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    replayer,
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
  ),
  system: { env: { NEMODOTS_LEASE_MS: '20000' } },
});

describe('G4.9 payload binding survives the tool loop', () => {
  it('G4.9a a replayed tool call id with a different payload is blocked(idempotency_conflict) and at most one effect occurs', async () => {
    const { system: sys } = await system();
    const before = await readConfig(sys, 'cache.schema_version');
    values.a = alternateValue('cache.schema_version', before.value) as number;
    values.b = distinctSchemaVersion([before.value, values.a]);
    values.digest = specDigest(before.value);
    const { mission, tail } = await launchMission(sys.api, {
      admissionMinAgeMs: 6_000,
    });
    try {
      const snapshot = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.actions.filter((a) => a.toolCallId === REPLAY_ID).length >= 2 &&
          s.actions.every((a) =>
            ['verified', 'blocked', 'failed', 'cancelled'].includes(a.status),
          ),
        180_000,
        'both replayed intents settle',
      );
      const intents = snapshot.actions.filter(
        (a) => a.toolCallId === REPLAY_ID,
      );
      expect(
        intents,
        'two intents carry the replayed tool call id',
      ).toHaveLength(2);
      const payloadValue = (a: (typeof intents)[number]) =>
        (a.payload as { value?: unknown }).value;
      const live = intents.filter((a) =>
        (SPEC_LIVE_OR_DONE as readonly string[]).includes(a.status),
      );
      const blocked = intents.filter((a) => a.status === 'blocked');
      expect(live, 'exactly one intent stays live').toHaveLength(1);
      expect(blocked, 'the other is blocked').toHaveLength(1);
      expect(payloadValue(live[0]), 'the first payload won').toBe(values.a);
      expect(payloadValue(blocked[0])).toBe(values.b);
      expect(blocked[0].blockReason).toBe('idempotency_conflict');
      expect(
        snapshot.authorizations.filter(
          (a) =>
            a.actionId === blocked[0].id &&
            a.decision === 'blocked' &&
            a.idempotencyBinding === 'conflict',
        ).length,
        "the blocking authorization records idempotencyBinding 'conflict'",
      ).toBeGreaterThanOrEqual(1);
      const decided = ofKind(tail.events, 'action.decided').filter(
        (e) => e.payload.actionId === blocked[0].id,
      );
      expect(
        decided.some((e) => e.payload.blockReason === 'idempotency_conflict'),
      ).toBe(true);

      // effects: at most one, and never the conflicting value
      const rows = await committedActionRows(sys);
      expect(rows.length, 'at most one effect').toBeLessThanOrEqual(1);
      expect(
        rows.filter((r) => r.caused_by_action_id === blocked[0].id),
        'nothing was committed for the conflicting payload',
      ).toHaveLength(0);
      const liveValue = await readConfig(sys, 'cache.schema_version');
      expect(
        liveValue.value,
        'the conflicting value never reaches the authority',
      ).not.toBe(values.b);
      expect(
        live[0].status,
        'the first, admissible proposal committed and verified',
      ).toBe('verified');
      expect(rows).toHaveLength(1);
      expect(liveValue.value).toBe(values.a);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 420_000);
});
