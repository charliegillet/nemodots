// Proposal and admission against real PostgreSQL (TEST_PROMPT gate 2 items
// 1, 2, 5, 6, 7, 8 and the ledger findings C5, C10, I2, I8). Every test checks
// the authoritative version, the actual configuration value and the receipt
// rows together.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FenceError } from '../../../../src/server/nemodots/coordinator/errors.js';
import { setBarrier } from '../../../../src/server/nemodots/actions/index.js';
import {
  BASELINE,
  authorizations,
  configState,
  countRows,
  createAttempt,
  emitModelCall,
  expireAuthorLease,
  externalChange,
  intentRow,
  memberReceipt,
  observed,
  proposeCtx,
  proposePool,
  results,
  scenario,
  setConfigInput,
  tampering,
  valueDigest,
  withWorld,
  type World,
} from './harness.js';

async function unchanged(world: World, key = 'db.pool_max') {
  const state = await configState(world, key);
  expect(state.value).toBe(BASELINE[key]);
  expect(state.version).toBe(1);
  expect(state.causedBy).toBeNull();
}

describe('stale evidence before admission (gate 2 item 1)', () => {
  it('a change the watcher already registered blocks the intent at the closure and admission refuses it', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await externalChange(world, 'db.pool_max', 3);
      await memberReceipt(world, 'db.pool_max'); // r2 supersedes r1, closure runs
      const marked = await intentRow(world, proposed.id);
      expect(marked.status).toBe('blocked');
      expect(marked.block_reason).toBe('stale_version');

      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('blocked');
      expect(admitted.blockReason).toBe('stale_version');
      expect(admitted.dispatch).toBeNull();

      const state = await configState(world, 'db.pool_max');
      expect(state.value).toBe(3);
      expect(state.version).toBe(2);
      expect(state.causedBy).toBeNull();
      // The closure's block is a decision too: the trigger recorded it.
      const auth = await authorizations(world, proposed.id);
      expect(auth).toHaveLength(1);
      expect(auth[0]).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
      });
      expect(await results(world, proposed.id)).toEqual([]);
    });
  });

  it('a change nobody observed yet is caught by the target version check (G3)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await externalChange(world, 'db.pool_max', 3);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('blocked');
      expect(admitted.blockReason).toBe('stale_version');
      const state = await configState(world, 'db.pool_max');
      expect(state).toMatchObject({ value: 3, version: 2, causedBy: null });
      const [auth] = await authorizations(world, proposed.id);
      expect(auth).toMatchObject({
        stage: 'admission',
        decision: 'blocked',
        block_reason: 'stale_version',
        target_expected: '1',
        target_live: '2',
      });
      // The whole vector was examined, not just the target.
      expect(auth.checked_vector.map((c) => c.sourceKey)).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
      ]);
      expect(await results(world, proposed.id)).toEqual([]);
    });
  });
});

describe('stale between the preliminary read and the locks (gate 2 item 2)', () => {
  it('admission re-checks under lock what the preliminary read saw', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      let changed = false;
      setBarrier('after_preliminary_read', async (context) => {
        if (context.stage !== 'admit' || changed) return;
        changed = true;
        await externalChange(world, 'db.pool_max', 3);
        await memberReceipt(world, 'db.pool_max', { closure: false });
      });
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(changed).toBe(true);
      expect(admitted.status).toBe('blocked');
      expect(admitted.blockReason).toBe('stale_version');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 2,
        causedBy: null,
      });
    });
  });

  it('commit re-checks under lock what the admission saw', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      setBarrier('after_preliminary_read', async (context) => {
        if (context.stage !== 'commit') return;
        await externalChange(world, 'db.pool_max', 3);
        await memberReceipt(world, 'db.pool_max', { closure: false });
      });
      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('blocked');
      expect(committed.blockReason).toBe('stale_version');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 2,
        causedBy: null,
      });
      const auth = await authorizations(world, proposed.id);
      expect(auth.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'commit:blocked',
      ]);
      expect(await results(world, proposed.id)).toEqual([]);
    });
  });
});

describe('policy refusals at proposal (gate 2 items 5 and 6)', () => {
  it('a proposal without health evidence is blocked(missing_required_source)', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const call = await emitModelCall(world, attempt, [member]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }),
        {
          ...attempt.context,
          modelCallId: call.modelCallId,
          toolCallId: call.toolCallId,
        } as never,
      );
      expect(proposed.status).toBe('blocked');
      expect(proposed.blockReason).toBe('missing_required_source');
      expect(proposed.blockDetail).toContain('checkout.health');
      const [auth] = await authorizations(world, proposed.id);
      expect(auth).toMatchObject({ decision: 'blocked', stage: 'admission' });
      await unchanged(world);
    });
  });

  it('a valid receipt of an irrelevant source does not satisfy the policy', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const metrics = await observed(world, 'checkout.metrics', {
        classes: [],
      });
      const call = await emitModelCall(world, attempt, [member, metrics]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }),
        {
          ...attempt.context,
          modelCallId: call.modelCallId,
          toolCallId: call.toolCallId,
        } as never,
      );
      expect(proposed.blockReason).toBe('missing_required_source');
      await unchanged(world);
    });
  });

  it('a value outside the domain is blocked(payload_invalid)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 999);
      expect(proposed.status).toBe('blocked');
      expect(proposed.blockReason).toBe('payload_invalid');
      await unchanged(world);
    });
  });

  it('an attempt without the capability is blocked(capability_denied)', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world, {
        role: 'investigator',
        capabilities: ['observe'],
      });
      const s = await scenario(world, { attempt });
      const proposed = await proposePool(world, s, 20);
      expect(proposed.status).toBe('blocked');
      expect(proposed.blockReason).toBe('capability_denied');
      await unchanged(world);
    });
  });

  it('a cached flush is not a config change: its policy needs cache.namespace and redis.stats', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world, { role: 'cache_specialist' });
      const s = await scenario(world, { attempt });
      const proposed = await world.service.propose(
        {
          action: 'flush_cache_namespace',
          payload: { namespace: 'catalog-a', reason: 'stale blobs' },
          supportingReceiptIds: [],
          rationale: 'flush',
        },
        proposeCtx(s),
      );
      expect(proposed.status).toBe('blocked');
      expect(proposed.blockReason).toBe('missing_required_source');
      expect(proposed.blockDetail).toContain('redis.stats');
    });
  });
});

describe('tampering after the fact (gate 2 item 5)', () => {
  it.each([
    ['payload value', "payload = jsonb_set(payload, '{value}', '99')"],
    ['target environment', "target_environment = 'eval'"],
    ['expected target version', 'expected_target_version = 5'],
    ['policy version', "policy_version = 'policy-v1'"],
  ])('a changed %s is refused at admission', async (label, set) => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      if (label === 'policy version') {
        // The CHECK allows only policy-v1, so alter the vector instead.
        await tampering(world, () =>
          world.admin.query(
            `UPDATE coordinator.action_intents SET dependency_vector = '[]'::jsonb WHERE id = $1`,
            [proposed.id],
          ),
        );
      } else {
        await tampering(world, () =>
          world.admin.query(
            `UPDATE coordinator.action_intents SET ${set} WHERE id = $1`,
            [proposed.id],
          ),
        );
      }
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('blocked');
      expect(['payload_invalid', 'missing_required_source']).toContain(
        admitted.blockReason,
      );
      await unchanged(world);
    });
  });

  it('the guard trigger refuses to change a binding column, even for the owner', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      for (const pool of [world.app, world.admin])
        await expect(
          pool.query(
            `UPDATE coordinator.action_intents SET payload_hash = $2 WHERE id = $1`,
            [proposed.id, valueDigest(1)],
          ),
        ).rejects.toThrow(/immutable/);
      await expect(
        world.app.query(
          `UPDATE coordinator.action_intents SET status = 'verified' WHERE id = $1`,
          [proposed.id],
        ),
      ).rejects.toThrow(/illegal action transition/);
      await expect(
        world.app.query(`DELETE FROM coordinator.authorizations`),
      ).rejects.toThrow();
    });
  });

  it('an expired intent is blocked(expired)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await tampering(world, () =>
        world.admin.query(
          `UPDATE coordinator.action_intents SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [proposed.id],
        ),
      );
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.blockReason).toBe('expired');
      await unchanged(world);
    });
  });
});

describe('mission state at admission (finding C12)', () => {
  it('a paused mission blocks admission', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await world.admin.query(
        `UPDATE coordinator.missions SET status = 'paused' WHERE id = $1`,
        [world.missionId],
      );
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.blockReason).toBe('mission_not_running');
      await unchanged(world);
    });
  });

  it('a cancelled generation blocks admission', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await world.admin.query(
        `UPDATE coordinator.missions SET generation = generation + 1 WHERE id = $1`,
        [world.missionId],
      );
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.blockReason).toBe('generation_mismatch');
      await unchanged(world);
    });
  });
});

describe('freshness at admission (findings I2/D3)', () => {
  it('an aged health receipt without confirmation is evidence_too_old; a confirmation admits', async () => {
    await withWorld(async (world) => {
      const old = new Date(Date.now() - 200_000);
      const health = await observed(
        world,
        'checkout.health',
        { status: 'degraded' },
        old,
      );
      const stale = await scenario(world, { health });
      const first = await proposePool(world, stale, 20);
      expect(first.status).toBe('proposed');
      const refused = await world.service.admit(first.id, 'dispatcher-a');
      expect(refused.status).toBe('blocked');
      expect(refused.blockReason).toBe('evidence_too_old');
      const [blocked] = await authorizations(world, first.id);
      expect(
        blocked.checked_vector.find((c) => c.sourceKey === 'checkout.health')
          ?.freshnessOk,
      ).toBe(false);
      await unchanged(world);

      // The same health value observed again: a confirmation, no new revision.
      const again = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      expect(again.id).toBe(health.id);
      expect(again.sourceRevision).toBe(health.sourceRevision);
      const fresh = await scenario(world, { health: again });
      const second = await proposePool(world, fresh, 20);
      const admitted = await world.service.admit(second.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
    });
  });

  it('a confirmation that arrives before admission lets the same intent admit', async () => {
    await withWorld(async (world) => {
      const health = await observed(
        world,
        'checkout.health',
        { status: 'degraded' },
        new Date(Date.now() - 200_000),
      );
      const s = await scenario(world, { health });
      const proposed = await proposePool(world, s, 20);
      await observed(world, 'checkout.health', { status: 'degraded' });
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
    });
  });
});

describe('author fence at proposal (gate 2 item 9, finding C12)', () => {
  it('a lost author lease writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      await expireAuthorLease(world, s.attempt);
      const before = {
        intents: await countRows(world, 'coordinator.action_intents'),
        authorizations: await countRows(world, 'coordinator.authorizations'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
        edges: await countRows(world, 'ledger.dependency_edges'),
      };
      await expect(proposePool(world, s, 20)).rejects.toBeInstanceOf(
        FenceError,
      );
      expect({
        intents: await countRows(world, 'coordinator.action_intents'),
        authorizations: await countRows(world, 'coordinator.authorizations'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
        edges: await countRows(world, 'ledger.dependency_edges'),
      }).toEqual(before);
      await unchanged(world);
    });
  });

  it('a stale token, a finished attempt and a cancelled generation are fenced', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const input = setConfigInput(world, { value: 10 });
      await expect(
        world.service.propose(input, {
          ...proposeCtx(s),
          fencingToken: s.attempt.fencingToken + 1,
        } as never),
      ).rejects.toBeInstanceOf(FenceError);
      await expect(
        world.service.propose(input, {
          ...proposeCtx(s),
          generation: 4,
        } as never),
      ).rejects.toBeInstanceOf(FenceError);
      await world.admin.query(
        `UPDATE coordinator.task_attempts SET status = 'aborted', abort_reason = 'lease_lost' WHERE id = $1`,
        [s.attempt.attemptId],
      );
      await expect(
        world.service.propose(input, proposeCtx(s) as never),
      ).rejects.toBeInstanceOf(FenceError);
      expect(await countRows(world, 'coordinator.action_intents')).toBe(0);
    });
  });

  it('an author who finished still has its proposal admitted under a new dispatch lease (item 15)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      // The author completes: its attempt is no longer running.
      await world.admin.query(
        `UPDATE coordinator.task_attempts SET status = 'published' WHERE id = $1`,
        [s.attempt.attemptId],
      );
      const admitted = await world.service.admit(proposed.id, 'dispatcher-b');
      expect(admitted.status).toBe('admitted');
      expect(admitted.dispatch?.owner).toBe('dispatcher-b');
      // ...but a new proposal from the finished author is refused.
      await expect(
        world.service.propose(setConfigInput(world, { value: 5 }), {
          ...proposeCtx(s),
          toolCallId: 'another',
        } as never),
      ).rejects.toBeInstanceOf(FenceError);
    });
  });
});

describe('citation scope (finding I8)', () => {
  it('a receipt from another mission is blocked(citation_out_of_scope)', async () => {
    await withWorld(async (world) => {
      // Mission B's attempt cites a receipt that only mission A saw.
      const a = await scenario(world);
      const otherMissionId = randomUUID();
      await world.admin.query(
        `INSERT INTO coordinator.missions
           (id, owner_id, environment, resource, goal, mode, status, budgets, provider, started_at)
         VALUES ($1, 'owner-actions', 'test', 'checkout', 'other', 'fixture', 'running',
                 '{"maxTasks":24,"maxDepth":3,"maxBreadth":4,"maxTokens":1,"maxInferenceCalls":1,"maxWallClockMs":1}'::jsonb,
                 '{"host":"x","plannerModel":"p","workerModel":"w"}'::jsonb, now())`,
        [otherMissionId],
      );
      const attemptB = await createAttempt(world, {
        missionId: otherMissionId,
      });
      const memberB = await memberReceipt(world, 'db.pool_max');
      const healthB = await observed(world, 'checkout.health', {
        status: 'degraded',
        checks: { postgres: true },
      });
      const callB = await emitModelCall(world, attemptB, [memberB, healthB]);
      // A receipt of a source mission B never read: only mission A's call has it.
      const metricsA = await observed(world, 'checkout.metrics', { x: 1 });
      await emitModelCall(world, a.attempt, [a.member, a.health, metricsA]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }, { cite: [metricsA.id] }),
        {
          ...attemptB.context,
          modelCallId: callB.modelCallId,
          toolCallId: callB.toolCallId,
        } as never,
      );
      expect(proposed.status).toBe('blocked');
      expect(proposed.blockReason).toBe('citation_out_of_scope');
      expect(proposed.blockDetail).toContain(metricsA.id);
      // The foreign receipt is not part of the (blocked) intent's vector.
      expect(
        proposed.dependencyVector.some((e) => e.receiptId === metricsA.id),
      ).toBe(false);
      await unchanged(world);
    });
  });

  it('a citation in the readset or snapshot is accepted and added to the vector', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const metrics = await observed(world, 'checkout.metrics', { x: 1 });
      // metrics is in the attempt's readset, not in the call's snapshot.
      await world.admin.query(
        `UPDATE coordinator.task_attempts SET read_set_receipt_ids = $2::uuid[] WHERE id = $1`,
        [attempt.attemptId, [metrics.id]],
      );
      const call = await emitModelCall(world, attempt, [member, health]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }, { cite: [metrics.id] }),
        {
          ...attempt.context,
          modelCallId: call.modelCallId,
          toolCallId: call.toolCallId,
        } as never,
      );
      expect(proposed.status).toBe('proposed');
      expect(proposed.dependencyVector.map((e) => e.sourceKey)).toEqual([
        'checkout.config/db.pool_max',
        'checkout.health',
        'checkout.metrics',
      ]);
    });
  });
});

describe('inherited receipts are part of the vector (finding C10)', () => {
  it('a receipt in the emitting snapshot but not in the readset blocks the commit when superseded', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      // Inherited from a parent's handoff: in the context, never read here.
      const inherited = await observed(world, 'checkout.metrics', {
        errors: 1,
      });
      expect(
        (
          await world.admin.query(
            `SELECT read_set_receipt_ids FROM coordinator.task_attempts WHERE id = $1`,
            [attempt.attemptId],
          )
        ).rows[0].read_set_receipt_ids,
      ).toEqual([]);
      const call = await emitModelCall(world, attempt, [
        member,
        health,
        inherited,
      ]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }),
        {
          ...attempt.context,
          modelCallId: call.modelCallId,
          toolCallId: call.toolCallId,
        } as never,
      );
      expect(proposed.status).toBe('proposed');
      expect(proposed.dependencyVector.map((e) => e.receiptId)).toContain(
        inherited.id,
      );
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      // The watcher registers a newer metrics observation, but the closure has
      // not marked the intent yet: the commit's own predicates catch it.
      await observed(world, 'checkout.metrics', { errors: 99 }, undefined, {
        closure: false,
      });
      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('blocked');
      expect(committed.blockReason).toBe('stale_version');
      await unchanged(world);
    });
  });
});

describe('cross-resource vector and per-resource independence (items 7 and 8)', () => {
  it('a non-target required source superseded between admission and commit blocks the commit', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      await observed(world, 'checkout.health', { status: 'down' }, undefined, {
        closure: false,
      });
      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('blocked');
      expect(committed.blockReason).toBe('stale_version');
      // The target's own CAS would have passed: only the vector check fired.
      const [, commitAuth] = await authorizations(world, proposed.id);
      expect(commitAuth.target_live).toBe(commitAuth.target_expected);
      await unchanged(world);
    });
  });

  it('a cited config key that changes (unobserved) blocks even though it is not the target', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const other = await memberReceipt(world, 'db.statement_timeout_ms');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const call = await emitModelCall(world, attempt, [member, other, health]);
      const proposed = await world.service.propose(
        setConfigInput(world, { value: 10 }),
        {
          ...attempt.context,
          modelCallId: call.modelCallId,
          toolCallId: call.toolCallId,
        } as never,
      );
      expect(proposed.status).toBe('proposed');
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      await externalChange(world, 'db.statement_timeout_ms', 100);
      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('blocked');
      expect(committed.blockReason).toBe('stale_pending_observation');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 1,
      });
      expect(await configState(world, 'db.statement_timeout_ms')).toMatchObject(
        { value: 100, version: 2 },
      );
    });
  });

  it('key B commits while key A changed; A is blocked; neither waits for the other', async () => {
    await withWorld(async (world) => {
      const attemptA = await createAttempt(world);
      const attemptB = await createAttempt(world);
      const a = await scenario(world, { attempt: attemptA });
      const memberB = await memberReceipt(world, 'orders.write_enabled');
      const callB = await emitModelCall(world, attemptB, [memberB, a.health]);
      const proposedA = await proposePool(world, a, 20);
      const proposedB = await world.service.propose(
        setConfigInput(
          world,
          { value: true },
          { key: 'orders.write_enabled', value: false },
        ),
        {
          ...attemptB.context,
          modelCallId: callB.modelCallId,
          toolCallId: callB.toolCallId,
        } as never,
      );
      expect(proposedB.status).toBe('proposed');
      const admittedA = await world.service.admit(proposedA.id, 'dispatcher-a');
      const admittedB = await world.service.admit(proposedB.id, 'dispatcher-a');
      await externalChange(world, 'db.pool_max', 3); // key A changes
      const committedB = await world.service.commit(
        proposedB.id,
        admittedB.dispatch!.fence,
      );
      expect(committedB.status).toBe('committed');
      const committedA = await world.service.commit(
        proposedA.id,
        admittedA.dispatch!.fence,
      );
      expect(committedA.status).toBe('blocked');
      expect(await configState(world, 'orders.write_enabled')).toMatchObject({
        value: false,
        version: 2,
        causedBy: proposedB.id,
      });
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 2,
        causedBy: null,
      });
    });
  });
});
