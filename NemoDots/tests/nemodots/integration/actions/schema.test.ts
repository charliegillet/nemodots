// The shape of migration 0005 as the roles see it: append-only receipts,
// least-privilege grants, the contract's transition table in SQL, and the
// live-status unique index of finding C5.
import { describe, expect, it } from 'vitest';
import {
  ACTION_TRANSITIONS,
  ActionStatusSchema,
  LIVE_STATUSES,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import {
  authorizations,
  intentRow,
  proposePool,
  scenario,
  tampering,
  withWorld,
} from './harness.js';

describe('migration 0005', () => {
  it('the live index covers exactly the contract LIVE_STATUSES', async () => {
    await withWorld(async (world) => {
      const { rows } = await world.admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'action_intents_idempotency_live_idx'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE/);
      for (const status of ActionStatusSchema.options) {
        const live = (LIVE_STATUSES as readonly string[]).includes(status);
        expect(rows[0].indexdef.includes(`'${status}'`)).toBe(live);
      }
    });
  });

  it('the SQL transition guard equals ACTION_TRANSITIONS for every pair', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      // Walk every (from, to) pair on a scratch copy of the row by forcing the
      // status with the guard disabled for the setup and enabled for the test.
      for (const from of ActionStatusSchema.options) {
        for (const to of ActionStatusSchema.options) {
          if (from === to) continue;
          await tampering(world, () =>
            world.admin.query(
              // Satisfy the row CHECKs of the `from` state.
              `UPDATE coordinator.action_intents
                  SET status = $2,
                      block_reason = CASE WHEN $2 = 'blocked' THEN 'stale_version' END,
                      failure_reason = CASE WHEN $2 = 'failed' THEN 'expired' END,
                      dispatch_fence = 7, dispatch_owner = 'x',
                      dispatcher_lease_expires_at = now() + interval '1 hour',
                      committed_target_version = 1
                WHERE id = $1`,
              [proposed.id, from],
            ),
          );
          const attempt = world.admin.query(
            `UPDATE coordinator.action_intents
                SET status = $2,
                    block_reason = CASE WHEN $2 = 'blocked' THEN 'stale_version' END,
                    failure_reason = CASE WHEN $2 = 'failed' THEN 'expired' END
              WHERE id = $1`,
            [proposed.id, to],
          );
          const allowed = (
            ACTION_TRANSITIONS[from] as readonly string[]
          ).includes(to);
          if (allowed) await attempt;
          else
            await expect(attempt).rejects.toThrow(/illegal action transition/);
        }
      }
      expect((await intentRow(world, proposed.id)).id).toBe(proposed.id);
    });
  }, 60_000);

  it('grants: the app role cannot rewrite receipts; the injector and the verifier see what they should', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 999); // blocked: has an Authorization
      expect(await authorizations(world, proposed.id)).toHaveLength(1);
      await expect(
        world.app.query(
          'UPDATE coordinator.authorizations SET decision = decision',
        ),
      ).rejects.toThrow();
      await expect(
        world.app.query('DELETE FROM coordinator.result_receipts'),
      ).rejects.toThrow();
      // The injector has no access to the coordinator schema.
      await expect(
        world.injector.query('SELECT count(*) FROM coordinator.action_intents'),
      ).rejects.toThrow(/permission denied/);
      // The verifier reads, never writes.
      const verifier = createRolePool('verifier', world.db.urls.verifier);
      try {
        const read = await verifier.query(
          'SELECT count(*) AS n FROM coordinator.action_intents',
        );
        expect(Number(read.rows[0].n)).toBe(1);
        await expect(
          verifier.query(
            `UPDATE coordinator.action_intents SET rationale = 'x' WHERE true`,
          ),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await verifier.end();
      }
    });
  });

  it('a second commit Authorization for one action cannot exist (C2 backstop)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const insert = () =>
        world.admin.query(
          `INSERT INTO coordinator.authorizations
             (id, action_id, stage, decision, checked_vector, target_expected, target_live,
              author_fence_token, author_fence_valid, policy_version, idempotency_binding)
           VALUES (gen_random_uuid(), $1, 'commit', 'committed', '[]', 1, 1, 1, true, 'policy-v1', 'new')`,
          [proposed.id],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/authorizations_one_commit_idx/);
    });
  });
});
