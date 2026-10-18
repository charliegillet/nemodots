// Migration 0002: CHECK constraints equal the contract enums, uniqueness keys,
// grants per role, and the default (production) schema names of the authority.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ContextLayoutSchema,
  EdgeKindSchema,
  EnvironmentSchema,
  FinishReasonSchema,
  InferenceErrorClassSchema,
  InvalidationReasonSchema,
  ModelCallOutcomeSchema,
  ModelRoleSchema,
  ProviderModeSchema,
  ProvenanceKindSchema,
  ReceiptStatusSchema,
  ReceiptTrustClassSchema,
  SelfWriteSchema,
  SourceAuthoritySchema,
  SourceTypeSchema,
  TransitionReasonSchema,
} from '../../../../src/server/nemodots/contracts/index.js';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { useLedgerDb } from './fixtures.js';

const getDb = useLedgerDb();

/** table.column -> literal set of its IN-list CHECK constraint (multi-column checks are skipped). */
async function enumChecks(admin: pg.Pool) {
  const { rows } = await admin.query<{ table_name: string; def: string }>(
    `SELECT c.conrelid::regclass::text AS table_name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.contype = 'c' AND c.connamespace = 'ledger'::regnamespace
        AND c.conname <> 'sources_authority_matches_type'`,
  );
  const result = new Map<string, string[]>();
  for (const { table_name, def } of rows) {
    const list = /ARRAY\[(.*?)\]/s.exec(def);
    const column = /^CHECK \(+"?([a-z_]+)"?/.exec(def);
    if (!list || !column) continue;
    const literals = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    result.set(
      `${table_name.replace('ledger.', '')}.${column[1]}`,
      literals.sort(),
    );
  }
  return result;
}

describe('CHECK constraints equal the contract enums', () => {
  it.each([
    ['sources.environment', EnvironmentSchema.options],
    ['sources.source_type', SourceTypeSchema.options],
    ['sources.authority', SourceAuthoritySchema.options],
    ['observation_receipts.status', ReceiptStatusSchema.options],
    ['observation_receipts.trust', ReceiptTrustClassSchema.options],
    ['observation_receipts.provenance_kind', ProvenanceKindSchema.options],
    ['observation_receipts.self_write', SelfWriteSchema.options],
    ['receipt_transitions.from_status', ReceiptStatusSchema.options],
    ['receipt_transitions.to_status', ReceiptStatusSchema.options],
    ['receipt_transitions.reason', TransitionReasonSchema.options],
    [
      'receipt_confirmations.provenance_kind',
      ['watcher', 'tool_call', 'probe'],
    ],
    ['context_snapshots.layout', ContextLayoutSchema.options],
    ['model_call_records.role', ModelRoleSchema.options],
    ['model_call_records.provider_mode', ProviderModeSchema.options],
    ['model_call_records.outcome', ModelCallOutcomeSchema.options],
    ['inference_attempts.role', ModelRoleSchema.options],
    ['inference_attempts.provider_mode', ProviderModeSchema.options],
    ['inference_attempts.finish_reason', FinishReasonSchema.options],
    ['inference_attempts.error_class', InferenceErrorClassSchema.options],
    ['inference_attempts.outcome', ['recorded', 'orphaned_fence']],
    ['dependency_edges.kind', EdgeKindSchema.options],
    ['invalidation_events.reason', InvalidationReasonSchema.options],
    ['invalidation_events.self_write', SelfWriteSchema.options],
  ])('%s', async (name, values) => {
    const checks = await enumChecks(getDb().admin);
    expect(checks.get(name), `no CHECK found for ${name}`).toEqual(
      [...values].sort(),
    );
  });

  it('node and edge kinds cover the dependency endpoints (receipts are never an edge target)', async () => {
    const checks = await enumChecks(getDb().admin);
    expect(checks.get('dependency_nodes.kind')).toEqual([
      'action_intent',
      'attempt',
      'model_call',
      'receipt',
      'task',
      'task_output',
    ]);
    expect(checks.get('dependency_edges.to_kind')).not.toContain('receipt');
    expect(checks.get('dependency_edges.from_kind')).toContain('receipt');
  });

  it('the database refuses values outside the enums', async () => {
    const { admin } = getDb();
    await expect(
      admin.query(
        `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
         VALUES (gen_random_uuid(), 'o', 'prod', 'checkout', 'checkout.health', 'observed_endpoint', 'observed')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      admin.query(
        `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
         VALUES (gen_random_uuid(), 'o', 'test', 'checkout', 'checkout.config', 'controlled_collection', 'observed')`,
      ),
    ).rejects.toThrow(/sources_authority_matches_type/);
    await expect(
      admin.query(
        `INSERT INTO ledger.dependency_nodes (kind, id, mission_id) VALUES ('receipt', gen_random_uuid(), gen_random_uuid())`,
      ),
    ).rejects.toThrow(/dependency_nodes_receipts_are_shared/);
  });
});

describe('uniqueness keys', () => {
  it('sources are unique on (owner, environment, space, resource, key) and revisions on (source, revision)', async () => {
    const { admin } = getDb();
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'u' AND connamespace = 'ledger'::regnamespace`,
    );
    const defs = rows.map((row) => row.def);
    expect(defs).toContain(
      'UNIQUE NULLS NOT DISTINCT (owner_id, environment, space_id, resource, key)',
    );
    expect(defs).toContain('UNIQUE (source_id, source_revision)');
    const primary = await admin.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'p' AND conrelid = 'ledger.source_revisions'::regclass`,
    );
    expect(primary.rows[0].def).toBe(
      'PRIMARY KEY (source_id, source_revision)',
    );
    await admin.query(
      `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
       VALUES ('00000000-0000-4000-8000-000000000001', 'dup', 'test', 'checkout', 'checkout.health', 'observed_endpoint', 'observed')`,
    );
    await expect(
      admin.query(
        `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
         VALUES ('00000000-0000-4000-8000-000000000002', 'dup', 'test', 'checkout', 'checkout.health', 'observed_endpoint', 'observed')`,
      ),
    ).rejects.toThrow(/sources_identity/);
  });
});

describe('roles', () => {
  it('the verifier reads the ledger but cannot write it; the checkout role cannot see it', async () => {
    const { db } = getDb();
    const verifier = new pg.Client({ connectionString: db.urls.verifier });
    const checkout = new pg.Client({ connectionString: db.urls.checkout });
    await verifier.connect();
    await checkout.connect();
    try {
      await expect(
        verifier.query('SELECT count(*) FROM ledger.observation_receipts'),
      ).resolves.toBeDefined();
      await expect(
        verifier.query('SELECT count(*) FROM ledger.invalidation_events'),
      ).resolves.toBeDefined();
      await expect(
        verifier.query(
          `INSERT INTO ledger.dependency_nodes (kind, id) VALUES ('receipt', gen_random_uuid())`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        checkout.query('SELECT 1 FROM ledger.sources'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await verifier.end();
      await checkout.end();
    }
  });

  it('migration 0002 is recorded and a second run applies nothing', async () => {
    const { db, admin } = getDb();
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    expect(rows.map((row) => row.id)).toContain('0002_ledger');
    const second = await migrate({ connectionString: db.urls.admin });
    expect(second.applied).toEqual([]);
    expect(second.pending).toEqual([]);
  });
});
