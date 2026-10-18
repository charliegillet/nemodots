// Admission and commit transactions against real PostgreSQL, the real ledger
// and the real version authority (TEST_PROMPT gate 2). Races use barriers on
// the named hooks of actions/test-hooks.ts, never sleeps; "waits" are proven
// from pg_locks. Every test asserts the version, the actual config value and
// the receipt/authorization rows together.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DispatchFenceError,
  ProposalRejectedError,
  clearHooks,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { FenceError } from '../../../../src/server/nemodots/coordinator/errors.js';
import {
  EventPayloadSchema,
  digest,
} from '../../../../src/server/nemodots/contracts/index.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  admitIntent,
  authorizations,
  configVersions,
  count,
  createWorld,
  emitCall,
  injectConfig,
  intentRow,
  liveConfig,
  observeMember,
  observeObserved,
  proposeSetConfig,
  receiptsOf,
  waitForLockWaiter,
  withEnv,
  type Env,
  type Scenario,
} from './harness.js';

afterEach(() => clearHooks());

const KEY = 'db.pool_max';

async function state(env: Env, key = KEY) {
  const live = await liveConfig(env, key);
  return { ...live!, history: (await configVersions(env, key)).length };
}

const blockedWith = (reason: string) =>
  expect.objectContaining({ status: 'blocked', blockReason: reason });

describe('proposal', () => {
  it('derives vector, version, key and hash on the server and stores a proposed intent with its outbox row and graph position', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { intent } = sc;
      expect(intent.status).toBe('proposed');
      expect(intent.dispatch).toBeNull();
      expect(intent.expectedTargetVersion).toBe(1);
      expect(intent.policyVersion).toBe('policy-v1');
      expect(intent.toolCallId).toBe(sc.call.toolCallId);
      expect(intent.modelCallId).toBe(sc.call.modelCallId);
      expect(intent.authorFencingToken).toBe(1);
      expect(intent.dependencyVector.map((e) => e.sourceKey)).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
      ]);
      expect(intent.requiredSources).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
      ]);
      expect(intent.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      const outbox = await env.admin.query(
        "SELECT payload, dedupe_key FROM coordinator.outbox WHERE topic = 'action.proposed'",
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].payload.actionId).toBe(intent.id);
      const edges = await count(
        env.admin,
        "SELECT count(*) AS n FROM ledger.dependency_edges WHERE to_kind = 'action_intent' AND to_id = $1",
        [intent.id],
      );
      expect(edges).toBeGreaterThanOrEqual(2);
      const events = await env.admin.query(
        "SELECT payload FROM coordinator.events WHERE kind = 'action.proposed'",
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].payload.expectedTargetVersion).toBe(1);
    });
  });

  it('admissionNotBefore is proposedAt + the mission admission.minAgeMs (D6)', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env, { admissionMinAgeMs: 4000 });
      const sc = await proposeSetConfig(env, { world });
      const events = await env.admin.query(
        "SELECT payload FROM coordinator.events WHERE kind = 'action.proposed'",
      );
      const notBefore = Date.parse(events.rows[0].payload.admissionNotBefore);
      expect(notBefore - Date.parse(sc.intent.proposedAt)).toBe(4000);
    });
  });

  it('a forged field (causedByActionId, requiredSources) fails the strict schema and writes nothing', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const before = await count(
        env.admin,
        'SELECT count(*) AS n FROM coordinator.action_intents',
      );
      for (const extra of [
        { payload: { ...sc.payload, causedByActionId: randomUUID() } },
        { requiredSources: [] },
      ]) {
        const error = await env.actions
          .propose(
            {
              action: 'set_config',
              payload: sc.payload,
              supportingReceiptIds: [],
              rationale: 'x',
              ...extra,
            } as never,
            { ...sc.world.ctx, ...sc.call } as never,
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProposalRejectedError);
        expect((error as ProposalRejectedError).reason).toBe('payload_invalid');
      }
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.action_intents',
        ),
      ).toBe(before);
    });
  });

  it('unknown kind, an extra field and an out-of-domain value all fail the same way: ProposalRejectedError payload_invalid, nothing stored (ADM-06c)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const tables = [
        'coordinator.action_intents',
        'coordinator.authorizations',
        'coordinator.outbox',
      ];
      const snapshot = async () =>
        Promise.all(
          tables.map((t) => count(env.admin, `SELECT count(*) AS n FROM ${t}`)),
        );
      const events = () =>
        count(
          env.admin,
          "SELECT count(*) AS n FROM coordinator.events WHERE kind LIKE 'action.%'",
        );
      const before = await snapshot();
      const eventsBefore = await events();
      const inputs = [
        {
          action: 'restart_service',
          payload: { service: 'checkout' },
          supportingReceiptIds: [],
          rationale: 'x',
        },
        {
          action: 'set_config',
          payload: { ...sc.payload, causedByActionId: randomUUID() },
          supportingReceiptIds: [],
          rationale: 'x',
        },
        {
          action: 'set_config',
          payload: { ...sc.payload, value: 500 },
          supportingReceiptIds: [],
          rationale: 'x',
        },
      ];
      for (const input of inputs) {
        const error = await env.actions
          .propose(input as never, { ...sc.world.ctx, ...sc.call } as never)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProposalRejectedError);
        expect((error as ProposalRejectedError).reason).toBe('payload_invalid');
      }
      expect(await snapshot()).toEqual(before);
      expect(await events()).toBe(eventsBefore);
    });
  });

  it('a capability the author task lacks is blocked(capability_denied)', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env, {
        capabilities: ['observe', 'propose_cache_flush'],
      });
      const sc = await proposeSetConfig(env, { world });
      expect(sc.intent).toEqual(blockedWith('capability_denied'));
    });
  });

  it('author fence invalid: a stale token, a lost lease, a paused mission or a foreign model call write nothing', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const input = {
        action: 'set_config',
        payload: sc.payload,
        supportingReceiptIds: [],
        rationale: 'again',
      };
      const newCall = await emitCall(
        env,
        sc.world,
        [sc.member, sc.health],
        'call_fenced',
      );
      const count0 = await count(
        env.admin,
        'SELECT count(*) AS n FROM coordinator.action_intents',
      );
      const outbox0 = await count(
        env.admin,
        'SELECT count(*) AS n FROM coordinator.outbox',
      );
      const attempt = async (context: object) =>
        env.actions
          .propose(input as never, { ...context, ...newCall } as never)
          .catch((e: unknown) => e);

      expect(
        await attempt({ ...sc.world.ctx, fencingToken: 99 }),
      ).toBeInstanceOf(FenceError);
      await env.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [sc.world.attemptId],
      );
      expect(await attempt(sc.world.ctx)).toBeInstanceOf(FenceError);
      await env.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = now() + interval '1 hour' WHERE id = $1",
        [sc.world.attemptId],
      );
      await env.admin.query(
        "UPDATE coordinator.missions SET status = 'paused' WHERE id = $1",
        [sc.world.missionId],
      );
      expect(await attempt(sc.world.ctx)).toBeInstanceOf(FenceError);
      await env.admin.query(
        "UPDATE coordinator.missions SET status = 'running' WHERE id = $1",
        [sc.world.missionId],
      );
      // a model call of another attempt cannot be claimed as the emitting call
      const other = await createWorld(env);
      const foreign = await emitCall(env, other, [], 'call_foreign');
      const mismatch = await env.actions
        .propose(input as never, { ...sc.world.ctx, ...foreign } as never)
        .catch((e: unknown) => e);
      expect(mismatch).toBeInstanceOf(ProposalRejectedError);

      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.action_intents',
        ),
      ).toBe(count0);
      expect(
        await count(env.admin, 'SELECT count(*) AS n FROM coordinator.outbox'),
      ).toBe(outbox0);
    });
  });

  it('a citation outside the snapshot, read set and inherited vector is blocked(citation_out_of_scope), including a receipt of another mission (I8)', async () => {
    await withEnv(async (env) => {
      const foreignWorld = await createWorld(env);
      const foreignMember = await observeMember(env, foreignWorld, KEY);
      const world = await createWorld(env);
      const member = await observeMember(env, world, KEY);
      const health = await observeObserved(env, world, 'checkout.health', {
        status: 'ok',
      });
      const call = await emitCall(env, world, [member, health], 'call_cite');
      const intent = await env.actions.propose(
        {
          action: 'set_config',
          payload: {
            key: KEY,
            value: 20,
            expectedCurrentValueDigest: digest(10),
          },
          supportingReceiptIds: [foreignMember.id],
          rationale: 'cite someone else',
        } as never,
        { ...world.ctx, ...call } as never,
      );
      expect(intent).toEqual(blockedWith('citation_out_of_scope'));
      expect((await authorizations(env, intent.id))[0].block_reason).toBe(
        'citation_out_of_scope',
      );
    });
  });

  it('a receipt in the emitting snapshot but not in the read set is part of the vector, and superseding it blocks the intent (C10)', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, KEY);
      const health = await observeObserved(env, world, 'checkout.health', {
        status: 'ok',
      });
      const metrics = await observeObserved(env, world, 'checkout.metrics', {
        errors: ['pool'],
      });
      const call = await emitCall(env, world, [member, health, metrics]);
      const intent = await env.actions.propose(
        {
          action: 'set_config',
          payload: {
            key: KEY,
            value: 20,
            expectedCurrentValueDigest: digest(10),
          },
          supportingReceiptIds: [],
          rationale: 'metrics showed pool errors',
        } as never,
        { ...world.ctx, ...call } as never,
      );
      expect(intent.dependencyVector.map((e) => e.receiptId)).toContain(
        metrics.id,
      );
      // the readset of the attempt never listed it
      const readSet = await env.admin.query(
        'SELECT read_set_receipt_ids FROM coordinator.task_attempts WHERE id = $1',
        [world.attemptId],
      );
      expect(readSet.rows[0].read_set_receipt_ids).not.toContain(metrics.id);
      await observeObserved(env, world, 'checkout.metrics', { errors: [] });
      const after = await intentRow(env, intent.id);
      expect(after).toMatchObject({
        status: 'blocked',
        block_reason: 'stale_version',
      });
      expect(await state(env)).toMatchObject({ value: 10, version: 1 });
    });
  });
});

describe('idempotency (C5)', () => {
  it('a replayed tool call with the same payload returns the stored intent; a tampered payload is blocked(idempotency_conflict)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { toolCallId: 'call_replay' });
      const again = await env.actions.propose(
        {
          action: 'set_config',
          payload: sc.payload,
          supportingReceiptIds: [sc.member.id],
          rationale: 'same call',
        } as never,
        { ...sc.world.ctx, ...sc.call } as never,
      );
      expect(again.id).toBe(sc.intent.id);
      const tampered = await env.actions.propose(
        {
          action: 'set_config',
          payload: { ...sc.payload, value: 5 },
          supportingReceiptIds: [sc.member.id],
          rationale: 'same call id, other value',
        } as never,
        { ...sc.world.ctx, ...sc.call } as never,
      );
      expect(tampered).toEqual(blockedWith('idempotency_conflict'));
      expect(tampered.id).not.toBe(sc.intent.id);
      expect((await authorizations(env, tampered.id))[0]).toMatchObject({
        block_reason: 'idempotency_conflict',
        idempotency_binding: 'conflict',
      });
      // the original is untouched and still the only live intent
      expect((await intentRow(env, sc.intent.id)).status).toBe('proposed');
      expect(
        await count(
          env.admin,
          "SELECT count(*) AS n FROM coordinator.action_intents WHERE status = 'proposed'",
        ),
      ).toBe(1);
      expect(await state(env)).toMatchObject({ value: 10, version: 1 });
    });
  });

  it('one tool call id is bound to one payload across targets and actions: a replay naming another key or action is blocked(idempotency_conflict)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { toolCallId: 'call_bound' });
      const other = await observeMember(env, sc.world, 'orders.write_enabled');
      const stats = await observeObserved(env, sc.world, 'redis.stats', {
        namespaces: {},
      });
      const call = await emitCall(
        env,
        sc.world,
        [sc.member, sc.health, other, stats],
        'call_bound_2',
      );
      void call;
      const reuse = { ...sc.world.ctx, ...sc.call } as never;
      const differentKey = await env.actions.propose(
        {
          action: 'set_config',
          payload: {
            key: 'orders.write_enabled',
            value: false,
            expectedCurrentValueDigest: digest(true),
          },
          supportingReceiptIds: [other.id],
          rationale: 'same call id, other key',
        } as never,
        reuse,
      );
      expect(differentKey).toEqual(blockedWith('idempotency_conflict'));
      const differentAction = await env.actions.propose(
        {
          action: 'flush_cache_namespace',
          payload: {
            namespace: 'catalog-a',
            reason: 'same call id, other action',
          },
          supportingReceiptIds: [],
          rationale: 'x',
        } as never,
        reuse,
      );
      expect(differentAction).toEqual(blockedWith('idempotency_conflict'));
      expect((await intentRow(env, sc.intent.id)).status).toBe('proposed');
    });
  });

  it('a new tool call re-proposing an identical payload after a block succeeds: blocked intents do not reserve the key', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { toolCallId: 'call_first' });
      await injectConfig(env, KEY, 11);
      await observeMember(env, sc.world, KEY, { marker: null });
      const blocked = await env.actions.admit(sc.intent.id, 'd1');
      expect(blocked.status).toBe('blocked');

      const member2 = await observeMember(env, sc.world, KEY);
      const health = await observeObserved(env, sc.world, 'checkout.health', {
        status: 'ok',
      });
      const call2 = await emitCall(
        env,
        sc.world,
        [member2, health],
        'call_second',
      );
      const second = await env.actions.propose(
        {
          action: 'set_config',
          payload: {
            key: KEY,
            value: 20,
            expectedCurrentValueDigest: digest(11),
          },
          supportingReceiptIds: [member2.id],
          rationale: 'retry with fresh evidence',
        } as never,
        { ...sc.world.ctx, ...call2 } as never,
      );
      expect(second.status).toBe('proposed');
      expect(second.idempotencyKey).not.toBe(sc.intent.idempotencyKey);
    });
  });

  it('the partial unique index: two live intents cannot share a key, a blocked one can', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const clone = (status: string) =>
        env.admin.query(
          `INSERT INTO coordinator.action_intents
             (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id, author_fencing_token,
              generation, action, adapter, payload, payload_hash, supporting_receipt_ids, target,
              actor_capability, dependency_vector, required_sources, expected_target_version,
              policy_version, idempotency_key, expires_at, rationale, status, block_reason)
           SELECT $1, mission_id, task_id, attempt_id, model_call_id, tool_call_id, author_fencing_token,
              generation, action, adapter, payload, payload_hash, supporting_receipt_ids, target,
              actor_capability, dependency_vector, required_sources, expected_target_version,
              policy_version, idempotency_key, expires_at, rationale, $2,
              CASE WHEN $2 = 'blocked' THEN 'stale_version' END
             FROM coordinator.action_intents WHERE id = $3`,
          [randomUUID(), status, sc.intent.id],
        );
      await expect(clone('proposed')).rejects.toMatchObject({ code: '23505' });
      await clone('blocked');
    });
  });
});

describe('closure-blocked intents are inspectable', () => {
  it('an ADMITTED intent blocked by a closure gets a commit-stage blocked Authorization that carries its dispatch fence as invalid', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await observeObserved(env, sc.world, 'checkout.health', {
        status: 'down',
      });
      expect(await intentRow(env, sc.intent.id)).toMatchObject({
        status: 'blocked',
        block_reason: 'stale_version',
      });
      const auths = await authorizations(env, sc.intent.id);
      expect(auths.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'commit:blocked',
      ]);
      const last = await env.admin.query(
        "SELECT dispatch_fence, checked_vector FROM coordinator.authorizations WHERE action_id = $1 AND decision = 'blocked'",
        [sc.intent.id],
      );
      expect(last.rows[0].dispatch_fence).toEqual({
        token: fence,
        valid: false,
      });
      expect(last.rows[0].checked_vector[0]).toMatchObject({
        sourceKey: 'checkout.health',
        receiptStatus: 'superseded',
      });
      await expect(
        env.actions.commitDetailed(sc.intent.id, fence),
      ).resolves.toMatchObject({ replayed: true, receipt: null });
    });
  });
});

describe('immutability and binding', () => {
  it('payload, target, vector, policy and key cannot change after the fact, for any role; authorizations are append-only', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await admitIntent(env, sc);
      for (const sql of [
        `UPDATE coordinator.action_intents SET payload = '{"key":"db.pool_max","value":99,"expectedCurrentValueDigest":"${'a'.repeat(64)}"}'::jsonb WHERE id = $1`,
        `UPDATE coordinator.action_intents SET target = '{"resource":"checkout","sourceKey":"checkout.config/orders.write_enabled","environment":"test"}'::jsonb WHERE id = $1`,
        `UPDATE coordinator.action_intents SET dependency_vector = '[]'::jsonb WHERE id = $1`,
        `UPDATE coordinator.action_intents SET expected_target_version = 7 WHERE id = $1`,
        `UPDATE coordinator.action_intents SET payload_hash = repeat('b', 64) WHERE id = $1`,
        `UPDATE coordinator.action_intents SET idempotency_key = repeat('c', 64) WHERE id = $1`,
      ])
        await expect(
          env.admin.query(sql, [sc.intent.id]),
        ).rejects.toMatchObject({
          code: '23000',
        });
      await expect(
        env.app.query(
          'UPDATE coordinator.authorizations SET decision = $1 WHERE action_id = $2',
          ['committed', sc.intent.id],
        ),
      ).rejects.toThrow();
      await expect(
        env.admin.query(
          'UPDATE coordinator.authorizations SET block_reason = NULL WHERE action_id = $1',
          [sc.intent.id],
        ),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(
        env.admin.query(
          'DELETE FROM coordinator.authorizations WHERE action_id = $1',
          [sc.intent.id],
        ),
      ).rejects.toMatchObject({ code: '23000' });
    });
  });
});

describe('scope isolation at admission (F4)', () => {
  it('an intent whose vector holds a receipt of another owner is blocked(citation_out_of_scope) at admission and at commit', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const foreignWorld = await createWorld(env);
      const foreign = await observeObserved(
        env,
        foreignWorld,
        'checkout.metrics',
        { errors: [] },
      );
      // forge a second live intent whose vector smuggles the foreign receipt
      // (the model-call path refuses it; this is the defence in depth)
      const vector = [
        ...sc.intent.dependencyVector,
        {
          sourceKey: 'checkout.metrics',
          sourceRevision: foreign.sourceRevision,
          receiptId: foreign.id,
        },
      ].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1));
      const forgedId = randomUUID();
      await env.admin.query(
        `INSERT INTO coordinator.action_intents
           (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id, author_fencing_token,
            generation, action, adapter, payload, payload_hash, supporting_receipt_ids, target,
            actor_capability, dependency_vector, required_sources, expected_target_version,
            policy_version, idempotency_key, expires_at, rationale, status)
         SELECT $1, mission_id, task_id, attempt_id, model_call_id, 'forged', author_fencing_token,
            generation, action, adapter, payload, payload_hash, supporting_receipt_ids, target,
            actor_capability, $2::jsonb, required_sources, expected_target_version,
            policy_version, repeat('d', 64), expires_at, rationale, 'proposed'
           FROM coordinator.action_intents WHERE id = $3`,
        [forgedId, JSON.stringify(vector), sc.intent.id],
      );
      const blocked = await env.actions.admit(forgedId as never, 'd1');
      expect(blocked).toEqual(blockedWith('citation_out_of_scope'));
      expect((await authorizations(env, forgedId))[0]).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'citation_out_of_scope',
      });
      // the honest intent of the same mission is unaffected
      expect((await env.actions.admit(sc.intent.id, 'd1')).status).toBe(
        'admitted',
      );
      expect(await state(env)).toMatchObject({ value: 10, version: 1 });
    });
  });
});

describe('admission', () => {
  it('admits with a durable dispatch lease and an admission authorization', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { admitted, fence } = await admitIntent(env, sc);
      expect(admitted.status).toBe('admitted');
      expect(fence).toBeGreaterThan(0);
      expect(admitted.dispatch?.owner).toBe('d1');
      expect(Date.parse(admitted.dispatch!.leaseExpiresAt)).toBeGreaterThan(
        Date.now(),
      );
      const [auth] = await authorizations(env, sc.intent.id);
      expect(auth).toMatchObject({ stage: 'admission', decision: 'admitted' });
      expect(await state(env)).toMatchObject({
        value: 10,
        version: 1,
        history: 1,
      });
    });
  });

  it('a duplicate admission delivery returns the stored decision and writes nothing', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const first = await admitIntent(env, sc);
      const again = await env.actions.admit(sc.intent.id, 'other-dispatcher');
      expect(again.status).toBe('admitted');
      expect(again.dispatch?.fence).toBe(first.fence);
      expect(again.dispatch?.owner).toBe('d1');
      expect(await authorizations(env, sc.intent.id)).toHaveLength(1);
    });
  });

  it('stale before admission: r2 registered, admit(r1) is blocked(stale_version), config unchanged (gate 2.1)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await injectConfig(env, KEY, 11);
      // marker: null isolates the ADMISSION predicate from the closure's immediate block
      await observeMember(env, sc.world, KEY, { marker: null });
      const result = await env.actions.admit(sc.intent.id, 'd1');
      expect(result).toEqual(blockedWith('stale_version'));
      expect((await authorizations(env, sc.intent.id))[0]).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
      });
      expect(await state(env)).toMatchObject({ value: 11, version: 2 });
      expect(await receiptsOf(env, sc.intent.id)).toHaveLength(0);
    });
  });

  it('the closure blocks a live intent immediately when evidence is superseded, before any admission', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const bystander = await proposeSetConfig(env, {
        key: 'orders.write_enabled',
        value: false,
      });
      await injectConfig(env, KEY, 11);
      await observeMember(env, sc.world, KEY); // default marker: the closure marks the intent
      expect(await intentRow(env, sc.intent.id)).toMatchObject({
        status: 'blocked',
        block_reason: 'stale_version',
      });
      // the closure-blocked intent is inspectable: an Authorization names the
      // reason, the superseded receipt and the moved version
      const auths = await env.admin.query(
        'SELECT stage, decision, block_reason, checked_vector, target_version, author_fence FROM coordinator.authorizations WHERE action_id = $1',
        [sc.intent.id],
      );
      expect(auths.rows).toHaveLength(1);
      expect(auths.rows[0]).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
        target_version: { expected: 1, live: 2 },
        author_fence: { token: 1, valid: true },
      });
      expect(auths.rows[0].checked_vector).toMatchObject([
        {
          sourceKey: 'checkout.config/db.pool_max',
          recordedRevision: 1,
          liveRevision: 2,
          receiptStatus: 'superseded',
        },
      ]);
      // and the mission's stream learns about it now: exactly one action.decided,
      // none for another mission
      const decided = await env.admin.query(
        "SELECT mission_id, payload FROM coordinator.events WHERE kind = 'action.decided' AND payload ->> 'actionId' = $1",
        [sc.intent.id],
      );
      expect(decided.rows).toHaveLength(1);
      expect(decided.rows[0].mission_id).toBe(sc.world.missionId);
      expect(
        EventPayloadSchema.safeParse(decided.rows[0].payload).success,
      ).toBe(true);
      expect(decided.rows[0].payload).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        blockReason: 'stale_version',
        targetVersion: { expected: 1, live: 2 },
        dispatchFence: null,
      });
      expect(
        await count(
          env.admin,
          "SELECT count(*) AS n FROM coordinator.events WHERE kind = 'action.decided' AND mission_id <> $1",
          [sc.world.missionId],
        ),
      ).toBe(0);
      expect((await intentRow(env, bystander.intent.id)).status).toBe(
        'proposed',
      );
      const again = await env.actions.admit(sc.intent.id, 'd1');
      expect(again.status).toBe('blocked');
      await expect(env.actions.commit(sc.intent.id, 1)).resolves.toMatchObject({
        status: 'blocked',
      });
      expect(await state(env)).toMatchObject({ value: 11, version: 2 });
    });
  });

  it('a version advanced without a receipt fails closed: blocked(stale_pending_observation) (G3)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await injectConfig(env, KEY, 11);
      const result = await env.actions.admit(sc.intent.id, 'd1');
      expect(result).toEqual(blockedWith('stale_pending_observation'));
      expect(await state(env)).toMatchObject({ value: 11, version: 2 });
    });
  });

  it('a missing required source or an irrelevant receipt in the vector is blocked(missing_required_source)', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, KEY);
      const metrics = await observeObserved(env, world, 'checkout.metrics', {
        errors: [],
      });
      const call = await emitCall(env, world, [member, metrics]);
      const intent = await env.actions.propose(
        {
          action: 'set_config',
          payload: {
            key: KEY,
            value: 20,
            expectedCurrentValueDigest: digest(10),
          },
          supportingReceiptIds: [metrics.id],
          rationale: 'health was never read',
        } as never,
        { ...world.ctx, ...call } as never,
      );
      expect(intent.status).toBe('proposed');
      const admitted = await env.actions.admit(intent.id, 'd1');
      expect(admitted).toEqual(blockedWith('missing_required_source'));
      expect(admitted.blockDetail).toContain('checkout.health');
    });
  });

  it('an aged health receipt without a confirmation is blocked(evidence_too_old); after a confirmation a fresh proposal admits (I2/D3)', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, KEY);
      const aged = await observeObserved(
        env,
        world,
        'checkout.health',
        { status: 'ok' },
        { observedAt: new Date(Date.now() - 10 * 60 * 1000) },
      );
      const call = await emitCall(env, world, [member, aged], 'call_aged');
      const propose = (c: typeof call, receipts: string[]) =>
        env.actions.propose(
          {
            action: 'set_config',
            payload: {
              key: KEY,
              value: 20,
              expectedCurrentValueDigest: digest(10),
            },
            supportingReceiptIds: receipts,
            rationale: 'health ok',
          } as never,
          { ...world.ctx, ...c } as never,
        );
      const first = await propose(call, []);
      expect(await env.actions.admit(first.id, 'd1')).toEqual(
        blockedWith('evidence_too_old'),
      );
      // the watcher polls the same value: a confirmation, not a new revision
      const confirmed = await observeObserved(env, world, 'checkout.health', {
        status: 'ok',
      });
      expect(confirmed.id).toBe(aged.id);
      const call2 = await emitCall(
        env,
        world,
        [member, confirmed],
        'call_conf',
      );
      const second = await propose(call2, []);
      const admitted = await env.actions.admit(second.id, 'd1');
      expect(admitted.status).toBe('admitted');
    });
  });

  it('a mission that is not running blocks admission (mission_not_running); a bumped generation blocks (generation_mismatch)', async () => {
    await withEnv(async (env) => {
      const paused = await proposeSetConfig(env);
      await env.admin.query(
        "UPDATE coordinator.missions SET status = 'paused' WHERE id = $1",
        [paused.world.missionId],
      );
      expect(await env.actions.admit(paused.intent.id, 'd1')).toEqual(
        blockedWith('mission_not_running'),
      );
      const bumped = await proposeSetConfig(env, {
        key: 'orders.write_enabled',
        value: false,
      });
      await env.admin.query(
        'UPDATE coordinator.missions SET generation = generation + 1 WHERE id = $1',
        [bumped.world.missionId],
      );
      expect(await env.actions.admit(bumped.intent.id, 'd1')).toEqual(
        blockedWith('generation_mismatch'),
      );
    });
  });

  it('an expired intent is blocked(expired)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await env.admin.query(
        'UPDATE coordinator.action_intents SET status = status WHERE id = $1',
        [sc.intent.id],
      );
      // expires_at is immutable by design; build an already-expired one through the owner path
      await env.admin.query(
        'ALTER TABLE coordinator.action_intents DISABLE TRIGGER action_intents_guard',
      );
      await env.admin.query(
        "UPDATE coordinator.action_intents SET expires_at = now() - interval '1 second' WHERE id = $1",
        [sc.intent.id],
      );
      await env.admin.query(
        'ALTER TABLE coordinator.action_intents ENABLE TRIGGER action_intents_guard',
      );
      expect(await env.actions.admit(sc.intent.id, 'd1')).toEqual(
        blockedWith('expired'),
      );
    });
  });
});

describe('commit (G1)', () => {
  it('commits through advanceConfig: version +1, the value, history with digests and the server-authored marker, receipt, outbox and events together', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.replayed).toBe(false);
      expect(result.intent.status).toBe('committed');
      expect(result.receipt).toMatchObject({
        outcome: 'committed',
        controlPlane: {
          targetVersionBefore: 1,
          targetVersionAfter: 2,
          causedByActionId: sc.intent.id,
        },
      });
      expect(await state(env)).toMatchObject({
        value: 20,
        version: 2,
        history: 2,
      });
      const history = (await configVersions(env, KEY))[1];
      expect(history).toMatchObject({
        version: 2,
        caused_by_action_id: sc.intent.id,
        caused_by_actor: 'action',
        before_digest: digest(10),
        after_digest: digest(20),
      });
      expect(result.receipt!.controlPlane!.afterDigest).toBe(digest(20));
      const head = await env.admin.query(
        'SELECT caused_by_action_id FROM checkout.config_entries WHERE key = $1',
        [KEY],
      );
      expect(head.rows[0].caused_by_action_id).toBe(sc.intent.id);
      expect(
        (await authorizations(env, sc.intent.id)).map(
          (a) => `${a.stage}:${a.decision}`,
        ),
      ).toEqual(['admission:admitted', 'commit:committed']);
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.outbox WHERE dedupe_key = $1',
          [`action.committed:${sc.intent.id}`],
        ),
      ).toBe(1);
      const kinds = await env.admin.query(
        "SELECT kind FROM coordinator.events WHERE kind LIKE 'action.%' ORDER BY id",
      );
      expect(kinds.rows.map((r) => r.kind)).toEqual([
        'action.proposed',
        'action.decided',
        'action.decided',
        'action.committed',
      ]);
    });
  });

  it('the marker cannot be forged: a non-app role writing the same key gets a null caused_by_action_id (I14)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await injectConfig(env, KEY, 12);
      const forged = await env.admin.query(
        `UPDATE checkout.config_entries SET caused_by_action_id = $2 WHERE key = $1
         RETURNING caused_by_action_id`,
        [KEY, sc.intent.id],
      );
      expect(forged.rows[0].caused_by_action_id).toBeNull();
    });
  });

  it('stale between admission and commit: the target advanced after admission, commit is blocked and nothing is written (C4, gate 2.2)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await injectConfig(env, KEY, 11);
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent).toEqual(blockedWith('stale_pending_observation'));
      expect(result.receipt).toBeNull();
      expect(await state(env)).toMatchObject({
        value: 11,
        version: 2,
        history: 2,
      });
      expect(
        (await configVersions(env, KEY)).every(
          (r) => r.caused_by_action_id === null,
        ),
      ).toBe(true);
      expect(await receiptsOf(env, sc.intent.id)).toHaveLength(0);
      expect((await authorizations(env, sc.intent.id)).pop()).toMatchObject({
        stage: 'commit',
        decision: 'blocked',
      });
    });
  });

  it('with the replacement registered the same race reports blocked(stale_version)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await injectConfig(env, KEY, 11);
      await observeMember(env, sc.world, KEY, { marker: null });
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent).toEqual(blockedWith('stale_version'));
      expect(await state(env)).toMatchObject({ value: 11, version: 2 });
    });
  });

  it('a NON-target required source superseded between admission and commit blocks the commit (C4)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await observeObserved(
        env,
        sc.world,
        'checkout.health',
        { status: 'degraded' },
        { marker: null },
      );
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent).toEqual(blockedWith('stale_version'));
      expect(await state(env)).toMatchObject({
        value: 10,
        version: 1,
        history: 1,
      });
    });
  });

  it('cross-resource vector: any one source of several is enough to block; a target-only CAS would have passed (gate 2.7)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      // the target is unchanged at version 1, so advanceConfig's own CAS would succeed
      expect(await liveConfig(env, KEY)).toMatchObject({ version: 1 });
      await observeObserved(
        env,
        sc.world,
        'checkout.health',
        { status: 'down' },
        { marker: null },
      );
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('blocked');
      expect(await liveConfig(env, KEY)).toMatchObject({
        value: 10,
        version: 1,
      });
    });
  });

  it('the commit waits on a registered-but-uncommitted supersession and then rejects (serialization recorded)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const registrar = await env.app.connect();
      try {
        await registrar.query('BEGIN');
        const { registerObservation } =
          await import('../../../../src/server/nemodots/ledger/index.js');
        await registerObservation(
          registrar,
          {
            source: {
              key: 'checkout.health',
              sourceType: 'observed_endpoint',
              authority: 'observed',
              scope: {
                ownerId: sc.world.ownerId,
                missionId: sc.world.missionId,
                spaceId: null,
                environment: 'test',
                resource: 'checkout',
              },
            } as never,
            normalizedValue: { status: 'down' },
            provenance: { kind: 'watcher' },
          },
          {
            marker: null,
            ledger: { events: createEventSink() },
          },
        );
        const commit = env.actions.commitDetailed(sc.intent.id, fence);
        await waitForLockWaiter(env.admin);
        await registrar.query('COMMIT');
        const result = await withTimeout(commit, 5_000, 'commit');
        expect(result.intent).toEqual(blockedWith('stale_version'));
        expect(await state(env)).toMatchObject({ value: 10, version: 1 });
      } finally {
        registrar.release();
      }
    });
  });

  it('stale-after-local-check (after_preliminary_read barrier): evidence superseded after the preliminary read is rejected by the locked re-check (gate 2.2)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const reached = latch();
      const resume = latch();
      setHook('after_preliminary_read', async () => {
        reached.open();
        await resume.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await reached.promise;
      await injectConfig(env, KEY, 11);
      await observeMember(env, sc.world, KEY, { marker: null });
      resume.open();
      const result = await withTimeout(commit, 5_000, 'commit');
      expect(result.intent).toEqual(blockedWith('stale_version'));
      expect(await state(env)).toMatchObject({ value: 11, version: 2 });
      expect(await receiptsOf(env, sc.intent.id)).toHaveLength(0);
    });
  });

  it('commit holds the target lock: an injector racing it serializes AFTER the commit; the action never mutates under the old version (gate 2.3)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const parked = latch();
      const resume = latch();
      setHook('after_lock_before_commit', async () => {
        parked.open();
        await resume.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await parked.promise;
      let injected = false;
      const injector = injectConfig(env, KEY, 99).then((r) => {
        injected = true;
        return r;
      });
      await waitForLockWaiter(env.admin);
      expect(injected).toBe(false);
      resume.open();
      await withTimeout(commit, 5_000, 'commit');
      const written = await withTimeout(injector, 5_000, 'injector');
      expect(written.versionBefore).toBe(2);
      expect(written.versionAfter).toBe(3);
      const history = await configVersions(env, KEY);
      expect(history.map((r) => [r.version, r.caused_by_action_id])).toEqual([
        [1, null],
        [2, sc.intent.id],
        [3, null],
      ]);
      expect(await state(env)).toMatchObject({ value: 99, version: 3 });
    });
  });

  it('the injector first, then the commit: the intent is rejected and no history row names the action', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await injectConfig(env, KEY, 99);
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('blocked');
      expect(await state(env)).toMatchObject({ value: 99, version: 2 });
      expect(
        (await configVersions(env, KEY)).filter((r) => r.caused_by_action_id),
      ).toHaveLength(0);
    });
  });

  it('two simultaneous identical commits (before_lock barrier): one mutation, one commit authorization, the same receipt id for both callers (C2)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const { barrier } = await import('../../helpers/barrier.js');
      const gate = barrier(2);
      setHook('before_lock', async () => {
        await gate.arrive();
      });
      const [a, b] = await withTimeout(
        Promise.all([
          env.actions.commitDetailed(sc.intent.id, fence),
          env.actions.commitDetailed(sc.intent.id, fence),
        ]),
        10_000,
        'two commits',
      );
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.receipt!.id).toBe(b.receipt!.id);
      expect(a.intent.status).toBe('committed');
      expect(b.intent.status).toBe('committed');
      expect(await state(env)).toMatchObject({
        value: 20,
        version: 2,
        history: 2,
      });
      expect(
        (await authorizations(env, sc.intent.id)).filter(
          (x) => x.stage === 'commit',
        ),
      ).toHaveLength(1);
      expect(await receiptsOf(env, sc.intent.id)).toHaveLength(1);
      expect(
        await count(
          env.admin,
          "SELECT count(*) AS n FROM coordinator.events WHERE kind = 'action.committed'",
        ),
      ).toBe(1);
    });
  });

  it('a duplicate delivery after the commit returns the stored receipt and writes nothing', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      const first = await env.actions.commitDetailed(sc.intent.id, fence);
      const authCount = (await authorizations(env, sc.intent.id)).length;
      const again = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(again.replayed).toBe(true);
      expect(again.receipt!.id).toBe(first.receipt!.id);
      expect((await authorizations(env, sc.intent.id)).length).toBe(authCount);
      expect(await state(env)).toMatchObject({
        value: 20,
        version: 2,
        history: 2,
      });
    });
  });

  it('per-resource independence: key B commits while key A is parked inside its commit and after A changed (gate 2.8)', async () => {
    await withEnv(async (env) => {
      const a = await proposeSetConfig(env, { key: KEY, value: 20 });
      const b = await proposeSetConfig(env, {
        key: 'orders.write_enabled',
        value: false,
      });
      const fenceA = (await admitIntent(env, a)).fence;
      const fenceB = (await admitIntent(env, b)).fence;
      const parked = latch();
      const resume = latch();
      setHook('after_lock_before_commit', async (context) => {
        if (context.actionId !== a.intent.id) return;
        parked.open();
        await resume.promise;
      });
      const commitA = env.actions.commitDetailed(a.intent.id, fenceA);
      await parked.promise;
      // A is parked holding its locks; B is not blocked by them
      const resultB = await withTimeout(
        env.actions.commitDetailed(b.intent.id, fenceB),
        5_000,
        'B must not wait for A',
      );
      expect(resultB.intent.status).toBe('committed');
      expect(await liveConfig(env, 'orders.write_enabled')).toMatchObject({
        value: false,
        version: 2,
      });
      resume.open();
      expect((await commitA).intent.status).toBe('committed');

      // and a change to A's source does not stop a third, independent key
      const c = await proposeSetConfig(env, {
        key: 'cache.schema_version',
        value: 2,
      });
      const fenceC = (await admitIntent(env, c)).fence;
      await injectConfig(env, KEY, 77);
      expect(
        (await env.actions.commitDetailed(c.intent.id, fenceC)).intent.status,
      ).toBe('committed');
    });
  });

  it('a stale dispatch fence or an expired dispatcher lease throws DispatchFenceError and writes nothing; a re-claim by a new dispatcher commits (C4, gate 2.15)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc, 'old-dispatcher');
      const authBefore = (await authorizations(env, sc.intent.id)).length;

      await expect(
        env.actions.commitDetailed(sc.intent.id, fence + 1000),
      ).rejects.toMatchObject({ reason: 'fence_mismatch' });

      await env.admin.query(
        "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [sc.intent.id],
      );
      const error = await env.actions
        .commitDetailed(sc.intent.id, fence)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DispatchFenceError);
      expect((error as DispatchFenceError).reason).toBe('lease_expired');
      expect(await state(env)).toMatchObject({
        value: 10,
        version: 1,
        history: 1,
      });
      expect((await authorizations(env, sc.intent.id)).length).toBe(authBefore);
      expect((await intentRow(env, sc.intent.id)).status).toBe('admitted');

      const reclaimed = await env.actions.reclaim(
        sc.intent.id,
        'new-dispatcher',
      );
      expect(reclaimed.status).toBe('admitted');
      expect(reclaimed.dispatch!.owner).toBe('new-dispatcher');
      expect(reclaimed.dispatch!.fence).toBeGreaterThan(fence);
      expect(
        (await authorizations(env, sc.intent.id)).filter(
          (a) => a.stage === 'admission',
        ),
      ).toHaveLength(2);

      // the old dispatcher is fenced out for good
      await expect(
        env.actions.commitDetailed(sc.intent.id, fence),
      ).rejects.toMatchObject({ reason: 'fence_mismatch' });
      const done = await env.actions.commitDetailed(
        sc.intent.id,
        reclaimed.dispatch!.fence,
      );
      expect(done.intent.status).toBe('committed');
      expect(await state(env)).toMatchObject({ value: 20, version: 2 });
    });
  });

  it('reclaimExpired re-admits only admitted intents whose lease expired, and a re-claim re-runs the predicates', async () => {
    await withEnv(async (env) => {
      const live = await proposeSetConfig(env);
      await admitIntent(env, live);
      const stale = await proposeSetConfig(env, {
        key: 'orders.write_enabled',
        value: false,
      });
      await admitIntent(env, stale);
      await env.admin.query(
        "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [stale.intent.id],
      );
      await injectConfig(env, 'orders.write_enabled', true);
      await observeMember(env, stale.world, 'orders.write_enabled', {
        marker: null,
      });
      const result = await env.actions.reclaimExpired('sweeper');
      expect(result.map((i) => i.id)).toEqual([stale.intent.id]);
      expect(result[0]).toEqual(blockedWith('stale_version'));
      expect((await intentRow(env, live.intent.id)).status).toBe('admitted');
    });
  });

  it("author and dispatcher lifecycles are separate: a completed author's proposal still commits, an expired author cannot propose again (gate 2.15)", async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await env.admin.query(
        "UPDATE coordinator.task_attempts SET status = 'published' WHERE id = $1",
        [sc.world.attemptId],
      );
      const { fence } = await admitIntent(env, sc);
      expect(
        (await env.actions.commitDetailed(sc.intent.id, fence)).intent.status,
      ).toBe('committed');
      const member = await observeMember(env, sc.world, KEY);
      const call = await emitCall(
        env,
        sc.world,
        [member, sc.health],
        'call_late',
      );
      await expect(
        env.actions.propose(
          {
            action: 'set_config',
            payload: sc.payload,
            supportingReceiptIds: [],
            rationale: 'late',
          } as never,
          { ...sc.world.ctx, ...call } as never,
        ),
      ).rejects.toBeInstanceOf(FenceError);
    });
  });

  it('cancellation: queued intents are cancelled, committed effects stay, and a commit after the generation bump is blocked', async () => {
    await withEnv(async (env) => {
      const done = await proposeSetConfig(env);
      const queued = await proposeSetConfig(env, {
        world: done.world,
        key: 'orders.write_enabled',
        value: false,
      });
      const admittedOnly = await proposeSetConfig(env, {
        world: done.world,
        key: 'cache.schema_version',
        value: 2,
      });
      const f1 = (await admitIntent(env, done)).fence;
      await env.actions.commitDetailed(done.intent.id, f1);
      const f3 = (await admitIntent(env, admittedOnly)).fence;
      await env.admin.query(
        'UPDATE coordinator.missions SET generation = generation + 1 WHERE id = $1',
        [done.world.missionId],
      );
      const cancelled = await env.actions.cancelQueued(
        done.world.missionId as never,
        1,
      );
      expect(cancelled.sort()).toEqual(
        [queued.intent.id, admittedOnly.intent.id].sort(),
      );
      expect((await intentRow(env, done.intent.id)).status).toBe('committed');
      expect((await intentRow(env, queued.intent.id)).status).toBe('cancelled');
      await expect(
        env.actions.commitDetailed(admittedOnly.intent.id, f3),
      ).rejects.toBeInstanceOf(DispatchFenceError);
      expect(await liveConfig(env, 'orders.write_enabled')).toMatchObject({
        version: 1,
      });
      const effects = await env.actions.intents.committedEffects(
        env.app as never,
        done.world.missionId as never,
      );
      expect(effects).toEqual([done.intent.id]);
    });
  });
});

describe('settlement from the version history (C7)', () => {
  const walk = async (env: Env, sc: Scenario) => {
    const { fence } = await admitIntent(env, sc);
    const done = await env.actions.commitDetailed(sc.intent.id, fence);
    return done.receipt!.controlPlane!;
  };

  it('a matching after-digest settles committed -> verified with a history postcondition', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const plane = await walk(env, sc);
      const settled = await env.actions.settleFromHistory(sc.intent.id, {
        afterDigest: plane.afterDigest,
        configVersion: 2,
      });
      expect(settled.status).toBe('verified');
      const receipt = (await receiptsOf(env, sc.intent.id))[0];
      expect(receipt).toMatchObject({
        outcome: 'verified',
        postcondition: { kind: 'history', configVersion: 2 },
      });
      // idempotent
      expect(
        (
          await env.actions.settleFromHistory(sc.intent.id, {
            afterDigest: 'x',
            configVersion: 9,
          })
        ).status,
      ).toBe('verified');
    });
  });

  it('a different after-digest is failed(postcondition_mismatch); a never-seen commit is failed(superseded_before_verification)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await walk(env, sc);
      const settled = await env.actions.settleFromHistory(sc.intent.id, {
        afterDigest: digest(999),
        configVersion: 2,
      });
      expect(settled).toMatchObject({
        status: 'failed',
        failureReason: 'postcondition_mismatch',
      });
      const other = await proposeSetConfig(env, {
        key: 'orders.write_enabled',
        value: false,
      });
      await walk(env, other);
      expect(await env.actions.settleSuperseded(other.intent.id)).toMatchObject(
        {
          status: 'failed',
          failureReason: 'superseded_before_verification',
        },
      );
    });
  });
});

describe('compensation', () => {
  it('creates a new proposed intent restoring the before value when the target has not moved', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await env.actions.commitDetailed(sc.intent.id, fence);
      await observeMember(env, sc.world, KEY); // the ledger has seen version 2
      const comp = await env.actions.compensate(sc.intent.id);
      expect(comp.status).toBe('proposed');
      expect(comp.payload).toMatchObject({ key: KEY, value: 10 });
      expect(comp.expectedTargetVersion).toBe(2);
      expect(comp.id).not.toBe(sc.intent.id);
      // it is an intent like any other: same key twice gives the same intent
      expect((await env.actions.compensate(sc.intent.id)).id).toBe(comp.id);
    });
  });

  it('when the version moved since the commit the compensation intent is recorded blocked(stale_version) with the moved version; the target is untouched (never overwrites a newer repair)', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await env.actions.commitDetailed(sc.intent.id, fence);
      await injectConfig(env, KEY, 55);
      const comp = await env.actions.compensate(sc.intent.id);
      expect(comp).toEqual(blockedWith('stale_version'));
      expect(comp.id).not.toBe(sc.intent.id);
      expect(comp.blockDetail).toContain('version 3');
      const [auth] = await authorizations(env, comp.id);
      expect(auth).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
      });
      const stored = await env.admin.query(
        'SELECT target_version FROM coordinator.authorizations WHERE action_id = $1',
        [comp.id],
      );
      expect(stored.rows[0].target_version).toEqual({ expected: 2, live: 3 });
      // nothing was queued for admission and the config is exactly what the other writer left
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.outbox WHERE dedupe_key = $1',
          [`action.proposed:${comp.id}`],
        ),
      ).toBe(0);
      expect(await state(env)).toMatchObject({
        value: 55,
        version: 3,
        history: 3,
      });
      // it can be asked again: a blocked intent does not reserve the key
      const again = await env.actions.compensate(sc.intent.id);
      expect(again.id).not.toBe(comp.id);
      expect(again.status).toBe('blocked');
    });
  });

  it('never claims to undo an irreversible effect (flush) or an uncommitted intent', async () => {
    await withEnv(async (env) => {
      const { proposeFlush } = await import('./harness.js');
      const flush = await proposeFlush(env);
      await expect(
        env.actions.compensate(flush.intent.id),
      ).rejects.toMatchObject({
        reason: 'irreversible',
      });
      const sc = await proposeSetConfig(env);
      await expect(env.actions.compensate(sc.intent.id)).rejects.toMatchObject({
        reason: 'not_committed',
      });
    });
  });
});
