// 0009_recovery_scope_rule: coordinator.missions.recovery_scope_rule records
// which recovery scope rule the mission ran under (finding D8). NULL is the
// default selective closure; an evaluation arm that plugs in another rule
// (broad restart, dependent-task restart) is stamped at mission creation so a
// report can label every trial. Depends on 0003 only.
import type { Migration } from '../migrate.js';

const migration: Migration = {
  id: '0009_recovery_scope_rule',
  async up(client) {
    await client.query(
      'ALTER TABLE coordinator.missions ADD COLUMN recovery_scope_rule text',
    );
    await client.query(
      `ALTER TABLE coordinator.missions ADD CONSTRAINT missions_recovery_scope_rule_name
         CHECK (recovery_scope_rule IS NULL OR recovery_scope_rule ~ '^[a-z][a-z0-9_-]{0,40}$')`,
    );
  },
};

export default migration;
