// Controlled sources: authority versions -> receipts (ARCHITECTURE 5.2),
// invalidation sets, the NOTIFY path, membership changes and races.
import { describe, expect, it } from 'vitest';
import type { SourceKey } from '../../../../src/server/nemodots/contracts/index.js';
import { advanceConfigUnconditionallyTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  attemptStatus,
  collectionVersion,
  configState,
  headOf,
  injectorWrite,
  ledgerEvents,
  missionReading,
  receiptsOf,
  recoveryKinds,
  taskStatus,
  until,
  withWatcherEnv,
} from './harness.js';

const CONFIG_KEYS = [
  'cache.namespace',
  'cache.schema_version',
  'db.pool_max',
  'db.statement_timeout_ms',
  'orders.write_enabled',
  'routing.inventory_source',
  'ui.banner_text',
];
const member = (key: string) => `checkout.config/${key}`;

describe('baseline registration', () => {
  it('registers every controlled source at the authority version and never registers it twice', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      const first = await watcher.runCycle();

      for (const key of CONFIG_KEYS) {
        const state = await configState(env, key);
        const receipts = await receiptsOf(env, member(key));
        expect(receipts, key).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          revision: state.version,
          status: 'supported',
          selfWrite: 'none',
          causedByActionId: null,
          provenanceKind: 'watcher',
          normalizedValue: { key, value: state.value, version: state.version },
        });
        expect(receipts[0].collectionRevision).toBe(
          await collectionVersion(env),
        );
      }
      const collection = await receiptsOf(env, 'checkout.config');
      expect(collection).toHaveLength(1);
      expect(collection[0].revision).toBe(await collectionVersion(env));
      expect(collection[0].normalizedValue).toEqual({
        keys: [...CONFIG_KEYS].sort(),
        collectionVersion: await collectionVersion(env),
      });
      // the watcher is not a mission: receipts carry the reserved id
      expect(new Set(collection.map((r) => r.missionId))).toEqual(
        new Set(['00000000-0000-4000-8000-00000000a1c7']),
      );
      expect(
        first.outcomes.filter((o) => o.outcome === 'registered').length,
      ).toBeGreaterThanOrEqual(CONFIG_KEYS.length + 1);

      // nothing changed: no controlled source is read or registered again
      const second = await watcher.runCycle();
      const controlled = second.outcomes.filter((o) =>
        o.sourceKey.startsWith('checkout.config'),
      );
      expect(controlled).toEqual([]);
      for (const key of CONFIG_KEYS)
        expect(await receiptsOf(env, member(key)), key).toHaveLength(1);

      // a restarted watcher (new instance, same database) does not re-register
      const restarted = env.watcher();
      await restarted.runCycle();
      for (const key of CONFIG_KEYS)
        expect(await receiptsOf(env, member(key)), key).toHaveLength(1);
      expect(await receiptsOf(env, 'checkout.config')).toHaveLength(1);
    });
  });
});

describe('an injector change', () => {
  it('registers within one poll at revision == config_entries.version, supersedes the old receipt and invalidates exactly the readers', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      // M1: T1a reads the namespace, T1b reads the pool size. M2: T2a reads the
      // namespace. M3: T3a reads only the banner.
      const m1 = await missionReading(env, [
        [member('cache.namespace')],
        [member('db.pool_max')],
      ]);
      const m2 = await missionReading(env, [[member('cache.namespace')]]);
      const m3 = await missionReading(env, [[member('ui.banner_text')]]);

      const version = await injectorWrite(env, 'cache.namespace', 'catalog-b');
      expect(version).toBe(2);
      const cycle = await watcher.runCycle();

      const receipts = await receiptsOf(env, member('cache.namespace'));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(receipts[0].supersededBy).toBe(receipts[1].id);
      expect(receipts[1]).toMatchObject({
        revision: (await configState(env, 'cache.namespace')).version,
        selfWrite: 'none',
        causedByActionId: null,
        provenanceKind: 'watcher',
        normalizedValue: {
          key: 'cache.namespace',
          value: 'catalog-b',
          version: 2,
        },
      });
      expect(
        cycle.outcomes
          .filter((o) => o.outcome === 'registered')
          .map((o) => o.sourceKey),
      ).toContain(member('cache.namespace'));

      // hand-enumerated affected sets from the fixture attempts / read sets
      const [event] = await ledgerEvents(env, member('cache.namespace'));
      expect(event).toMatchObject({
        reason: 'newer_observation',
        selfWrite: 'none',
        oldReceiptId: receipts[0].id,
        newReceiptId: receipts[1].id,
        closure: { capped: false },
      });
      const byMission = new Map(event.perMission.map((p) => [p.missionId, p]));
      expect([...byMission.keys()].sort()).toEqual(
        [m1.missionId, m2.missionId].sort(),
      );
      expect(byMission.get(m1.missionId)).toEqual({
        missionId: m1.missionId,
        affected: {
          modelCallIds: [],
          attemptIds: [m1.attempts[0].attemptId],
          outputIds: [],
          actionIds: [],
          taskIds: [m1.attempts[0].taskId],
        },
        preserved: {
          taskIds: m1.allTaskIds.filter((id) => id !== m1.attempts[0].taskId),
        },
      });
      expect(byMission.get(m2.missionId)?.affected.attemptIds).toEqual([
        m2.attempts[0].attemptId,
      ]);
      expect(byMission.get(m2.missionId)?.affected.taskIds).toEqual([
        m2.attempts[0].taskId,
      ]);
      expect([...event.affected.attemptIds].sort()).toEqual(
        [m1.attempts[0].attemptId, m2.attempts[0].attemptId].sort(),
      );

      // the ledger marked the coordinator's rows; unrelated attempts keep running
      expect(await attemptStatus(env, m1.attempts[0].attemptId)).toBe(
        'invalidated',
      );
      expect(await attemptStatus(env, m1.attempts[1].attemptId)).toBe(
        'running',
      );
      expect(await attemptStatus(env, m2.attempts[0].attemptId)).toBe(
        'invalidated',
      );
      expect(await attemptStatus(env, m3.attempts[0].attemptId)).toBe(
        'running',
      );
      expect(await taskStatus(env, m3.attempts[0].taskId)).not.toBe(
        'invalidated',
      );

      // the event reached the coordinator: repairs for the affected, none for M3
      expect(await recoveryKinds(env, m1.missionId)).toContain(
        'repair_scheduled',
      );
      expect(await recoveryKinds(env, m2.missionId)).toContain(
        'repair_scheduled',
      );
      expect(await recoveryKinds(env, m3.missionId)).toEqual([]);
    });
  });

  it('B1: a cosmetic change supersedes only its member receipt; the collection stays current and a mission that never read the key is untouched', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      // two polls: the first /health call leaves a canary cache key, which
      // moves redis.stats exactly once (a sandbox property, not the watcher's)
      await watcher.runCycle();
      await watcher.runCycle();
      const baselineEvents = (await ledgerEvents(env)).length;
      const readsBanner = await missionReading(env, [
        [member('ui.banner_text')],
      ]);
      const readsCollection = await missionReading(env, [
        ['checkout.config', member('cache.namespace')],
      ]);

      const run = await env.s.inject('benign_change');
      const summary = await run.done;
      expect(summary.status).toBe('completed');
      await watcher.runCycle();

      const banner = await receiptsOf(env, member('ui.banner_text'));
      expect(banner.map((r) => r.status)).toEqual(['superseded', 'supported']);
      const collection = await receiptsOf(env, 'checkout.config');
      expect(collection).toHaveLength(1);
      expect(collection[0].status).toBe('supported');
      for (const key of CONFIG_KEYS.filter((k) => k !== 'ui.banner_text'))
        expect(
          (await receiptsOf(env, member(key))).map((r) => r.status),
          key,
        ).toEqual(['supported']);

      const events = (await ledgerEvents(env)).slice(baselineEvents);
      expect(events).toHaveLength(1);
      expect(events[0].sourceKey).toBe(member('ui.banner_text'));
      expect(events[0].perMission.map((p) => p.missionId)).toEqual([
        readsBanner.missionId,
      ]);
      expect(events[0].affected.attemptIds).toEqual([
        readsBanner.attempts[0].attemptId,
      ]);
      expect(
        await attemptStatus(env, readsCollection.attempts[0].attemptId),
      ).toBe('running');
      expect(await recoveryKinds(env, readsCollection.missionId)).toEqual([]);
    });
  });
});

describe('the NOTIFY path', () => {
  it('registers a change well inside 500 ms with a poll interval of a minute', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({ config: { intervalMs: 60_000 } });
      await watcher.start();
      expect(watcher.isLeader()).toBe(true);
      await watcher.runCycle(); // queued behind the initial poll
      expect(await receiptsOf(env, member('db.pool_max'))).toHaveLength(1);

      await injectorWrite(env, 'db.pool_max', 12);
      const written = performance.now();
      await until(
        async () => (await receiptsOf(env, member('db.pool_max'))).length === 2,
        'the notified revision',
        2_000,
        5,
      );
      const elapsed = performance.now() - written;
      expect(elapsed).toBeLessThan(500);
      const head = await headOf(env, member('db.pool_max'));
      expect(head.revision).toBe(2);
      expect(head.normalizedValue).toEqual({
        key: 'db.pool_max',
        value: 12,
        version: 2,
      });
    });
  });

  it('the interval alone also finds a change when no notification arrives', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({ config: { intervalMs: 250 } });
      await watcher.start();
      await watcher.runCycle();
      // a write by a role without NOTIFY would still be found by the poll: write
      // through SQL with the notification suppressed by raw UPDATE as the app role
      const client = await env.app.connect();
      try {
        await client.query(
          `UPDATE checkout.config_entries SET value = '"hush"'::jsonb, version = version + 1
            WHERE key = 'ui.banner_text'`,
        );
        await client.query(
          `INSERT INTO checkout.config_versions (key, version, value, before_digest, after_digest, caused_by_actor)
           SELECT 'ui.banner_text', version, value, NULL, NULL, 'owner'
             FROM checkout.config_entries WHERE key = 'ui.banner_text'`,
        );
      } finally {
        client.release();
      }
      await until(
        async () =>
          (await receiptsOf(env, member('ui.banner_text'))).length === 2,
        'the polled revision',
        3_000,
      );
    });
  });
});

describe('membership', () => {
  it('an inserted key supersedes the collection receipt and registers the member; a deleted key retracts its receipt', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      const readsCollection = await missionReading(env, [['checkout.config']]);
      const before = await collectionVersion(env);

      await advanceConfigUnconditionallyTx(env.injector, {
        key: 'feature.flag',
        value: true,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      });
      await watcher.runCycle();
      const collection = await receiptsOf(env, 'checkout.config');
      expect(collection.map((r) => [r.revision, r.status])).toEqual([
        [before, 'superseded'],
        [before + 1, 'supported'],
      ]);
      expect(collection[1].normalizedValue).toEqual({
        keys: [...CONFIG_KEYS, 'feature.flag'].sort(),
        collectionVersion: before + 1,
      });
      const added = await receiptsOf(env, member('feature.flag'));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        revision: 1,
        collectionRevision: before + 1,
        status: 'supported',
      });
      const [inserted] = await ledgerEvents(env, 'checkout.config');
      expect(inserted.reason).toBe('collection_changed');
      expect(inserted.affected.attemptIds).toEqual([
        readsCollection.attempts[0].attemptId,
      ]);

      // delete: the member's receipt is retracted (source_removed), the
      // collection advances again
      const readsMember = await missionReading(env, [[member('feature.flag')]]);
      await advanceConfigUnconditionallyTx(env.injector, {
        key: 'feature.flag',
        deleteKey: true,
        causedBy: { actor: 'injector' },
      });
      const cycle = await watcher.runCycle();
      expect(
        cycle.outcomes.find((o) => o.sourceKey === member('feature.flag'))
          ?.outcome,
      ).toBe('removed');
      expect(
        (await receiptsOf(env, member('feature.flag'))).map((r) => r.status),
      ).toEqual(['retracted']);
      const [removed] = await ledgerEvents(env, member('feature.flag'));
      expect(removed).toMatchObject({
        reason: 'retraction',
        newReceiptId: null,
      });
      expect(removed.affected.attemptIds).toEqual([
        readsMember.attempts[0].attemptId,
      ]);
      expect((await receiptsOf(env, 'checkout.config')).at(-1)?.revision).toBe(
        before + 2,
      );
      // a second poll does not retract again
      await watcher.runCycle();
      expect(await ledgerEvents(env, member('feature.flag'))).toHaveLength(1);
    });
  });
});

describe('races and replays', () => {
  it('a reader replaying an older revision is rejected by the ledger, logged once and not retried forever', async () => {
    await withWatcherEnv(async (env) => {
      const good = env.watcher();
      await good.runCycle();
      await injectorWrite(env, 'ui.banner_text', 'second');
      await good.runCycle(); // the ledger is at revision 2
      await injectorWrite(env, 'ui.banner_text', 'third'); // the authority is at 3

      let replays = 0;
      const replaying = {
        async read(
          key: SourceKey,
          scope: Parameters<typeof env.readers.read>[1],
        ) {
          if (key !== (member('ui.banner_text') as SourceKey))
            return env.readers.read(key, scope);
          replays += 1;
          return {
            normalizedValue: {
              key: 'ui.banner_text',
              value: 'first',
              version: 1,
            },
            raw: null,
            revisionHint: 1,
          };
        },
      };
      const watcher = env.watcher({ readers: replaying });
      const first = await watcher.runCycle();
      expect(
        first.outcomes.find((o) => o.sourceKey === member('ui.banner_text'))
          ?.outcome,
      ).toBe('rejected');
      // bounded: one trigger re-reads a few times at most, then gives up
      expect(replays).toBeGreaterThanOrEqual(1);
      expect(replays).toBeLessThanOrEqual(3);
      const stale = () =>
        env.events.filter((e) => e.type === 'stale_observation_rejected');
      expect(stale()).toEqual([
        {
          type: 'stale_observation_rejected',
          sourceKey: member('ui.banner_text'),
          observed: 1,
          current: 3,
        },
      ]);

      // the next poll replays again (bounded again) but the log line is deduplicated
      const before = replays;
      await watcher.runCycle();
      expect(replays - before).toBeLessThanOrEqual(3);
      expect(stale()).toHaveLength(1);
      expect(watcher.stats().staleRejected).toBe(1);
      // nothing was registered for the replayed value
      expect(
        (await receiptsOf(env, member('ui.banner_text'))).map(
          (r) => r.revision,
        ),
      ).toEqual([1, 2]);

      // the real reader catches up
      await good.runCycle();
      const receipts = await receiptsOf(env, member('ui.banner_text'));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'superseded'],
        [3, 'supported'],
      ]);
      expect(receipts[2].normalizedValue).toEqual({
        key: 'ui.banner_text',
        value: 'third',
        version: 3,
      });
    });
  });
});
