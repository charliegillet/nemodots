// W5.2: self-write marker forgery (ARCHITECTURE 5.4 / finding I14) through
// every surface, and the self-write / foreign-write interleaving the watcher
// must classify from history (finding C7).
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { clearHooks } from '../../../../src/server/nemodots/actions/index.js';
import type {
  InvalidationEvent,
  RecoveryPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import {
  LEDGER,
  configVersions,
  injectConfig,
  intentRow,
  liveConfig,
  proposeSetConfig,
  settle,
  sourceRef,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

async function committedSetConfig(env: Env, value = 20) {
  const sc = await proposeSetConfig(env, { value });
  const admitted = await env.actions.admit(sc.intent.id, 'd1');
  const fence = (admitted as unknown as { dispatch: { fence: number } })
    .dispatch.fence;
  const result = await env.actions.commitDetailed(sc.intent.id, fence);
  expect(result.intent.status).toBe('committed');
  return { sc, receipt: result.receipt! };
}

async function asRole(
  env: Env,
  role: 'injector' | 'admin' | 'checkout' | 'verifier',
  sql: string,
  params: unknown[],
) {
  const client = new pg.Client({ connectionString: env.db.urls[role] });
  await client.connect();
  try {
    return await settle(client.query(sql, params));
  } finally {
    await client.end();
  }
}

describe('marker forgery', () => {
  it('cleared: injector and admin roles cannot set caused_by_action_id on the head or the history', () =>
    withEnv(async (env) => {
      const { sc } = await committedSetConfig(env);
      const forged = sc.intent.id;
      for (const role of ['injector', 'admin'] as const) {
        const head = await asRole(
          env,
          role,
          `UPDATE checkout.config_entries
              SET value = '11'::jsonb, version = version + 1, caused_by_action_id = $1, caused_by_actor = 'action'
            WHERE key = 'db.statement_timeout_ms' RETURNING caused_by_action_id`,
          [forged],
        );
        expect(head.ok && head.value.rows[0].caused_by_action_id).toBeNull();
        const history = await asRole(
          env,
          role,
          `INSERT INTO checkout.config_versions (key, version, value, after_digest, caused_by_action_id, caused_by_actor)
           VALUES ('db.statement_timeout_ms', (SELECT max(version) + 1 FROM checkout.config_versions WHERE key = 'db.statement_timeout_ms'),
                   '11'::jsonb, repeat('a', 64), $1, 'action')
           RETURNING caused_by_action_id`,
          [forged],
        );
        expect(
          history.ok && history.value.rows[0].caused_by_action_id,
        ).toBeNull();
      }
    }));

  it('cleared: checkout and verifier roles cannot write the authority at all', () =>
    withEnv(async (env) => {
      for (const role of ['checkout', 'verifier'] as const) {
        const result = await asRole(
          env,
          role,
          `UPDATE checkout.config_entries SET caused_by_action_id = gen_random_uuid() WHERE key = 'db.pool_max'`,
          [],
        );
        expect(result.ok).toBe(false);
        expect(!result.ok && (result.error as { code?: string }).code).toBe(
          '42501',
        );
      }
    }));

  it('cleared: the model cannot carry a marker in a proposal (strict payload)', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const tampered = {
        ...sc.input,
        payload: { ...sc.input.payload, causedByActionId: sc.intent.id },
      };
      const result = await settle(
        env.actions.propose(
          tampered as never,
          { ...sc.world.ctx, ...sc.call } as never,
        ),
      );
      expect(result.ok).toBe(false);
    }));

  it('cleared: a forged selfWrite claim for an injector revision excuses nobody', () =>
    withEnv(async (env) => {
      const { sc } = await committedSetConfig(env);
      await injectConfig(env, 'db.pool_max', 15); // foreign write on top
      const live = (await liveConfig(env, 'db.pool_max'))!;
      const result = await withTransaction(env.app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(sc.world, 'checkout.config/db.pool_max'),
            normalizedValue: {
              key: 'db.pool_max',
              value: live.value,
              version: live.version,
            },
            provenance: {
              kind: 'tool_call',
              causedByActionId: sc.intent.id as never,
              selfWrite: 'verified',
            },
          },
          { ledger: LEDGER },
        ),
      );
      expect(result.invalidation?.affected.attemptIds ?? []).toContain(
        sc.world.attemptId,
      );
      const { rows } = await env.admin.query(
        'SELECT status FROM coordinator.task_attempts WHERE id = $1',
        [sc.world.attemptId],
      );
      expect(rows[0].status).toBe('invalidated');
    }));
});

describe('self-write / foreign-write interleaving (watcher history walk)', () => {
  it('cleared: a foreign write between classification and registration makes the head selfWrite none', () =>
    withEnv(async (env) => {
      const { sc } = await committedSetConfig(env, 20);
      const invalidations: InvalidationEvent[] = [];
      const settled: [string, string][] = [];
      const recovery: RecoveryPort = {
        onInvalidation: async (event) => {
          invalidations.push(event);
        },
        onSelfWriteSettled: async (actionId, outcome) => {
          settled.push([actionId, outcome]);
        },
      };
      let injected = false;
      const watcher = createWatcher({
        pool: env.app,
        reader: {
          read: async () => {
            throw new Error('observed sources are not part of this test');
          },
        },
        recovery,
        intents: env.actions.selfWriteIntents,
        intervalMs: 60_000,
        // WatcherDeps.ledger is typed LedgerOptions; registration needs `events`
        ledger: LEDGER as never,
        hooks: {
          beforeRegister: async ({ sourceKey }) => {
            if (sourceKey !== 'checkout.config/db.pool_max' || injected) return;
            injected = true;
            await injectConfig(env, 'db.pool_max', 15);
          },
        },
      });
      await watcher.pass({ keys: ['checkout.config/db.pool_max'] });
      expect(injected).toBe(true);
      const rows = await configVersions(env, 'db.pool_max');
      const head = rows[rows.length - 1];
      expect(head.caused_by_actor).toBe('injector');
      const { rows: receipts } = await env.admin.query(
        `SELECT r.source_revision, r.status, r.self_write, r.caused_by_action_id
           FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = 'checkout.config/db.pool_max' AND r.mission_id = $1
          ORDER BY r.source_revision DESC LIMIT 1`,
        [sc.world.missionId],
      );
      expect(Number(receipts[0].source_revision)).toBe(head.version);
      expect(receipts[0].self_write).toBe('none');
      expect((await intentRow(env, sc.intent.id)).status).toBe('verified');
      expect(settled).toContainEqual([sc.intent.id, 'verified']);
      // the full invalidation reaches the acting lineage too
      const { rows: attempt } = await env.admin.query(
        'SELECT status FROM coordinator.task_attempts WHERE id = $1',
        [sc.world.attemptId],
      );
      expect(attempt[0].status).toBe('invalidated');
    }));
});
