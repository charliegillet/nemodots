// W5.2: G2 publication under an advancing version (finding C9), a read added
// after its receipt was superseded (C13), and the collection-first lock order
// with B1 isolation (C1/D1).
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  createIntentReader,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import type { DependencyVector } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  addReadSet,
  publishOutput,
} from '../../../../src/server/nemodots/coordinator/publish.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  createSupportValidator,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import { advanceConfigUnconditionallyTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  LEDGER,
  createWorld,
  injectConfig,
  observeMember,
  proposeSetConfig,
  settle,
  sourceRef,
  waitForLockWaiters,
  withEnv,
  type Env,
  type World,
} from './harness.js';

afterEach(() => clearHooks());

function publishDeps(env: Env) {
  return {
    pool: env.app,
    config: {},
    events: createEventSink(),
    supportValidator: createSupportValidator(),
    ledger: { recordModelCall: async () => {}, recordArtifact: async () => {} },
    recordOrphanedAttempt: async () => {},
    intents: createIntentReader(),
    clock: () => new Date(),
  } as unknown as Parameters<typeof publishOutput>[0];
}

const entryOf = (r: {
  id: string;
  source: { key: string };
  sourceRevision: number;
}) =>
  ({
    sourceKey: r.source.key,
    sourceRevision: r.sourceRevision,
    receiptId: r.id,
  }) as DependencyVector[number];

async function observeCollection(env: Env, world: World) {
  const { rows: v } = await env.admin.query<{ version: string }>(
    'SELECT version FROM checkout.config_collection',
  );
  const { rows: keys } = await env.admin.query<{ key: string }>(
    'SELECT key FROM checkout.config_entries ORDER BY key',
  );
  const result = await withTransaction(env.app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(world, 'checkout.config'),
        normalizedValue: {
          keys: keys.map((k) => k.key).sort(),
          collectionVersion: Number(v[0].version),
        },
        provenance: { kind: 'watcher' },
      },
      { ledger: LEDGER },
    ),
  );
  return result.receipt;
}

describe('G2 publication', () => {
  it('cleared: a writer waits for an in-flight publication that holds its row FOR SHARE (C9)', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, 'db.pool_max');
      const gate = new pg.Client({ connectionString: env.db.urls.admin });
      await gate.connect();
      try {
        await gate.query('BEGIN');
        // stalls the publication at its INSERT, after assertCurrent locked the row
        await gate.query(
          'LOCK TABLE coordinator.task_outputs IN ACCESS EXCLUSIVE MODE',
        );
        const publication = settle(
          publishOutput(publishDeps(env), world.ctx, {
            kind: 'handoff',
            content: { summary: 'pool is 10' },
            dependencyVector: [entryOf(member)],
          }),
        );
        await waitForLockWaiters(env, 1);
        let injected = false;
        const injector = injectConfig(env, 'db.pool_max', 4).then(() => {
          injected = true;
        });
        await waitForLockWaiters(env, 2);
        expect(injected).toBe(false);
        await gate.query('COMMIT');
        const published = await publication;
        expect(published.ok).toBe(true);
        await injector;
        expect(injected).toBe(true);
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
    }));

  it('cleared: a read added after its receipt was superseded rejects and invalidates the attempt (C13)', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const old = await observeMember(env, world, 'db.pool_max');
      await injectConfig(env, 'db.pool_max', 6);
      await observeMember(env, world, 'db.pool_max'); // supersedes `old`
      const result = await settle(
        addReadSet(publishDeps(env), world.ctx, [entryOf(old)]),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.name).toBe('SupportError');
      const { rows } = await env.admin.query(
        'SELECT status, read_set_receipt_ids FROM coordinator.task_attempts WHERE id = $1',
        [world.attemptId],
      );
      expect(rows[0].status).toBe('invalidated');
      expect(rows[0].read_set_receipt_ids).not.toContain(old.id);
    }));
});

describe('collection-first lock order and B1 isolation (C1/D1)', () => {
  it('cleared: an injector key insert and a commit holding the collection serialize without 40P01', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const collection = await observeCollection(env, world);
      const sc = await proposeSetConfig(env, {
        world,
        extraReceipts: [collection],
      });
      const admitted = await env.actions.admit(sc.intent.id, 'd1');
      expect(admitted.status).toBe('admitted');
      const fence = (admitted as unknown as { dispatch: { fence: number } })
        .dispatch.fence;
      const parked = latch();
      const release = latch();
      setHook('after_lock_before_commit', async ({ actionId }) => {
        if (actionId !== sc.intent.id) return;
        parked.open();
        await release.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await withTimeout(parked.promise, 5_000, 'commit parked');
      const insert = settle(
        advanceConfigUnconditionallyTx(env.injector, {
          key: 'feature.adversary',
          value: true,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        } as never),
      );
      await waitForLockWaiters(env, 1);
      release.open();
      expect((await commit).intent.status).toBe('committed');
      expect((await insert).ok).toBe(true);
      expect(env.conflicts.deadlocks).toBe(0);
    }));

  it('cleared: a member value change (B1) supersedes only that member; collection and other receipts stay current', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const collection = await observeCollection(env, world);
      const banner = await observeMember(env, world, 'ui.banner_text');
      const sc = await proposeSetConfig(env, {
        world,
        extraReceipts: [collection],
      });
      await injectConfig(env, 'ui.banner_text', 'B1 benign change');
      await observeMember(env, world, 'ui.banner_text');
      const { rows } = await env.admin.query(
        'SELECT id, status FROM ledger.observation_receipts WHERE id = ANY($1::uuid[])',
        [[collection.id, banner.id, sc.member.id]],
      );
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status[banner.id]).toBe('superseded');
      expect(status[collection.id]).toBe('supported');
      expect(status[sc.member.id]).toBe('supported');
      const admitted = await env.actions.admit(sc.intent.id, 'd1');
      expect(admitted.status).toBe('admitted');
    }));
});
