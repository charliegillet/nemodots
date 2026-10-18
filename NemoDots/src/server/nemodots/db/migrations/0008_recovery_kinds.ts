// 0008_recovery_kinds: coordinator.recovery_events.kind gains `replan_coalesced`
// (CONTRACTS.md section 1, revision 3 "replan coalescing"). 0003 generated this
// CHECK from the contract enum at migration time, so a database migrated
// before the enum grew rejects the new kind. The CHECK is recreated with an
// EXPLICIT literal list (a migration must not depend on the current enum), so
// the next change is another migration, not a silent drift.
//
// Audit of the other enum-derived CHECKs (coordinator and ledger) against the
// contract enums in the same revision: recovery_events.kind is the only one
// that differs. The remaining non-identical CHECKs are deliberate subsets or
// structural (receipt_confirmations.provenance_kind lists the three
// confirmation kinds; sources_authority_matches_type, the capability/role
// check, scheduling-edge and span/phase checks are not enum copies).
// Depends on 0003 only.
import type { Migration } from '../migrate.js';

const KINDS = [
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
];

const migration: Migration = {
  id: '0008_recovery_kinds',
  async up(client) {
    await client.query(
      'ALTER TABLE coordinator.recovery_events DROP CONSTRAINT recovery_events_kind_check',
    );
    await client.query(
      `ALTER TABLE coordinator.recovery_events ADD CONSTRAINT recovery_events_kind_check
         CHECK (kind IN (${KINDS.map((kind) => `'${kind}'`).join(', ')}))`,
    );
  },
};

export default migration;
