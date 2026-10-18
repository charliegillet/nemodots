// The production SelfWriteIntentPort adapter (actions.selfWriteIntents) driven
// through the REAL watcher: a committed set_config is settled from the version
// history (ARCHITECTURE 5.4, C7), verified when the after-digest matches and
// failed(postcondition_mismatch) when it does not.
import { describe, expect, it } from 'vitest';
import type {
  InvalidationEvent,
  RecoveryPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import {
  admitIntent,
  intentRow,
  proposeSetConfig,
  receiptsOf,
  withEnv,
  type Env,
} from './harness.js';

const KEY = 'db.pool_max';
const SOURCE = `checkout.config/${KEY}`;

function watcherFor(env: Env) {
  const settlements: { actionId: string; outcome: string }[] = [];
  const invalidations: InvalidationEvent[] = [];
  const recovery: RecoveryPort = {
    async onInvalidation(event) {
      invalidations.push(event);
    },
    async onSelfWriteSettled(actionId, outcome) {
      settlements.push({ actionId, outcome });
    },
  };
  const watcher = createWatcher({
    pool: env.app,
    reader: {
      async read() {
        throw new Error('only controlled sources are watched here');
      },
    },
    recovery,
    intents: env.actions.selfWriteIntents,
    intervalMs: 60_000,
    ledger: { events: createEventSink() } as never,
  });
  return { watcher, settlements, invalidations };
}

const headReceipt = async (env: Env) =>
  (
    await env.admin.query(
      `SELECT r.source_revision, r.status, r.self_write, r.caused_by_action_id
         FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
        WHERE s.key = $1 ORDER BY r.source_revision DESC LIMIT 1`,
      [SOURCE],
    )
  ).rows[0];

describe('actions.selfWriteIntents through the watcher', () => {
  it('a verified self-write: the history row matches, the intent settles committed -> verified, the head receipt carries selfWrite verified', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await env.actions.commitDetailed(sc.intent.id, fence);
      expect((await intentRow(env, sc.intent.id)).status).toBe('committed');

      const found = await env.actions.selfWriteIntents.find(sc.intent.id);
      expect(found).toMatchObject({
        id: sc.intent.id,
        sourceKey: SOURCE,
        status: 'committed',
      });
      expect(found!.expectedAfterDigest).toMatch(/^[0-9a-f]{64}$/);

      const { watcher, settlements, invalidations } = watcherFor(env);
      try {
        const stats = await watcher.pass({ keys: [SOURCE] });
        expect(stats).toMatchObject({ registered: 1, errors: 0 });
      } finally {
        await watcher.stop();
      }

      expect((await intentRow(env, sc.intent.id)).status).toBe('verified');
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        outcome: 'verified',
        postcondition: { kind: 'history', configVersion: 2 },
      });
      expect(settlements).toEqual([
        { actionId: sc.intent.id, outcome: 'verified' },
      ]);
      expect(await headReceipt(env)).toMatchObject({
        source_revision: 2,
        status: 'supported',
        self_write: 'verified',
        caused_by_action_id: sc.intent.id,
      });
      expect(invalidations[0]?.selfWrite).toBe('verified');
      // replaying the walk is a no-op
      const again = await env.actions.selfWriteIntents.find(sc.intent.id);
      expect(again!.status).toBe('verified');
    });
  });

  it('a mismatching after-digest: the intent settles failed(postcondition_mismatch) and nothing is excused', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await env.actions.commitDetailed(sc.intent.id, fence);
      // the history now disagrees with what the commit recorded
      await env.admin.query(
        'ALTER TABLE checkout.config_versions DISABLE TRIGGER USER',
      );
      await env.admin.query(
        "UPDATE checkout.config_versions SET after_digest = repeat('f', 64) WHERE key = $1 AND version = 2",
        [KEY],
      );
      await env.admin.query(
        'ALTER TABLE checkout.config_versions ENABLE TRIGGER USER',
      );

      const { watcher, settlements } = watcherFor(env);
      try {
        await watcher.pass({ keys: [SOURCE] });
      } finally {
        await watcher.stop();
      }
      expect(await intentRow(env, sc.intent.id)).toMatchObject({
        status: 'failed',
        failure_reason: 'postcondition_mismatch',
      });
      expect(settlements).toEqual([
        { actionId: sc.intent.id, outcome: 'failed' },
      ]);
      expect((await headReceipt(env)).self_write).toBe('mismatch');
    });
  });

  it('find returns null for an unknown or non-config action', async () => {
    await withEnv(async (env) => {
      expect(
        await env.actions.selfWriteIntents.find(
          '00000000-0000-4000-8000-000000000000' as never,
        ),
      ).toBeNull();
    });
  });
});
