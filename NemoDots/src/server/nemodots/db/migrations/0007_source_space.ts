// 0007_source_space (CONTRACTS.md section 1, "Revision 3", verifier finding
// F4b): the identity of a source includes its Space. Sources registered before
// this migration have no Space (null), which is one value for uniqueness
// (NULLS NOT DISTINCT), so existing rows keep their identity. 0002 is already
// applied on dev and is not edited. Depends on 0002 only.
import type { Migration } from '../migrate.js';

const migration: Migration = {
  id: '0007_source_space',
  async up(client) {
    await client.query('ALTER TABLE ledger.sources ADD COLUMN space_id text');
    await client.query(
      "ALTER TABLE ledger.sources ADD CONSTRAINT sources_space_not_empty CHECK (space_id IS NULL OR space_id <> '')",
    );
    await client.query(
      'ALTER TABLE ledger.sources DROP CONSTRAINT sources_identity',
    );
    await client.query(
      `ALTER TABLE ledger.sources ADD CONSTRAINT sources_identity
         UNIQUE NULLS NOT DISTINCT (owner_id, environment, space_id, resource, key)`,
    );
  },
};

export default migration;
