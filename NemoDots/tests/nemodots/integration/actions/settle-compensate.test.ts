// Verification of a committed set_config from the config history (settle.ts),
// the RecoveryPort wiring, and compensation as a new intent (compensate.ts).
import { describe, expect, it } from 'vitest';
import {
  createActionService,
  CompensationRefusedError,
  SettleRefusedError,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  ResultReceiptSchema,
  digest,
  type RecoveryPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  admitAndCommit,
  authorizations,
  configState,
  countRows,
  externalChange,
  flushScenario,
  historyRows,
  memberReceipt,
  observed,
  proposeFlush,
  proposePool,
  results,
  scenario,
  withWorld,
  type World,
} from './harness.js';

async function committedPool(world: World, value = 20) {
  const s = await scenario(world);
  const proposed = await proposePool(world, s, value);
  const { committed } = await admitAndCommit(world, proposed.id);
  expect(committed.status).toBe('committed');
  return { s, intent: committed };
}

describe('settleFromHistory (finding C7)', () => {
  it('verifies a committed set_config from its own history row, even after the head moved on', async () => {
    await withWorld(async (world) => {
      const told: [string, string][] = [];
      const recovery: RecoveryPort = {
        onInvalidation: async () => {},
        onSelfWriteSettled: async (id, outcome) => {
          told.push([id, outcome]);
        },
      };
      const service = createActionService({ ...world.deps, recovery });
      const { intent } = await committedPool(world);
      // Another writer changes the key before the watcher walks the history.
      await externalChange(world, 'db.pool_max', 3);

      const verified = await service.settleFromHistory(intent.id, 'verified');
      expect(verified.status).toBe('verified');
      expect(told).toEqual([[intent.id, 'verified']]);
      const rows = await results(world, intent.id);
      expect(rows.map((r) => r.outcome)).toEqual(['committed', 'verified']);
      expect(rows[1].postcondition).toMatchObject({
        kind: 'history',
        configVersion: 2,
      });
      expect(
        ResultReceiptSchema.safeParse({
          id: rows[1].id,
          actionId: intent.id,
          idempotencyKey: intent.idempotencyKey,
          payloadHash: intent.payloadHash,
          outcome: 'verified',
          controlPlane: rows[1].control_plane,
          externalEffect: null,
          postcondition: rows[1].postcondition,
          recordedAt: new Date().toISOString(),
        }).success,
      ).toBe(true);

      // Idempotent; the watcher's retry re-notifies recovery (it dedupes).
      const again = await service.settleFromHistory(intent.id, {
        outcome: 'verified',
        configVersion: 2,
      });
      expect(again.status).toBe('verified');
      expect(told).toHaveLength(2);
      expect(
        await countRows(
          world,
          'coordinator.result_receipts',
          'action_id = $1',
          [intent.id],
        ),
      ).toBe(2);
      // A contradicting settlement is refused.
      await expect(
        service.settleFromHistory(intent.id, 'failed'),
      ).rejects.toBeInstanceOf(SettleRefusedError);
      // The configuration is the injector's, untouched by settling.
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 3,
        causedBy: null,
      });
    });
  });

  it('refuses a version that is not the action’s own history row', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedPool(world);
      await expect(
        world.service.settleFromHistory(intent.id, {
          outcome: 'verified',
          configVersion: 5,
        }),
      ).rejects.toBeInstanceOf(SettleRefusedError);
      expect((await world.service.reconcile(intent.id)).status).toBe(
        'committed',
      );
    });
  });

  it('settles failed(postcondition_mismatch) and failed(superseded_before_verification)', async () => {
    await withWorld(async (world) => {
      const told: [string, string][] = [];
      const service = createActionService({
        ...world.deps,
        recovery: {
          onInvalidation: async () => {},
          onSelfWriteSettled: async (id, outcome) => {
            told.push([id, outcome]);
          },
        },
      });
      const first = await committedPool(world, 20);
      const mismatch = await service.settleFromHistory(
        first.intent.id,
        'failed',
      );
      expect(mismatch.status).toBe('failed');
      expect(mismatch.failureReason).toBe('postcondition_mismatch');
      expect(told).toEqual([[first.intent.id, 'failed']]);
      const rows = await results(world, first.intent.id);
      expect(rows.map((r) => r.outcome)).toEqual(['committed', 'failed']);

      const second = await committedPool(world, 15);
      const superseded = await service.settleFromHistory(second.intent.id, {
        outcome: 'failed',
        reason: 'superseded_before_verification',
      });
      expect(superseded.failureReason).toBe('superseded_before_verification');
    });
  });

  it('only a committed set_config can be settled', async () => {
    await withWorld(
      async (world) => {
        const s = await scenario(world);
        const proposed = await proposePool(world, s, 20);
        await expect(
          world.service.settleFromHistory(proposed.id, 'verified'),
        ).rejects.toBeInstanceOf(SettleRefusedError);
        const f = await flushScenario(world);
        const flush = await proposeFlush(world, f);
        await expect(
          world.service.settleFromHistory(flush.id, 'verified'),
        ).rejects.toBeInstanceOf(SettleRefusedError);
      },
      { redis: true },
    );
  });

  it('reconcile of a committed set_config is a no-op: committed means applied, the watcher verifies', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedPool(world);
      const reconciled = await world.service.reconcile(intent.id);
      expect(reconciled.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
      });
    });
  });
});

describe('compensation (gate 2 item 13)', () => {
  async function freshReceipts(world: World, key = 'db.pool_max') {
    const member = await memberReceipt(world, key);
    const health = await observed(world, 'checkout.health', {
      status: 'degraded',
      checks: { postgres: true },
    });
    return [member.id, health.id];
  }

  it('is a new intent that passes G1 against the current version and restores the earlier value', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedPool(world, 20);
      await world.service.settleFromHistory(intent.id, 'verified');
      const supporting = await freshReceipts(world);
      const reversal = await world.service.compensate(intent.id, {
        supportingReceiptIds: supporting as never,
      });
      expect(reversal.status).toBe('proposed');
      expect(reversal.id).not.toBe(intent.id);
      expect(reversal.payload).toMatchObject({
        key: 'db.pool_max',
        value: 10,
        expectedCurrentValueDigest: digest(20),
      });
      expect(reversal.expectedTargetVersion).toBe(2);
      // Nothing is written until the reversal commits.
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
      });

      const { committed } = await admitAndCommit(world, reversal.id);
      expect(committed.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 3,
        causedBy: reversal.id,
      });
      const history = await historyRows(world, 'db.pool_max');
      expect(history.map((row) => [row.version, row.value])).toEqual([
        [1, 10],
        [2, 20],
        [3, 10],
      ]);
      // The original stays verified: a reversal does not rewrite history.
      expect((await results(world, intent.id)).map((r) => r.outcome)).toEqual([
        'committed',
        'verified',
      ]);
      expect(
        (await authorizations(world, reversal.id)).map((a) => a.decision),
      ).toEqual(['admitted', 'committed']);
    });
  });

  it('refuses when the version moved after the action (a later valid change is not overwritten)', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedPool(world, 20);
      await externalChange(world, 'db.pool_max', 7);
      const supporting = await freshReceipts(world);
      await expect(
        world.service.compensate(intent.id, {
          supportingReceiptIds: supporting as never,
        }),
      ).rejects.toMatchObject({
        name: 'CompensationRefusedError',
        why: 'version_moved',
      });
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 7,
        version: 3,
        causedBy: null,
      });
      expect(await countRows(world, 'coordinator.action_intents')).toBe(1);
    });
  });

  it('a reversal that goes stale before it commits is blocked like any other intent', async () => {
    await withWorld(async (world) => {
      const { intent } = await committedPool(world, 20);
      const supporting = await freshReceipts(world);
      const reversal = await world.service.compensate(intent.id, {
        supportingReceiptIds: supporting as never,
      });
      await externalChange(world, 'db.pool_max', 7);
      const { admitted } = await admitAndCommit(world, reversal.id);
      expect(admitted.status).toBe('blocked');
      expect(admitted.blockReason).toBe('stale_version');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 7,
        version: 3,
      });
    });
  });

  it('refuses a flush (irreversible), an intent that is not committed, and a second reversal', async () => {
    await withWorld(
      async (world) => {
        const f = await flushScenario(world);
        const flush = await proposeFlush(world, f);
        await world.service.process(flush.id, 'd');
        const supporting = await freshReceipts(world);
        await expect(
          world.service.compensate(flush.id, {
            supportingReceiptIds: supporting as never,
          }),
        ).rejects.toMatchObject({ why: 'not_reversible' });

        const s = await scenario(world);
        const proposed = await proposePool(world, s, 20);
        await expect(
          world.service.compensate(proposed.id, {
            supportingReceiptIds: supporting as never,
          }),
        ).rejects.toMatchObject({ why: 'not_committed' });

        const { intent } = await committedPool(world, 18);
        const fresh = await freshReceipts(world);
        await world.service.compensate(intent.id, {
          supportingReceiptIds: fresh as never,
        });
        await expect(
          world.service.compensate(intent.id, {
            supportingReceiptIds: fresh as never,
          }),
        ).rejects.toBeInstanceOf(CompensationRefusedError);
      },
      { redis: true },
    );
  });

  it('needs current evidence: a stale target receipt cannot support the reversal', async () => {
    await withWorld(async (world) => {
      const { s, intent } = await committedPool(world, 20);
      await expect(
        world.service.compensate(intent.id, {
          supportingReceiptIds: [s.member.id, s.health.id] as never,
        }),
      ).rejects.toMatchObject({ why: 'evidence_missing' });
    });
  });
});
