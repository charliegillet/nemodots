// 0010_recovery_scope_default: coordinator.missions.recovery_scope_rule is
// NOT NULL with the default 'selective' (CONTRACTS.md section 1, revision 3
// "recovery scope rule"). 0009 added the column nullable; existing rows are
// selective by definition. Depends on 0009.
import type { Migration } from '../migrate.js';

const migration: Migration = {
  id: '0010_recovery_scope_default',
  async up(client) {
    await client.query(
      "UPDATE coordinator.missions SET recovery_scope_rule = 'selective' WHERE recovery_scope_rule IS NULL",
    );
    await client.query(
      "ALTER TABLE coordinator.missions ALTER COLUMN recovery_scope_rule SET DEFAULT 'selective'",
    );
    await client.query(
      'ALTER TABLE coordinator.missions ALTER COLUMN recovery_scope_rule SET NOT NULL',
    );
  },
};

export default migration;
