// Owner manual edit: advanceConfig(actor owner) then an immediate observation.
import { describe, expect, it } from 'vitest';
import { ConfigVersionError } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { createOwnerEdit } from '../../../../src/server/nemodots/watcher/index.js';
import {
  attemptStatus,
  configState,
  headOf,
  ledgerEvents,
  missionReading,
  receiptsOf,
  withWatcherEnv,
} from './harness.js';

const member = (key: string) => `checkout.config/${key}`;

describe('owner manual edit', () => {
  it('writes through the version authority and registers the new revision immediately, with owner_edit provenance', async () => {
    await withWatcherEnv(async (env) => {
      // a running watcher with a long interval: it would only notice through NOTIFY
      const watcher = env.watcher({ config: { intervalMs: 60_000 } });
      await watcher.start();
      await watcher.runCycle();
      const mission = await missionReading(env, [[member('ui.banner_text')]]);
      const edit = createOwnerEdit({ pool: env.app, watcher });

      const result = await edit({
        key: 'ui.banner_text',
        value: 'Hello from the shop',
        expectedVersion: 1,
      });

      expect(result.change).toMatchObject({
        key: 'ui.banner_text',
        versionBefore: 1,
        versionAfter: 2,
        membershipChanged: false,
      });
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]).toMatchObject({
        sourceKey: member('ui.banner_text'),
        outcome: 'registered',
        revision: 2,
      });
      // already registered when the call returns: no poll, no notification wait
      const receipts = await receiptsOf(env, member('ui.banner_text'));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(receipts[1]).toMatchObject({
        provenanceKind: 'owner_edit',
        selfWrite: 'none',
        causedByActionId: null,
        normalizedValue: {
          key: 'ui.banner_text',
          value: 'Hello from the shop',
          version: 2,
        },
      });
      // the actor lives only in the version history; the receipt names none
      const history = await env.admin.query(
        `SELECT caused_by_actor, caused_by_action_id FROM checkout.config_versions
          WHERE key = 'ui.banner_text' AND version = 2`,
      );
      expect(history.rows[0]).toEqual({
        caused_by_actor: 'owner',
        caused_by_action_id: null,
      });
      expect(JSON.stringify(receipts[1].normalizedValue)).not.toMatch(/owner/i);

      const [event] = await ledgerEvents(env, member('ui.banner_text'));
      expect(event.affected.attemptIds).toEqual([
        mission.attempts[0].attemptId,
      ]);
      expect(await attemptStatus(env, mission.attempts[0].attemptId)).toBe(
        'invalidated',
      );

      // the notification of the edit finds the work done: nothing registered twice
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await receiptsOf(env, member('ui.banner_text'))).toHaveLength(2);
      expect((await headOf(env, member('ui.banner_text'))).provenanceKind).toBe(
        'owner_edit',
      );
    });
  });

  it('is a compare-and-set: a stale expected version fails and registers nothing', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      const edit = createOwnerEdit({ pool: env.app, watcher });
      await edit({ key: 'db.pool_max', value: 11, expectedVersion: 1 });
      await expect(
        edit({ key: 'db.pool_max', value: 12, expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'stale_version' });
      await expect(
        edit({ key: 'db.pool_max', value: 12, expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(ConfigVersionError);
      expect(await configState(env, 'db.pool_max')).toEqual({
        value: 11,
        version: 2,
      });
      expect(await receiptsOf(env, member('db.pool_max'))).toHaveLength(2);
    });
  });

  it('an edit that inserts nothing new leaves the collection receipt current', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      const edit = createOwnerEdit({ pool: env.app, watcher });
      await edit({
        key: 'routing.inventory_source',
        value: 'replica_stale',
        expectedVersion: 1,
      });
      const collection = await receiptsOf(env, 'checkout.config');
      expect(collection).toHaveLength(1);
      expect(collection[0].status).toBe('supported');
    });
  });
});
