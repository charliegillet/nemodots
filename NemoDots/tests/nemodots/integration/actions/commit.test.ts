// The commit transaction (TEST_PROMPT gate 2 items 3, 4, 10, 11, 15, 16 and
// findings C2, C4, C5): duplicate delivery, dispatcher leases and fences,
// serialisation against the injector, idempotency bound to the payload hash,
// and crashes at the named barriers.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  DispatchFenceError,
  SimulatedCrash,
  commitIntentDetailed,
  setBarrier,
} from '../../../../src/server/nemodots/actions/index.js';
import { barrier, latch, withTimeout } from '../../helpers/barrier.js';
import { advanceConfig } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  admitAndCommit,
  authorizations,
  configState,
  countRows,
  createAttempt,
  expireDispatcherLease,
  externalChange,
  historyRows,
  intentRow,
  memberReceipt,
  proposeCtx,
  proposePool,
  results,
  scenario,
  setConfigInput,
  sleep,
  waitForLockWaiters,
  withWorld,
  type World,
} from './harness.js';

async function snapshot(world: World, actionId: string) {
  return {
    config: await configState(world, 'db.pool_max'),
    history: (await historyRows(world, 'db.pool_max')).length,
    auth: await countRows(
      world,
      'coordinator.authorizations',
      'action_id = $1',
      [actionId],
    ),
    results: await countRows(
      world,
      'coordinator.result_receipts',
      'action_id = $1',
      [actionId],
    ),
    events: await countRows(world, 'coordinator.events'),
    intent: await intentRow(world, actionId),
  };
}

describe('duplicate delivery (gate 2 item 10, finding C2)', () => {
  it('two simultaneous identical commits: one mutation, one commit Authorization, one receipt id', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const fence = admitted.dispatch!.fence;
      const gate = barrier(2);
      setBarrier('before_lock', async (context) => {
        if (context.stage === 'commit') await gate.arrive();
      });
      const [first, second] = await withTimeout(
        Promise.all([
          commitIntentDetailed(world.deps, proposed.id, fence),
          commitIntentDetailed(world.deps, proposed.id, fence),
        ]),
        15_000,
        'two commits',
      );
      expect(gate.arrived).toBe(2);
      expect([first.disposition, second.disposition].sort()).toEqual([
        'committed',
        'duplicate',
      ]);
      expect(first.receipt?.id).toBeTruthy();
      expect(first.receipt?.id).toBe(second.receipt?.id);
      expect(first.intent.status).toBe('committed');
      expect(second.intent.status).toBe('committed');

      const state = await configState(world, 'db.pool_max');
      expect(state).toMatchObject({
        value: 20,
        version: 2,
        causedBy: proposed.id,
      });
      expect((await historyRows(world, 'db.pool_max')).length).toBe(2);
      const auth = await authorizations(world, proposed.id);
      expect(
        auth.filter((a) => a.stage === 'commit' && a.decision === 'committed'),
      ).toHaveLength(1);
      expect(auth.filter((a) => a.stage === 'commit')).toHaveLength(1);
      expect((await results(world, proposed.id)).map((r) => r.outcome)).toEqual(
        ['committed'],
      );
    });
  });

  it('a later duplicate returns the stored receipt and writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const fence = admitted.dispatch!.fence;
      const first = await commitIntentDetailed(world.deps, proposed.id, fence);
      const before = await snapshot(world, proposed.id);
      const again = await commitIntentDetailed(world.deps, proposed.id, fence);
      const other = await commitIntentDetailed(
        world.deps,
        proposed.id,
        fence + 7,
      );
      expect(again.disposition).toBe('duplicate');
      expect(other.disposition).toBe('duplicate');
      expect(again.receipt?.id).toBe(first.receipt?.id);
      const after = await snapshot(world, proposed.id);
      expect(after).toEqual(before);
    });
  });
});

describe('dispatcher lease and fence (gate 2 item 15, finding C4)', () => {
  it('an expired lease: the old dispatcher throws and writes nothing; a re-claiming dispatcher commits', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const oldAdmission = await world.service.admit(
        proposed.id,
        'dispatcher-old',
      );
      const oldFence = oldAdmission.dispatch!.fence;
      await expireDispatcherLease(world, proposed.id);

      const before = await snapshot(world, proposed.id);
      await expect(
        world.service.commit(proposed.id, oldFence),
      ).rejects.toMatchObject({
        name: 'DispatchFenceError',
        reason: 'lease_expired',
      });
      expect(await snapshot(world, proposed.id)).toEqual(before);

      // Any dispatcher may re-claim: the admission runs again.
      const reclaimed = await world.service.admit(
        proposed.id,
        'dispatcher-new',
      );
      expect(reclaimed.status).toBe('admitted');
      expect(reclaimed.dispatch?.owner).toBe('dispatcher-new');
      expect(reclaimed.dispatch!.fence).toBeGreaterThan(oldFence);
      const auth = await authorizations(world, proposed.id);
      expect(auth.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'admission:admitted',
      ]);

      // The old dispatcher is now fenced even with a fresh-looking lease.
      await expect(
        world.service.commit(proposed.id, oldFence),
      ).rejects.toMatchObject({ reason: 'fence_mismatch' });
      const committed = await world.service.commit(
        proposed.id,
        reclaimed.dispatch!.fence,
      );
      expect(committed.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
        causedBy: proposed.id,
      });
    });
  });

  it('a live lease is not stolen by a second admit', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const first = await world.service.admit(proposed.id, 'dispatcher-a');
      const second = await world.service.admit(proposed.id, 'dispatcher-b');
      expect(second.dispatch?.fence).toBe(first.dispatch?.fence);
      expect(second.dispatch?.owner).toBe('dispatcher-a');
      expect(await countRows(world, 'coordinator.authorizations')).toBe(1);
    });
  });

  it('a wrong fence, an intent that is not admitted and an unknown id are refused before any write', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await expect(world.service.commit(proposed.id, 1)).rejects.toMatchObject({
        reason: 'not_admitted',
      });
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const before = await snapshot(world, proposed.id);
      await expect(
        world.service.commit(proposed.id, admitted.dispatch!.fence + 1),
      ).rejects.toBeInstanceOf(DispatchFenceError);
      expect(await snapshot(world, proposed.id)).toEqual(before);
      await expect(
        world.service.commit(
          '00000000-0000-4000-8000-000000000000' as never,
          1,
        ),
      ).rejects.toMatchObject({ name: 'ActionNotFoundError' });
    });
  });
});

describe('serialisation against another writer (gate 2 item 3)', () => {
  it('the injector waits for a parked commit: commit first, injector second, nothing under the old version', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const parked = latch();
      const release = latch();
      setBarrier('after_lock_before_commit', async () => {
        parked.open();
        await release.promise;
      });
      const commit = world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      await withTimeout(parked.promise, 10_000, 'commit parked');
      // The injector now tries to advance the same key; it must wait.
      let injectorDone = false;
      const injector = externalChange(world, 'db.pool_max', 3).then(
        (version) => {
          injectorDone = true;
          return version;
        },
      );
      expect(await waitForLockWaiters(world, 1)).toBe(true);
      expect(injectorDone).toBe(false);
      release.open();
      const committed = await commit;
      const injectedVersion = await injector;
      expect(committed.status).toBe('committed');
      // Recorded serialisation order: the commit's version precedes the injector's.
      expect(injectedVersion).toBe(3);
      const history = await historyRows(world, 'db.pool_max');
      expect(
        history.map((row) => [row.version, row.caused_by_actor, row.value]),
      ).toEqual([
        [1, 'seed', 10],
        [2, 'action', 20],
        [3, 'injector', 3],
      ]);
      expect(history[1].caused_by_action_id).toBe(proposed.id);
      expect(history[2].caused_by_action_id).toBeNull();
    });
  });

  it('an injector write that wins the race leaves the stale commit blocked and the config at the injector value', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const parked = latch();
      const release = latch();
      setBarrier('before_lock', async (context) => {
        if (context.stage !== 'commit') return;
        parked.open();
        await release.promise;
      });
      const commit = world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      await withTimeout(parked.promise, 10_000, 'commit parked at before_lock');
      await externalChange(world, 'db.pool_max', 3);
      release.open();
      const committed = await commit;
      expect(committed.status).toBe('blocked');
      expect(committed.blockReason).toBe('stale_version');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 3,
        version: 2,
        causedBy: null,
      });
      const history = await historyRows(world, 'db.pool_max');
      expect(history.map((row) => row.version)).toEqual([1, 2]);
      expect(history.every((row) => row.caused_by_action_id === null)).toBe(
        true,
      );
    });
  });

  it('a registration racing a parked commit waits for it (G3 ordering)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      const parked = latch();
      const release = latch();
      setBarrier('after_lock_before_commit', async () => {
        parked.open();
        await release.promise;
      });
      const commit = world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      await withTimeout(parked.promise, 10_000, 'commit parked');
      // A new health observation (the vector's other source) is registered now.
      const { observed } = await import('./harness.js');
      const registration = observed(world, 'checkout.health', {
        status: 'down',
      });
      expect(await waitForLockWaiters(world, 1)).toBe(true);
      release.open();
      expect((await commit).status).toBe('committed');
      await registration;
      // The commit rested on the old health, validly: it serialised first.
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
      });
    });
  });
});

describe('idempotency bound to the payload hash (finding C5)', () => {
  it('the same tool call with the same payload returns the stored intent and writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      const before = {
        intents: await countRows(world, 'coordinator.action_intents'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
      };
      const again = await proposePool(world, s, 20);
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('proposed');
      expect({
        intents: await countRows(world, 'coordinator.action_intents'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
      }).toEqual(before);
    });
  });

  it('a replayed tool call id with a tampered payload is blocked(idempotency_conflict)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      const tampered = await proposePool(world, s, 99);
      expect(tampered.id).not.toBe(first.id);
      expect(tampered.status).toBe('blocked');
      expect(tampered.blockReason).toBe('idempotency_conflict');
      const [auth] = await authorizations(world, tampered.id);
      expect(auth.idempotency_binding).toBe('conflict');
      // The original is untouched and still live.
      expect((await intentRow(world, first.id)).status).toBe('proposed');
      // Replaying the tampered call again returns the stored conflict.
      const replay = await proposePool(world, s, 99);
      expect(replay.id).toBe(tampered.id);
      expect(await countRows(world, 'coordinator.action_intents')).toBe(2);
      await world.service.admit(first.id, 'dispatcher-a');
    });
  });

  it('a new tool call re-proposing an identical payload after a block succeeds', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      await externalChange(world, 'db.pool_max', 3);
      const blocked = await world.service.admit(first.id, 'dispatcher-a');
      expect(blocked.status).toBe('blocked');

      // Fresh evidence read by a repair attempt (the old one was invalidated
      // by the closure), a new emitting call and tool call, the same value.
      const repair = await createAttempt(world);
      const retry = await scenario(world, { attempt: repair });
      const second = await proposePool(world, retry, 20);
      expect(second.status).toBe('proposed');
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
      const done = await admitAndCommit(world, second.id);
      expect(done.committed.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 3,
        causedBy: second.id,
      });
    });
  });

  it('a concurrent replay of one tool call yields exactly one live intent', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const state = await configState(world, 'db.pool_max');
      const input = setConfigInput(world, state, { value: 20 });
      const ids = await Promise.all(
        Array.from({ length: 4 }, () =>
          world.service.propose(input, proposeCtx(s)),
        ),
      );
      expect(new Set(ids.map((intent) => intent.id)).size).toBe(1);
      expect(await countRows(world, 'coordinator.action_intents')).toBe(1);
      expect(
        await countRows(
          world,
          'coordinator.outbox',
          "topic = 'action.proposed'",
        ),
      ).toBe(1);
    });
  });

  it('the live-status unique index backs the check: a second live row with the key is impossible', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      await expect(
        world.admin.query(
          `INSERT INTO coordinator.action_intents
             (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
              author_fencing_token, generation, action, adapter, payload, payload_hash,
              target_resource, target_source_key, target_environment, actor_capability,
              dependency_vector, required_sources, expected_target_version, policy_version,
              idempotency_key, expires_at, rationale, status)
           SELECT gen_random_uuid(), mission_id, task_id, attempt_id, model_call_id, tool_call_id,
                  author_fencing_token, generation, action, adapter, payload, payload_hash,
                  target_resource, target_source_key, target_environment, actor_capability,
                  dependency_vector, required_sources, expected_target_version, policy_version,
                  idempotency_key, expires_at, rationale, 'proposed'
             FROM coordinator.action_intents WHERE id = $1`,
          [first.id],
        ),
      ).rejects.toThrow(/action_intents_idempotency_live_idx/);
    });
  });
});

describe('the self-write marker is server-authored (gate 2 item 16)', () => {
  it('only the application role can set caused_by_action_id; the injector cannot', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      // The injector claims an action id on its own write: the trigger nulls it.
      await withTransaction(world.injector, (client) =>
        advanceConfig(client, {
          key: 'db.pool_max',
          value: 3,
          expectedVersion: 1,
          causedBy: { actor: 'injector', actionId: proposed.id },
        }),
      );
      const state = await configState(world, 'db.pool_max');
      expect(state).toMatchObject({ value: 3, version: 2, causedBy: null });
      const history = await historyRows(world, 'db.pool_max');
      expect(history.every((row) => row.caused_by_action_id === null)).toBe(
        true,
      );
    });
  });

  it('a committed action leaves the marker on both the head and the history row', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await admitAndCommit(world, proposed.id);
      expect((await configState(world, 'db.pool_max')).causedBy).toBe(
        proposed.id,
      );
      const history = await historyRows(world, 'db.pool_max');
      expect(history[history.length - 1].caused_by_action_id).toBe(proposed.id);
    });
  });
});

describe('NOTIFY on proposal (finding C15)', () => {
  it('emits nemodots_action_proposed with the target key only, for live proposals only', async () => {
    await withWorld(async (world) => {
      const listener = new pg.Client({
        connectionString: world.db.urls.injector,
      });
      await listener.connect();
      const seen: string[] = [];
      listener.on('notification', (message) => {
        if (message.channel === 'nemodots_action_proposed' && message.payload)
          seen.push(message.payload);
      });
      await listener.query('LISTEN nemodots_action_proposed');
      try {
        const s = await scenario(world);
        const blocked = await proposePool(world, s, 999);
        expect(blocked.status).toBe('blocked');
        await sleep(150);
        expect(seen).toEqual([]);
        const call2 = await (
          await import('./harness.js')
        ).emitModelCall(world, s.attempt, [s.member, s.health]);
        const live = await world.service.propose(
          setConfigInput(world, { value: 10 }, { value: 20 }),
          { ...s.attempt.context, ...call2 } as never,
        );
        expect(live.status).toBe('proposed');
        const deadline = Date.now() + 5000;
        while (seen.length === 0 && Date.now() < deadline) await sleep(25);
        expect(seen).toEqual(['checkout.config/db.pool_max']);
      } finally {
        await listener.end();
      }
    });
  });
});

describe('crash at each barrier: reconcile tells the states apart (gate 2 item 11)', () => {
  it('a crash at before_lock leaves the intent admitted and the configuration untouched', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      setBarrier('before_lock', (context) => {
        if (context.stage === 'commit') throw new SimulatedCrash('before_lock');
      });
      await expect(
        world.service.commit(proposed.id, admitted.dispatch!.fence),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      const reconciled = await world.service.reconcile(proposed.id);
      expect(reconciled.status).toBe('admitted');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 1,
        causedBy: null,
      });
      expect(await results(world, proposed.id)).toEqual([]);
    });
  });

  it('a crash at after_lock_before_commit rolls everything back: still admitted, no mutation, no receipt', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      setBarrier('after_lock_before_commit', () => {
        throw new SimulatedCrash('after_lock_before_commit');
      });
      await expect(
        world.service.commit(proposed.id, admitted.dispatch!.fence),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect((await world.service.reconcile(proposed.id)).status).toBe(
        'admitted',
      );
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 1,
        causedBy: null,
      });
      expect(await historyRows(world, 'db.pool_max')).toHaveLength(1);
      expect(await results(world, proposed.id)).toEqual([]);
      expect(await authorizations(world, proposed.id)).toHaveLength(1);
      // The same fence still commits once the crash is gone.
      setBarrier('after_lock_before_commit', null);
      const committed = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(committed.status).toBe('committed');
    });
  });

  it('a crash at after_commit_before_dispatch leaves a committed intent whose effect exists exactly once', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
      setBarrier('after_commit_before_dispatch', () => {
        throw new SimulatedCrash('after_commit_before_dispatch');
      });
      await expect(
        world.service.commit(proposed.id, admitted.dispatch!.fence),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      const reconciled = await world.service.reconcile(proposed.id);
      expect(reconciled.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
        causedBy: proposed.id,
      });
      // A redelivered commit does not apply it twice.
      const again = await world.service.commit(
        proposed.id,
        admitted.dispatch!.fence,
      );
      expect(again.status).toBe('committed');
      expect((await historyRows(world, 'db.pool_max')).length).toBe(2);
    });
  });
});
