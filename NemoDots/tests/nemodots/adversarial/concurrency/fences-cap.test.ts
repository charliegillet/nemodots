// W5.2: authoring fence versus dispatch fence (ARCHITECTURE 6), zombie
// authors on publish/propose, and the closure-cap path (finding C14).
import { describe, expect, it } from 'vitest';
import { createIntentReader } from '../../../../src/server/nemodots/actions/index.js';
import type { RecoveryPort } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { pauseMission } from '../../../../src/server/nemodots/coordinator/missions.js';
import { publishOutput } from '../../../../src/server/nemodots/coordinator/publish.js';
import { createSupportValidator } from '../../../../src/server/nemodots/ledger/index.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import {
  LEDGER,
  count,
  intentRow,
  proposeSetConfig,
  settle,
  withEnv,
  type Env,
  type World,
} from './harness.js';

function coordinatorDeps(env: Env) {
  return {
    pool: env.app,
    config: {},
    events: createEventSink(),
    supportValidator: createSupportValidator(),
    ledger: { recordModelCall: async () => {}, recordArtifact: async () => {} },
    recordOrphanedAttempt: async () => {},
    intents: createIntentReader(),
    actions: env.actions,
    clock: () => new Date(),
  } as unknown as Parameters<typeof publishOutput>[0] &
    Parameters<typeof pauseMission>[0];
}

/** What the reaper does on lease expiry: attempt expired, task fence bumped. */
async function takeOver(env: Env, world: World) {
  await env.admin.query(
    `UPDATE coordinator.task_attempts SET status = 'expired', finished_at = now() WHERE id = $1`,
    [world.attemptId],
  );
  await env.admin.query(
    `UPDATE coordinator.tasks SET fence_seq = fence_seq + 1, status = 'runnable' WHERE id = $1`,
    [world.taskId],
  );
}

describe('authoring fence vs dispatch fence', () => {
  it('cleared: an author whose lease was taken over cannot propose (nothing written)', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await takeOver(env, sc.world);
      const before = await count(
        env.admin,
        'SELECT count(*) AS n FROM coordinator.action_intents',
      );
      const late = await settle(
        env.actions.propose(
          { ...sc.input, rationale: 'late duplicate with new text' } as never,
          { ...sc.world.ctx, ...sc.call, toolCallId: 'call_late' } as never,
        ),
      );
      expect(late.ok).toBe(false);
      expect(!late.ok && late.error.name).toBe('FenceError');
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.action_intents',
        ),
      ).toBe(before);
    }));

  it('cleared: a proposal published by a then-valid author stays dispatchable after the author lost its lease', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await takeOver(env, sc.world);
      const admitted = await env.actions.admit(sc.intent.id, 'd1');
      expect(admitted.status).toBe('admitted');
      const fence = (admitted as unknown as { dispatch: { fence: number } })
        .dispatch.fence;
      expect((await env.actions.commit(sc.intent.id, fence)).status).toBe(
        'committed',
      );
    }));

  it('cleared: the author token is not accepted as a dispatch fence', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const admitted = await env.actions.admit(sc.intent.id, 'd1');
      const fence = (admitted as unknown as { dispatch: { fence: number } })
        .dispatch.fence;
      const wrong =
        fence === sc.intent.authorFencingToken
          ? fence + 1
          : sc.intent.authorFencingToken;
      const result = await settle(env.actions.commit(sc.intent.id, wrong));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.name).toBe('DispatchFenceError');
      expect((await intentRow(env, sc.intent.id)).status).toBe('admitted');
    }));

  it('cleared: a zombie author cannot publish an output after takeover', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await takeOver(env, sc.world);
      const result = await settle(
        publishOutput(coordinatorDeps(env), sc.world.ctx, {
          kind: 'handoff',
          content: { summary: 'late' },
          dependencyVector: [],
        }),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.name).toBe('FenceError');
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.task_outputs WHERE attempt_id = $1',
          [sc.world.attemptId],
        ),
      ).toBe(0);
    }));
});

describe('closure cap (C14)', () => {
  it('cleared: a capped closure pauses the mission, registers the receipt, and the dependent commit is blocked', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const admitted = await env.actions.admit(sc.intent.id, 'd1');
      const fence = (admitted as unknown as { dispatch: { fence: number } })
        .dispatch.fence;
      const recovery: RecoveryPort = {
        onInvalidation: async () => {},
        onSelfWriteSettled: async () => {},
      };
      const deps = coordinatorDeps(env);
      const logs: string[] = [];
      const watcher = createWatcher({
        pool: env.app,
        reader: {
          read: async (key) => {
            if (key !== 'checkout.health') throw new Error(`unexpected ${key}`);
            return {
              normalizedValue: { status: 'degraded' },
              raw: null,
              revisionHint: null,
            };
          },
        },
        recovery,
        missions: { pause: (missionId) => pauseMission(deps, missionId) },
        intervalMs: 60_000,
        // WatcherDeps.ledger is typed LedgerOptions; registration needs `events`
        ledger: LEDGER as never,
        limits: { maxDepth: 64, maxNodes: 1 },
        log: (entry) => logs.push(entry.event),
      });
      await watcher.pass({ keys: ['checkout.health'] });
      expect(logs).toContain('closure_cap_exceeded');
      const { rows: mission } = await env.admin.query(
        'SELECT status FROM coordinator.missions WHERE id = $1',
        [sc.world.missionId],
      );
      expect(mission[0].status).toBe('paused');
      const { rows: receipt } = await env.admin.query(
        'SELECT status FROM ledger.observation_receipts WHERE id = $1',
        [sc.health.id],
      );
      expect(receipt[0].status).toBe('superseded');
      const committed = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(committed.intent.status).toBe('blocked');
      // the source stays observable: a second pass confirms, it does not loop
      logs.length = 0;
      await watcher.pass({ keys: ['checkout.health'] });
      expect(logs).not.toContain('closure_cap_exceeded');
    }));
});
