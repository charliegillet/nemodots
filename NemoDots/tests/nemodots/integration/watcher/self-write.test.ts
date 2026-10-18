// Self-write classification against the config_versions history (ARCHITECTURE
// 5.4, finding C7): the watcher settles every marked intent from its own row
// and registers the head with the classification of the LAST row.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import { advanceConfig } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import {
  actionCommit,
  attemptStatus,
  configState,
  headOf,
  injectorWrite,
  insertCommittedIntent,
  intentStatus,
  ledgerEvents,
  missionReading,
  receiptsOf,
  recoveryKinds,
  taskStatus,
  withWatcherEnv,
  type WatcherEnv,
} from './harness.js';

const K = 'cache.namespace';
const member = (key: string) => `checkout.config/${key}`;

async function postconditionTasks(env: WatcherEnv, missionId: string) {
  const { rows } = await env.admin.query<{ id: string; status: string }>(
    `SELECT id, status FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'`,
    [missionId],
  );
  return rows;
}

/** Baseline + a mission with a proposer branch, another branch and an unrelated branch. */
async function setup(env: WatcherEnv) {
  const watcher = env.watcher();
  await watcher.runCycle();
  await watcher.runCycle();
  const mission = await missionReading(env, [
    [member(K)], // 0: the proposing lineage
    [member(K)], // 1: another branch that read the same revision
    [member('ui.banner_text')], // 2: unrelated
  ]);
  const actionId = await insertCommittedIntent(env, {
    mission,
    attemptIndex: 0,
    key: K,
    value: 'catalog-b',
  });
  return { watcher, mission, actionId };
}

describe('a verified self-write', () => {
  it('settles the intent from its history row, stamps the head receipt and routes recovery through a postcondition task', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, mission, actionId } = await setup(env);
      expect(
        await actionCommit(env, { actionId, key: K, value: 'catalog-b' }),
      ).toBe(2);

      // observe(), not runCycle(): the settlement sweep must not be what settles
      const [observed] = await watcher.observe([member(K)]);
      expect(observed).toMatchObject({
        outcome: 'registered',
        revision: 2,
        selfWrite: 'verified',
      });

      expect(env.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect(await intentStatus(env, actionId)).toEqual({
        status: 'verified',
        failureReason: null,
      });
      const receipts = await receiptsOf(env, member(K));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(receipts[1]).toMatchObject({
        selfWrite: 'verified',
        causedByActionId: actionId,
        provenanceKind: 'watcher',
        normalizedValue: { key: K, value: 'catalog-b', version: 2 },
      });
      expect(receipts[0]).toMatchObject({
        selfWrite: 'none',
        causedByActionId: null,
      });

      const [event] = await ledgerEvents(env, member(K));
      expect(event).toMatchObject({
        selfWrite: 'verified',
        reason: 'newer_observation',
      });
      // the other branch that read the old revision is invalidated (its premise
      // changed); an unrelated branch is untouched. Whether the PROPOSING
      // attempt is in this set is a ledger decision, see the expected-failure
      // tests at the end of this file.
      expect(event.affected.attemptIds).toContain(
        mission.attempts[1].attemptId,
      );
      expect(event.affected.attemptIds).not.toContain(
        mission.attempts[2].attemptId,
      );
      expect(await attemptStatus(env, mission.attempts[2].attemptId)).toBe(
        'running',
      );

      // recovery: exactly one postcondition task; the repair of the other
      // branch waits behind it (coalesced) instead of starting a repair storm
      const post = await postconditionTasks(env, mission.missionId);
      expect(post).toHaveLength(1);
      const kinds = await recoveryKinds(env, mission.missionId);
      expect(kinds.filter((k) => k === 'postcondition_scheduled')).toHaveLength(
        1,
      );
      expect(kinds).toContain('repair_coalesced');
      expect(kinds).not.toContain('repair_scheduled');
      expect(kinds).toContain('branch_preserved');

      // a second poll settles nothing again and registers nothing
      await watcher.runCycle();
      expect(env.settled).toHaveLength(1);
      expect(await receiptsOf(env, member(K))).toHaveLength(2);
    });
  });
});

describe('a self-write that does not match its intent', () => {
  it('fails the intent (postcondition_mismatch), registers selfWrite mismatch and invalidates everyone', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, mission, actionId } = await setup(env);
      // the intent says catalog-b; the row that carries its marker says otherwise
      await actionCommit(env, { actionId, key: K, value: 'catalog-other' });

      await watcher.observe([member(K)]);

      expect(env.settled).toEqual([{ actionId, outcome: 'failed' }]);
      expect(await intentStatus(env, actionId)).toEqual({
        status: 'failed',
        failureReason: 'postcondition_mismatch',
      });
      const head = await headOf(env, member(K));
      expect(head).toMatchObject({
        revision: 2,
        selfWrite: 'mismatch',
        causedByActionId: actionId,
      });
      const [event] = await ledgerEvents(env, member(K));
      expect(event).toMatchObject({
        reason: 'self_write_mismatch',
        selfWrite: 'mismatch',
      });
      expect([...event.affected.attemptIds].sort()).toEqual(
        [mission.attempts[0].attemptId, mission.attempts[1].attemptId].sort(),
      );
      // no postcondition gate: the mismatch is a plain full invalidation
      expect(await postconditionTasks(env, mission.missionId)).toEqual([]);
      const kinds = await recoveryKinds(env, mission.missionId);
      expect(kinds).toContain('repair_scheduled');
      expect(kinds).not.toContain('postcondition_scheduled');
    });
  });
});

describe('C7: the watcher was stopped while two writers changed the key', () => {
  it("registers revision 3 with selfWrite none, settles X from its own row and invalidates everyone including X's lineage", async () => {
    await withWatcherEnv(async (env) => {
      const { mission, actionId } = await setup(env);
      // watcher stopped: X commits v1 -> v2, then the injector writes v2 -> v3
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      await injectorWrite(env, K, 'catalog-injected');
      expect((await configState(env, K)).version).toBe(3);

      const restarted = env.watcher();
      const [observed] = await restarted.observe([member(K)]);
      expect(observed).toMatchObject({
        outcome: 'registered',
        revision: 3,
        selfWrite: 'none',
      });

      const receipts = await receiptsOf(env, member(K));
      // revision 2 never got a receipt: the watcher jumped from 1 to 3
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [3, 'supported'],
      ]);
      expect(receipts[1]).toMatchObject({
        selfWrite: 'none',
        causedByActionId: null,
        normalizedValue: { key: K, value: 'catalog-injected', version: 3 },
      });
      expect(env.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect((await intentStatus(env, actionId)).status).toBe('verified');

      const [event] = await ledgerEvents(env, member(K));
      expect(event.selfWrite).toBe('none');
      expect([...event.affected.attemptIds].sort()).toEqual(
        [mission.attempts[0].attemptId, mission.attempts[1].attemptId].sort(),
      );
      // full invalidation: X's lineage is repaired like everyone else (no gate holds it)
      const kinds = await recoveryKinds(env, mission.missionId);
      expect(
        kinds.filter((k) => k === 'repair_scheduled').length,
      ).toBeGreaterThanOrEqual(2);
      expect(kinds).not.toContain('repair_coalesced');
    });
  });
});

describe('what is not a self-write', () => {
  it('a forged marker from the injector role is nulled by the database: no settlement, selfWrite none', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, actionId } = await setup(env);
      const client = await env.injector.connect();
      try {
        await client.query('BEGIN');
        await advanceConfig(client, {
          key: K,
          value: 'catalog-b',
          expectedVersion: 1,
          causedBy: { actor: 'injector', actionId }, // forged
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const stored = await env.admin.query(
        'SELECT caused_by_action_id FROM checkout.config_versions WHERE key = $1 AND version = 2',
        [K],
      );
      expect(stored.rows[0].caused_by_action_id).toBeNull();

      await watcher.observe([member(K)]);
      expect(env.settled).toEqual([]);
      expect(await headOf(env, member(K))).toMatchObject({
        revision: 2,
        selfWrite: 'none',
        causedByActionId: null,
      });
      expect((await intentStatus(env, actionId)).status).toBe('committed');
    });
  });

  it('an action id no intent knows is not recognised: full invalidation, nothing settled', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher } = await setup(env);
      await actionCommit(env, {
        actionId: randomUUID(),
        key: K,
        value: 'catalog-b',
      });
      await watcher.runCycle();
      expect(env.settled).toEqual([]);
      expect(await headOf(env, member(K))).toMatchObject({
        revision: 2,
        selfWrite: 'none',
        causedByActionId: null,
      });
    });
  });
});

describe('the settlement sweep', () => {
  it('settles an intent whose revision a tool registered before the watcher saw it', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });

      // observe_source registers the new revision first (selfWrite none): the
      // ledger has moved past X's row, so the walk would never see it again
      const read = await env.readers.read(member(K) as never, {} as never);
      const client = await env.app.connect();
      try {
        await client.query('BEGIN');
        const base = (await receiptsOf(env, member(K)))[0];
        await registerObservation(client, {
          source: {
            key: member(K) as never,
            sourceType: 'controlled_config',
            authority: 'controlled',
            scope: {
              ownerId: 'owner',
              missionId: base.missionId as never,
              spaceId: null,
              environment: 'test',
              resource: 'checkout',
            },
          },
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'tool_call', toolCallId: 'tool-1' },
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await receiptsOf(env, member(K))).toHaveLength(2);
      expect(env.settled).toEqual([]);

      const cycle = await watcher.runCycle();
      expect(env.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect(cycle.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect((await intentStatus(env, actionId)).status).toBe('verified');
      // the sweep registers nothing
      expect(await receiptsOf(env, member(K))).toHaveLength(2);
    });
  });
});

describe('ordering of registration and settlement', () => {
  it('registers the head first; a crash before the settle call is repaired by the sweep of the next poll', async () => {
    await withWatcherEnv(async (env) => {
      const { actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      const seen: number[] = [];
      const watcher = env.watcher({
        recovery: {
          ...env.recovery,
          async onSelfWriteSettled(id, outcome) {
            seen.push((await receiptsOf(env, member(K))).length);
            // the process dies right after registering the head
            throw new Error(`crash before settling (${id}, ${outcome})`);
          },
        },
      });
      await watcher.observe([member(K)]);
      // the head (revision 2) existed when the settle ran: no postcondition
      // work can ever be scheduled against a head the ledger does not hold
      expect(seen).toEqual([2]);
      expect((await headOf(env, member(K))).selfWrite).toBe('verified');
      expect(await intentStatus(env, actionId)).toMatchObject({
        status: 'committed',
      });
      expect(
        env.events.filter((e) => e.type === 'error' && e.where === 'onSelfWriteSettled'),
      ).toHaveLength(1);

      // the walk never sees row 2 again (the ledger moved past it); the sweep
      // finds the committed intent and settles it from its own row
      const next = env.watcher();
      const cycle = await next.runCycle();
      expect(cycle.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect(env.settled).toEqual([{ actionId, outcome: 'verified' }]);
      expect((await intentStatus(env, actionId)).status).toBe('verified');
      expect(await receiptsOf(env, member(K))).toHaveLength(2);
    });
  });

  it('a foreign write that lands after the walk read its rows is classified from the rows read in the retry', async () => {
    await withWatcherEnv(async (env) => {
      const { actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      let hit = false;
      const intents = {
        ...env.intents,
        async expectedWrites(ids: readonly string[]) {
          const found = await env.intents.expectedWrites(ids as never);
          if (!hit) {
            hit = true;
            // after the history rows were read, before the registration
            await injectorWrite(env, K, 'catalog-injected');
          }
          return found;
        },
      };
      const watcher = createWatcher({
        pool: env.app,
        listenUrl: env.s.db.urls.app,
        readers: env.readers,
        recovery: env.recovery,
        intents,
        config: env.watcherConfig(),
        onEvent: (event) => env.events.push(event),
      });
      try {
        const [observed] = await watcher.observe([member(K)]);
        // the head the ledger holds is revision 3, written by the injector
        expect(observed).toMatchObject({
          outcome: 'registered',
          revision: 3,
          selfWrite: 'none',
        });
      } finally {
        await watcher.stop();
      }
      expect(await headOf(env, member(K))).toMatchObject({
        revision: 3,
        selfWrite: 'none',
        causedByActionId: null,
      });
      expect(env.settled).toEqual([{ actionId, outcome: 'verified' }]);
    });
  });
});

// ARCHITECTURE 5.4 prescribes two things the watcher cannot deliver alone,
// because the rows involved belong to the ledger closure and the coordinator:
//
//   verified  "the acting lineage (proposing attempt, its task, ancestors
//             awaiting the result) is not invalidated"
//   none      "full invalidation", and no postcondition gate: the head is not a
//             verified self-write
//
// Today the closure marks the proposer like any other reader, the coordinator
// replans its root task, and RecoveryPort.onSelfWriteSettled('verified') always
// schedules a postcondition task, also when a foreign write landed last. These
// are written as the behaviour 5.4 requires and marked with it.fails so that
// the suite states the deviation instead of asserting it. When the ledger /
// coordinator dependency lands, vitest reports each of them as unexpectedly
// passing: remove `.fails` then.
describe('ARCHITECTURE 5.4 expectations owned by the ledger and the coordinator', () => {
  it.fails('verified self-write: the proposing attempt and its task are not invalidated', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, mission, actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      await watcher.observe([member(K)]);
      expect(await attemptStatus(env, mission.attempts[0].attemptId)).not.toBe(
        'invalidated',
      );
      expect(await taskStatus(env, mission.attempts[0].taskId)).not.toBe(
        'invalidated',
      );
    });
  });

  it.fails('verified self-write: no replan is scheduled for the proposing root task', async () => {
    await withWatcherEnv(async (env) => {
      const { watcher, mission, actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      await watcher.observe([member(K)]);
      expect(await recoveryKinds(env, mission.missionId)).not.toContain(
        'replan_scheduled',
      );
    });
  });

  it.fails('C7 (a foreign write landed last): no postcondition task is scheduled', async () => {
    await withWatcherEnv(async (env) => {
      const { mission, actionId } = await setup(env);
      await actionCommit(env, { actionId, key: K, value: 'catalog-b' });
      await injectorWrite(env, K, 'catalog-injected');
      await env.watcher().observe([member(K)]);
      expect(await postconditionTasks(env, mission.missionId)).toEqual([]);
      expect(await recoveryKinds(env, mission.missionId)).not.toContain(
        'postcondition_scheduled',
      );
    });
  });
});
