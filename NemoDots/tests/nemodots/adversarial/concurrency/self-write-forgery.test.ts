// Self-write marker forgery through every input surface.
// Expected (ARCHITECTURE 5.4, 14 I14): the marker `caused_by_action_id` is
// server-authored inside the commit transaction by the application role. Tool
// inputs have no field for it (propose_action is strict); the BEFORE
// INSERT/UPDATE triggers on config_entries and config_versions null it unless
// current_user = 'nemodots_app', which blocks the injector, checkout, verifier
// and admin roles; the watcher classifies from the history and never reads the
// actor column. A forged write therefore classifies as selfWrite 'none' (full
// invalidation) and never settles an intent.
//
// Surfaces covered: injector DML (config_entries UPDATE/INSERT, config_versions
// INSERT), admin DML, verifier and checkout roles, role / session
// authorization switching, replication-role trigger bypass, DDL against the
// trigger, the propose_action tool schema and payload, every other strict tool
// schema, the scenario manifest, the owner-edit input, and the actor column.
// Residuals are stated as such (admin owns the triggers; the ledger stores a
// caller-supplied selfWrite as given).
import { describe, expect, it } from 'vitest';
import { loadScenario, ScenarioManifestSchema } from '../../../../src/server/nemodots/sandbox/manifest.js';
import { TEAM_TOOL_INPUTS } from '../../../../src/server/nemodots/contracts/tools.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import { createOwnerEdit } from '../../../../src/server/nemodots/watcher/index.js';
import {
  admitAndCommit,
  configState,
  createAttempt,
  historyRows,
  intentStatus,
  memberReceipt,
  proposePool,
  proposeCtx,
  scenario,
  sourceRef,
  watcherRig,
  withWorld,
  type World,
} from './harness.js';

const KEY = 'checkout.config/db.pool_max';

/** A committed (unsettled) action, to be the id every forgery tries to borrow. */
async function committedAction(world: World) {
  const s = await scenario(world);
  const intent = await proposePool(world, s, 20);
  const { committed } = await admitAndCommit(world, intent.id);
  expect(committed.status).toBe('committed');
  return { s, intent };
}

const FORGED_UPDATE = `UPDATE checkout.config_entries
    SET value = '15'::jsonb, version = version + 1, caused_by_action_id = $1
  WHERE key = 'db.pool_max'`;
const FORGED_HISTORY = `INSERT INTO checkout.config_versions
    (key, version, value, before_digest, after_digest, caused_by_action_id, caused_by_actor)
  VALUES ('db.pool_max', $2, '15'::jsonb, NULL, $3, $1, 'action')`;

describe('self-write marker forgery: database roles', () => {
  it('injector: a forged caused_by_action_id on UPDATE and on the history row is nulled; the watcher sees a foreign write', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world); // db.pool_max v2 by the action
      await withTransaction(world.injector, async (client) => {
        await client.query(FORGED_UPDATE, [intent.id]);
        await client.query(FORGED_HISTORY, [intent.id, 3, 'a'.repeat(64)]);
      });
      const head = await configState(world, 'db.pool_max');
      expect(head.version).toBe(3);
      expect(head.causedBy).toBeNull();
      const rows = await historyRows(world, 'db.pool_max');
      expect(rows.find((r) => r.version === 3)?.caused_by_action_id).toBeNull();
      expect(rows.find((r) => r.version === 2)?.caused_by_action_id).toBe(intent.id);

      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', selfWrite: 'none' });
      const { rows: receipts } = await world.admin.query(
        `SELECT r.self_write, r.caused_by_action_id FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1 AND r.source_revision = 3`,
        [KEY],
      );
      expect(receipts[0]).toMatchObject({ self_write: 'none', caused_by_action_id: null });
    });
  });

  it('injector: inserting a NEW key with a forged marker is nulled', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      await withTransaction(world.injector, async (client) => {
        await client.query('SELECT 1 FROM checkout.config_collection WHERE singleton FOR UPDATE');
        await client.query(
          `INSERT INTO checkout.config_entries (key, value, version, caused_by_action_id, caused_by_actor)
           VALUES ('adv.forged', '1'::jsonb, 1, $1, 'action')`,
          [intent.id],
        );
        await client.query(
          `INSERT INTO checkout.config_versions (key, version, value, caused_by_action_id, caused_by_actor)
           VALUES ('adv.forged', 1, '1'::jsonb, $1, 'action')`,
          [intent.id],
        );
        await client.query('UPDATE checkout.config_collection SET version = version + 1');
      });
      expect((await configState(world, 'adv.forged')).causedBy).toBeNull();
      expect((await historyRows(world, 'adv.forged'))[0].caused_by_action_id).toBeNull();
    });
  });

  it('admin: the triggers also null the marker for the owner/migration role', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      await world.admin.query(FORGED_UPDATE, [intent.id]);
      expect((await configState(world, 'db.pool_max')).causedBy).toBeNull();
      await world.admin.query(FORGED_HISTORY, [intent.id, 3, 'b'.repeat(64)]);
      expect((await historyRows(world, 'db.pool_max')).at(-1)?.caused_by_action_id).toBeNull();
    });
  });

  it('actor column: an injector write that claims actor = action but carries no action id is still a foreign write', async () => {
    await withWorld(async (world) => {
      await memberReceipt(world, 'db.pool_max');
      await world.injector.query(
        `UPDATE checkout.config_entries
            SET value = '15'::jsonb, version = version + 1, caused_by_actor = 'action'
          WHERE key = 'db.pool_max'`,
      );
      await world.injector.query(
        `INSERT INTO checkout.config_versions (key, version, value, after_digest, caused_by_actor)
         VALUES ('db.pool_max', 2, '15'::jsonb, $1, 'action')`,
        ['c'.repeat(64)],
      );
      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', selfWrite: 'none' });
    });
  });

  it('verifier and checkout roles cannot write the authority at all', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      for (const role of ['verifier', 'checkout'] as const) {
        const pool = createRolePool(role, world.db.urls[role], { max: 1 });
        try {
          await expect(pool.query(FORGED_UPDATE, [intent.id])).rejects.toMatchObject({ code: '42501' });
          await expect(
            pool.query(FORGED_HISTORY, [intent.id, 3, 'd'.repeat(64)]),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await pool.end();
        }
      }
    });
  });

  it('privilege switching and trigger bypass are refused to the injector (SET ROLE / SESSION AUTHORIZATION / session_replication_role / DDL)', async () => {
    await withWorld(async (world) => {
      const statements = [
        'SET ROLE nemodots_app',
        'SET SESSION AUTHORIZATION nemodots_app',
        "SET session_replication_role = 'replica'",
        'ALTER TABLE checkout.config_entries DISABLE TRIGGER config_entries_caused_by',
        'ALTER TABLE checkout.config_versions DISABLE TRIGGER config_versions_caused_by',
        'CREATE FUNCTION checkout.forge() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$',
        'DROP TRIGGER config_entries_caused_by ON checkout.config_entries',
      ];
      for (const statement of statements) {
        const outcome = await world.injector.query(statement).then(
          () => 'allowed',
          (error: { code?: string }) => error.code ?? 'error',
        );
        expect(['42501', '0LP01', '28000'], statement).toContain(outcome);
      }
    });
  });

  it('RESIDUAL: the admin role owns the triggers and can disable them (admin = migrations/stack only; stated trust boundary, ARCHITECTURE 3)', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      await world.admin.query(
        'ALTER TABLE checkout.config_entries DISABLE TRIGGER config_entries_caused_by',
      );
      await world.admin.query(FORGED_UPDATE, [intent.id]);
      expect((await configState(world, 'db.pool_max')).causedBy).toBe(intent.id);
    });
  });
});

describe('self-write marker forgery: tool and API inputs', () => {
  const base = {
    action: 'set_config',
    payload: {
      key: 'db.pool_max',
      value: 20,
      expectedCurrentValueDigest: 'e'.repeat(64),
    },
    supportingReceiptIds: [],
    rationale: 'x',
  };
  const forged = '11111111-1111-4111-8111-111111111111';

  it('propose_action rejects a causedByActionId at the top level, in the payload, and as an extra citation field', () => {
    const schema = TEAM_TOOL_INPUTS.propose_action;
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, causedByActionId: forged }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, payload: { ...base.payload, causedByActionId: forged } }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...base, selfWrite: 'verified' }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, payload: { ...base.payload, caused_by_action_id: forged } }).success,
    ).toBe(false);
  });

  it('every other strict tool schema refuses a marker field', () => {
    for (const [name, schema] of Object.entries(TEAM_TOOL_INPUTS)) {
      if (name === 'propose_action') continue;
      const minimal: Record<string, unknown> =
        name === 'observe_source'
          ? { sourceKey: 'checkout.health' }
          : name === 'read_runbook'
            ? { id: 'abc' }
            : name === 'get_task_status'
              ? { taskId: forged }
              : name === 'request_replan'
                ? { reason: 'x' }
                : name === 'publish_finding'
                  ? { claim: 'c', supportingReceiptIds: [], confidence: 'low' }
                  : name === 'delegate_task'
                    ? {
                        title: 't',
                        role: 'database_specialist',
                        question: 'q',
                        dependsOn: [],
                        justification: 'j',
                      }
                    : {};
      expect(
        schema.safeParse({ ...minimal, causedByActionId: forged, selfWrite: 'verified' }).success,
        name,
      ).toBe(false);
    }
  });

  it('a proposal service call with a forged marker in the payload is an InvalidProposalError and writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const before = await world.admin.query('SELECT count(*) n FROM coordinator.action_intents');
      await expect(
        world.service.propose(
          {
            ...base,
            payload: { ...base.payload, causedByActionId: forged },
          } as never,
          proposeCtx(s),
        ),
      ).rejects.toMatchObject({ name: 'InvalidProposalError' });
      const after = await world.admin.query('SELECT count(*) n FROM coordinator.action_intents');
      expect(after.rows[0].n).toBe(before.rows[0].n);
      void createAttempt;
    });
  });

  it('a scenario manifest step with a marker field is rejected by the strict schema', () => {
    const manifest = loadScenario('benign_change');
    const poisoned = JSON.parse(JSON.stringify(manifest));
    poisoned.steps[0].causedByActionId = forged;
    expect(ScenarioManifestSchema.safeParse(poisoned).success).toBe(false);
    expect(ScenarioManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('the owner edit ignores a marker smuggled into its input: the history row has no action id', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      const rig = watcherRig(world);
      await rig.watcher.observe([KEY]);
      const edit = createOwnerEdit({ pool: world.app, watcher: rig.watcher });
      const head = await configState(world, 'ui.banner_text');
      await edit({
        key: 'ui.banner_text',
        value: 'owner says hi',
        expectedVersion: head.version,
        causedByActionId: intent.id,
        selfWrite: 'verified',
      } as never);
      const state = await configState(world, 'ui.banner_text');
      expect(state.causedBy).toBeNull();
      expect(state.actor).toBe('owner');
      expect((await historyRows(world, 'ui.banner_text')).at(-1)?.caused_by_action_id).toBeNull();
    });
  });

  it('an action id of an intent that never wrote this key cannot settle it even if a row names it (only a row carrying the matching digest and key counts)', async () => {
    await withWorld(async (world) => {
      // Intent B is committed on db.pool_max; its history row names db.pool_max. Classification of a
      // different key must never settle B.
      const { intent } = await committedAction(world);
      await memberReceipt(world, 'ui.banner_text');
      await world.app.query(
        `UPDATE checkout.config_entries
            SET value = '"x"'::jsonb, version = version + 1, caused_by_action_id = $1, caused_by_actor = 'action'
          WHERE key = 'ui.banner_text'`,
        [intent.id],
      );
      await world.app.query(
        `INSERT INTO checkout.config_versions (key, version, value, after_digest, caused_by_action_id, caused_by_actor)
         VALUES ('ui.banner_text', 2, '"x"'::jsonb, $1, $2, 'action')`,
        ['f'.repeat(64), intent.id],
      );
      const rig = watcherRig(world);
      const out = await rig.watcher.observe(['checkout.config/ui.banner_text']);
      // The trusted app role really did write the marker, but the intent targets another key
      // and another digest: it is not a recognised self-write for this source.
      expect(out[0].selfWrite).toBe('mismatch');
      // ...and the key mismatch cannot "verify" the intent for db.pool_max through this row.
      const settledViaWrongKey = rig.settled.find((x) => x.actionId === intent.id && x.outcome === 'verified');
      expect(settledViaWrongKey).toBeUndefined();
      void intentStatus;
    });
  });
});

describe('self-write marker forgery: the ledger', () => {
  it('RESIDUAL: registerObservation stores a caller-supplied selfWrite/causedByActionId as given (only the watcher legitimately computes it; observe_source executors must never forward model input)', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedAction(world);
      const result = await withTransaction(world.app, (client) =>
        registerObservation(client, {
          source: sourceRef('checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: {
            kind: 'tool_call',
            causedByActionId: intent.id,
            selfWrite: 'verified',
          },
        }),
      );
      expect(result.receipt.provenance).toMatchObject({
        selfWrite: 'verified',
        causedByActionId: intent.id,
      });
    });
  });
});
