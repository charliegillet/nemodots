// Crash behaviour at each barrier of the commit path, and the roles that may
// write the self-write marker.
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  setHook,
  type HookName,
} from '../../../../src/server/nemodots/actions/index.js';
import { advanceConfigUnconditionallyTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  admitIntent,
  authorizations,
  configVersions,
  intentRow,
  liveConfig,
  proposeSetConfig,
  receiptsOf,
  withEnv,
} from './harness.js';

afterEach(() => clearHooks());

describe('crash before the commit transaction ends (gate 2.11)', () => {
  it.each<HookName>([
    'after_preliminary_read',
    'before_lock',
    'after_lock_before_commit',
  ])(
    'a crash at %s leaves the intent admitted and unwritten; the retry commits exactly once',
    async (name) => {
      await withEnv(async (env) => {
        const sc = await proposeSetConfig(env);
        const { fence } = await admitIntent(env, sc);
        const authBefore = (await authorizations(env, sc.intent.id)).length;
        const off = setHook(name, () => {
          throw new Error('simulated crash');
        });
        await expect(
          env.actions.commitDetailed(sc.intent.id, fence),
        ).rejects.toThrow('simulated crash');
        off();

        expect((await intentRow(env, sc.intent.id)).status).toBe('admitted');
        expect(await liveConfig(env, 'db.pool_max')).toMatchObject({
          value: 10,
          version: 1,
        });
        expect(await configVersions(env, 'db.pool_max')).toHaveLength(1);
        expect(await receiptsOf(env, sc.intent.id)).toHaveLength(0);
        expect((await authorizations(env, sc.intent.id)).length).toBe(
          authBefore,
        );

        const done = await env.actions.commitDetailed(sc.intent.id, fence);
        expect(done.intent.status).toBe('committed');
        expect(await liveConfig(env, 'db.pool_max')).toMatchObject({
          value: 20,
          version: 2,
        });
        expect(await receiptsOf(env, sc.intent.id)).toHaveLength(1);
      });
    },
  );
});

describe('the self-write marker (I14)', () => {
  it('the injector role cannot set caused_by_action_id even when it names an action', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const injector = new pg.Pool({
        connectionString: env.db.urls.injector,
        max: 2,
      });
      try {
        await advanceConfigUnconditionallyTx(injector, {
          key: 'db.pool_max',
          value: 12,
          causedBy: { actor: 'injector', actionId: sc.intent.id },
        });
      } finally {
        await injector.end();
      }
      const head = await env.admin.query(
        'SELECT caused_by_action_id FROM checkout.config_entries WHERE key = $1',
        ['db.pool_max'],
      );
      expect(head.rows[0].caused_by_action_id).toBeNull();
      expect(
        (await configVersions(env, 'db.pool_max')).every(
          (row) => row.caused_by_action_id === null,
        ),
      ).toBe(true);
    });
  });
});
