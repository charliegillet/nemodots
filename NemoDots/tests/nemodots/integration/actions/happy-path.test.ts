// The ordinary life of a set_config intent against real PostgreSQL:
// propose -> admit -> commit, checking version, actual value and receipt rows
// together (TEST_PROMPT gate 2).
import { describe, expect, it } from 'vitest';
import {
  ActionIntentSchema,
  AuthorizationSchema,
  EventPayloadSchema,
  ResultReceiptSchema,
  digest,
} from '../../../../src/server/nemodots/contracts/index.js';
import { inspectAction } from '../../../../src/server/nemodots/actions/index.js';
import {
  admitAndCommit,
  authorizations,
  configState,
  countRows,
  historyRows,
  intentRow,
  proposePool,
  results,
  scenario,
  withWorld,
} from './harness.js';

describe('propose -> admit -> commit', () => {
  it('commits a supported, fresh, current proposal exactly once', async () => {
    await withWorld(async (world) => {
      const before = await configState(world, 'db.pool_max');
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      expect(ActionIntentSchema.safeParse(proposed).success).toBe(true);
      expect(proposed.status).toBe('proposed');
      expect(proposed.expectedTargetVersion).toBe(before.version);
      expect(proposed.dispatch).toBeNull();
      expect(proposed.requiredSources).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
      ]);
      expect(proposed.dependencyVector.map((e) => e.sourceKey)).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
      ]);
      // Nothing changed at proposal.
      expect(await configState(world, 'db.pool_max')).toEqual(before);

      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      expect(admitted.dispatch?.owner).toBe('dispatcher-a');
      expect(admitted.dispatch?.fence).toBeGreaterThan(0);
      expect(await configState(world, 'db.pool_max')).toEqual(before);

      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('committed');

      const after = await configState(world, 'db.pool_max');
      expect(after.value).toBe(20);
      expect(after.version).toBe(before.version + 1);
      expect(after.causedBy).toBe(proposed.id);
      expect(after.actor).toBe('action');
      const history = await historyRows(world, 'db.pool_max');
      const last = history[history.length - 1];
      expect(last.version).toBe(after.version);
      expect(last.caused_by_action_id).toBe(proposed.id);
      expect(last.before_digest).toBe(digest(before.value));
      expect(last.after_digest).toBe(digest(20));

      const rows = await results(world, proposed.id);
      expect(rows.map((r) => r.outcome)).toEqual(['committed']);
      expect(rows[0].control_plane).toMatchObject({
        targetVersionBefore: before.version,
        targetVersionAfter: after.version,
        causedByActionId: proposed.id,
        afterDigest: digest(20),
      });
      const auth = await authorizations(world, proposed.id);
      expect(auth.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'commit:committed',
      ]);
      expect(auth[1].dispatch_fence_valid).toBe(true);
      for (const a of auth)
        expect(a.checked_vector.every((c) => c.freshnessOk)).toBe(true);

      const inspection = (await inspectAction(world.app, proposed.id))!;
      for (const a of inspection.authorizations)
        expect(AuthorizationSchema.safeParse(a).success).toBe(true);
      for (const r of inspection.results)
        expect(ResultReceiptSchema.safeParse(r).success).toBe(true);
      expect(ActionIntentSchema.safeParse(inspection.intent).success).toBe(
        true,
      );
      const row = await intentRow(world, proposed.id);
      expect(row.committed_target_version).toBe(String(after.version));
    });
  });

  it('writes the evidence edges, the outbox hint and the events of a proposal', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s);
      expect(
        await countRows(
          world,
          'ledger.dependency_edges',
          "to_kind = 'action_intent' AND to_id = $1 AND from_kind = 'receipt'",
          [proposed.id],
        ),
      ).toBe(2);
      expect(
        await countRows(
          world,
          'ledger.dependency_edges',
          "to_kind = 'action_intent' AND to_id = $1 AND from_kind IN ('attempt','model_call')",
          [proposed.id],
        ),
      ).toBe(2);
      expect(
        await countRows(
          world,
          'coordinator.outbox',
          "topic = 'action.proposed' AND payload->>'actionId' = $1",
          [proposed.id],
        ),
      ).toBe(1);
      const { rows } = await world.admin.query<{ kind: string }>(
        'SELECT kind FROM coordinator.events WHERE mission_id = $1 ORDER BY id',
        [world.missionId],
      );
      expect(rows.map((r) => r.kind)).toEqual(['action.proposed']);
    });
  });

  it('the events of the whole life are typed and in commit order', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await admitAndCommit(world, proposed.id);
      const { rows } = await world.admin.query<{
        id: string;
        kind: string;
        payload: { kind: string; stage?: string; decision?: string };
      }>(
        'SELECT id, kind, payload FROM coordinator.events WHERE mission_id = $1 ORDER BY id',
        [world.missionId],
      );
      expect(rows.map((r) => r.kind)).toEqual([
        'action.proposed',
        'action.decided',
        'action.decided',
        'action.committed',
      ]);
      expect(
        rows
          .filter((r) => r.kind === 'action.decided')
          .map((r) => `${r.payload.stage}:${r.payload.decision}`),
      ).toEqual(['admission:admitted', 'commit:committed']);
      for (const row of rows)
        expect(EventPayloadSchema.safeParse(row.payload).success).toBe(true);
    });
  });
});
