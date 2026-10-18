// The action boundary behind the real coordinator: the outbox message
// `action.proposed` drives admission (no earlier than admission.minAgeMs),
// the pipeline commits, and cancelling the mission cancels queued intents
// while keeping committed effects listed (gate 2 item 14, finding C12).
import { describe, expect, it } from 'vitest';
import {
  createCoordinator,
  type CoordinatorConfig,
  type ForeignSnapshotReader,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { createSupportValidator } from '../../../../src/server/nemodots/ledger/index.js';
import {
  createIntentReader,
  readActionSnapshot,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  admitAndCommit,
  authorizations,
  configState,
  createAttempt,
  intentRow,
  proposePool,
  scenario,
  withWorld,
  type World,
} from './harness.js';

const CONFIG: CoordinatorConfig = {
  ownerId: 'owner-actions',
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
  mode: 'fixture',
  provider: { host: 'fixture.invalid', plannerModel: 'p', workerModel: 'w' },
  budgets: {
    maxTasks: 24,
    maxDepth: 3,
    maxBreadth: 4,
    maxTokens: 200_000,
    maxInferenceCalls: 200,
    maxWallClockMs: 600_000,
  },
  leaseMs: 30_000,
  taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 20_000 },
  replanCap: 3,
};

function coordinatorFor(world: World) {
  const snapshotReader: ForeignSnapshotReader = {
    async read(client, missionId) {
      const actionRows = await readActionSnapshot(client, missionId);
      return {
        receipts: [],
        confirmations: [],
        ...actionRows,
        probe: null,
        telemetry: {
          calls: 0,
          orphanedCalls: 0,
          tokens: {
            prompt: 0,
            completion: 0,
            cached: { available: false, total: null },
          },
          byModel: [],
          byRole: [],
          retries: 0,
          errors: 0,
          ttftMs: null,
          prefixGroups: [],
        },
      };
    },
  };
  return createCoordinator(
    {
      pool: world.app,
      config: CONFIG,
      supportValidator: createSupportValidator(),
      ledger: {
        recordModelCall: async () => {},
        recordArtifact: async () => {},
      },
      recordOrphanedAttempt: async () => {},
      intents: createIntentReader(),
      actions: world.service.coordinatorPort('coordinator-test'),
      snapshotReader,
      probe: null,
      providerHealthy: async () => true,
    },
    { workerId: 'coordinator-test' },
  );
}

describe('coordinator wiring', () => {
  it('the outbox admits, commits and records a proposal end to end', async () => {
    await withWorld(async (world) => {
      const coordinator = coordinatorFor(world);
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      expect(await coordinator.outbox.drain()).toBeGreaterThan(0);
      expect((await intentRow(world, proposed.id)).status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
        causedBy: proposed.id,
      });
      const auth = await authorizations(world, proposed.id);
      expect(auth.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'commit:committed',
      ]);
      const { rows } = await world.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM coordinator.outbox
          WHERE topic = 'action.proposed' AND processed_at IS NOT NULL`,
      );
      expect(Number(rows[0].n)).toBe(1);
      await coordinator.outbox.stop();
    });
  });

  it('admission waits for mission.admission.minAgeMs', async () => {
    await withWorld(
      async (world) => {
        const coordinator = coordinatorFor(world);
        const s = await scenario(world);
        const proposed = await proposePool(world, s, 20);
        await coordinator.outbox.drain();
        expect((await intentRow(world, proposed.id)).status).toBe('proposed');
        expect(await configState(world, 'db.pool_max')).toMatchObject({
          value: 10,
          version: 1,
        });
        await coordinator.outbox.stop();
      },
      { minAgeMs: 60_000 },
    );
  });

  it('a stale proposal is blocked by the pipeline and the outbox message completes', async () => {
    await withWorld(async (world) => {
      const coordinator = coordinatorFor(world);
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await world.injector.query(
        `UPDATE checkout.config_entries SET value = '3'::jsonb, version = version + 1 WHERE key = 'db.pool_max'`,
      );
      await world.injector.query(
        `INSERT INTO checkout.config_versions (key, version, value, before_digest, after_digest, caused_by_actor)
         VALUES ('db.pool_max', 2, '3'::jsonb, NULL, NULL, 'injector')`,
      );
      await coordinator.outbox.drain();
      const row = await intentRow(world, proposed.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('stale_version');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 2,
      });
      await coordinator.outbox.stop();
    });
  });

  it('cancelling the mission cancels queued intents and lists committed effects', async () => {
    await withWorld(async (world) => {
      const coordinator = coordinatorFor(world);
      const a = await scenario(world);
      const queued = await proposePool(world, a, 20);
      const b = await scenario(world, {
        attempt: await createAttempt(world),
        key: 'db.statement_timeout_ms',
      });
      const toCommit = await world.service.propose(
        {
          action: 'set_config',
          payload: {
            key: 'db.statement_timeout_ms',
            value: 6000,
            expectedCurrentValueDigest: (
              await import('./harness.js')
            ).valueDigest(5000),
          },
          supportingReceiptIds: [],
          rationale: 'raise the timeout',
        },
        {
          ...b.attempt.context,
          modelCallId: b.modelCallId,
          toolCallId: b.toolCallId,
        } as never,
      );
      const { committed } = await admitAndCommit(world, toCommit.id);
      expect(committed.status).toBe('committed');
      const admittedOnly = await world.service.admit(queued.id, 'dispatcher-a');
      expect(admittedOnly.status).toBe('admitted');

      const cancelled = await coordinator.control.cancel(
        world.missionId as never,
      );
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancellation?.committedEffects).toEqual([toCommit.id]);
      expect(cancelled.cancellation?.cancelledIntentIds).toEqual([queued.id]);
      expect((await intentRow(world, queued.id)).status).toBe('cancelled');
      expect((await intentRow(world, toCommit.id)).status).toBe('committed');
      // The committed effect stays in history; the cancelled one never wrote.
      expect(await configState(world, 'db.statement_timeout_ms')).toMatchObject(
        {
          value: 6000,
          version: 2,
        },
      );
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 1,
      });
      // A late commit under the old fence finds a cancelled intent: nothing written.
      const late = await world.service.commit(
        queued.id,
        admittedOnly.dispatch!.fence,
      );
      expect(late.status).toBe('cancelled');
      await coordinator.outbox.stop();
    });
  });
});

describe('queries', () => {
  it('the snapshot rows and the intent reader agree with the tables', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await admitAndCommit(world, proposed.id);
      const snapshot = await readActionSnapshot(world.app, world.missionId);
      expect(snapshot.actions.map((a) => a.id)).toEqual([proposed.id]);
      expect(snapshot.authorizations).toHaveLength(2);
      expect(snapshot.results.map((r) => r.outcome)).toEqual(['committed']);
      const reader = createIntentReader();
      expect((await reader.find(world.app, proposed.id))?.status).toBe(
        'committed',
      );
      expect(
        await reader.committedEffects(world.app, world.missionId as never),
      ).toEqual([proposed.id]);
      // A committed set_config stays a committed effect after a failed verification.
      await world.service.settleFromHistory(proposed.id, 'failed');
      expect(
        await reader.committedEffects(world.app, world.missionId as never),
      ).toEqual([proposed.id]);
      expect(await reader.statuses(world.app, [proposed.id])).toEqual([
        { id: proposed.id, status: 'failed' },
      ]);
    });
  });
});
