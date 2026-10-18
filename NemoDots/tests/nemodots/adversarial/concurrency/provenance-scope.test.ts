// W5.2: incomplete provenance (an output that drops a recorded dependency)
// and cross-scope / cross-mission support (CONTRACTS 1 revision 3, I8, F4).
//
// BUILD_PROMPT: "Propagate the union of injected dependencies into outputs and
// handoffs conservatively; a specialist can add but not remove dependencies."
// ARCHITECTURE G2: a publication is accepted only if assertCurrent passes on
// its vector; G3: a controlled receipt is non-current from the authority's
// commit on, before any watcher runs.
import { describe, expect, it } from 'vitest';
import { createIntentReader } from '../../../../src/server/nemodots/actions/index.js';
import type { DependencyVector } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  addReadSet,
  publishFinding,
  publishOutput,
} from '../../../../src/server/nemodots/coordinator/publish.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  createSupportValidator,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  LEDGER,
  createWorld,
  emitCall,
  injectConfig,
  liveConfig,
  observeMember,
  observeObserved,
  setConfigInput,
  settle,
  sourceRef,
  withEnv,
  type Env,
} from './harness.js';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';

function publishDeps(env: Env) {
  return {
    pool: env.app,
    config: {},
    events: createEventSink(),
    supportValidator: createSupportValidator(),
    // edge writes are the ledger's; the property under test is the G2 check
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

// FINDING C-03 (medium). publishOutput / publishFinding assert currency of
// union(caller vector, inheritedDependencyVector) only
// (coordinator/publish.ts:218-223 and :566-583). The attempt's own recorded
// read set (task_attempts.read_set_vector, written by addReadSet) is not part
// of the vector, so a caller that passes a shorter vector publishes a usable
// output whose premise is already stale, inside the G3 window before the
// watcher registers the change. Today's only caller (team/worker-loop.ts:182)
// passes a conservative union, so this is a boundary gap rather than a live
// exploit path, but the coordinator is the enforcement point G2 names.
describe('FINDING C-03: an output that drops a recorded dependency', () => {
  async function staleReadSet(env: Env) {
    const world = await createWorld(env);
    const member = await observeMember(env, world, 'db.pool_max');
    await addReadSet(publishDeps(env), world.ctx, [entryOf(member)]);
    // the authority moves; the watcher has not run
    await injectConfig(env, 'db.pool_max', 3);
    return { world, member };
  }

  it('FINDING C-03a: publishOutput with a vector that omits the stale read is rejected', () =>
    withEnv(async (env) => {
      const { world } = await staleReadSet(env);
      const result = await settle(
        publishOutput(publishDeps(env), world.ctx, {
          kind: 'handoff',
          content: { summary: 'pool is fine at 10' },
          dependencyVector: [],
        }),
      );
      expect(result.ok).toBe(false);
      const { rows } = await env.admin.query(
        'SELECT count(*)::int AS n FROM coordinator.task_outputs WHERE attempt_id = $1',
        [world.attemptId],
      );
      expect(rows[0].n).toBe(0);
    }));

  it('FINDING C-03b: publishFinding with a vector that omits the stale read is rejected', () =>
    withEnv(async (env) => {
      const { world } = await staleReadSet(env);
      const result = await settle(
        publishFinding(publishDeps(env), world.ctx, {
          claim: 'db.pool_max is 10',
          supportingReceiptIds: [],
          confidence: 'high',
          dependencyVector: [],
        }),
      );
      expect(result.ok).toBe(false);
    }));

  it('cleared: the same output carrying its read is rejected (G3 before the watcher)', () =>
    withEnv(async (env) => {
      const { world, member } = await staleReadSet(env);
      const result = await settle(
        publishOutput(publishDeps(env), world.ctx, {
          kind: 'handoff',
          content: { summary: 'pool is fine at 10' },
          dependencyVector: [entryOf(member)],
        }),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.name).toBe('SupportError');
    }));
});

describe('cross-scope and cross-mission support', () => {
  // Receipts are per source, and a source is (owner, environment, Space,
  // resource, key): two missions in one scope share them by design. A foreign
  // receipt is therefore one from another scope.
  it('cleared: a receipt of a mission in another scope cannot be cited (citation_out_of_scope)', () =>
    withEnv(async (env) => {
      const a = await createWorld(env);
      const b = await createWorld(env);
      const foreign = await observeMember(env, a, 'db.pool_max');
      const own = await observeMember(env, b, 'db.pool_max');
      const health = (
        await observeObserved(env, b, 'checkout.health', { status: 'ok' })
      ).receipt;
      const input = setConfigInput(
        'db.pool_max',
        20,
        (await liveConfig(env, 'db.pool_max'))!.value,
        [foreign.id],
      );
      const call = await emitCall(env, b, [own, health], {
        argumentsDigest: digest(input),
      });
      const intent = await env.actions.propose(
        input as never,
        { ...b.ctx, ...call } as never,
      );
      expect(intent.status).toBe('blocked');
      expect(intent.blockReason).toBe('citation_out_of_scope');
    }));

  it('cleared: assertCurrent refuses a receipt from another Space for the same key', () =>
    withEnv(async (env) => {
      const owner = `owner-${Math.random().toString(16).slice(2)}`;
      const s1 = await createWorld(env, { ownerId: owner, spaceId: 'space-1' });
      const s2 = await createWorld(env, { ownerId: owner, spaceId: 'space-2' });
      const r1 = await observeMember(env, s1, 'db.pool_max');
      const r2 = await observeMember(env, s2, 'db.pool_max');
      expect(r1.id).not.toBe(r2.id);
      const result = await settle(
        withTransaction(env.app, (client) =>
          createSupportValidator().assertCurrent(client, [r1.id as never], {
            lockMode: 'share',
            missionId: s2.missionId,
          } as never),
        ),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && (result.error as { reason?: string }).reason).toBe(
        'citation_out_of_scope',
      );
    }));

  it('cleared: a supersession in one Space leaves the other Space receipt current', () =>
    withEnv(async (env) => {
      const owner = `owner-${Math.random().toString(16).slice(2)}`;
      const s1 = await createWorld(env, { ownerId: owner, spaceId: 'space-1' });
      const s2 = await createWorld(env, { ownerId: owner, spaceId: 'space-2' });
      const h1 = (
        await observeObserved(env, s1, 'checkout.health', { status: 'ok' })
      ).receipt;
      const h2 = (
        await observeObserved(env, s2, 'checkout.health', { status: 'ok' })
      ).receipt;
      await withTransaction(env.app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(s1, 'checkout.health'),
            normalizedValue: { status: 'degraded' },
            provenance: { kind: 'watcher' },
          },
          { ledger: LEDGER },
        ),
      );
      const { rows } = await env.admin.query(
        'SELECT id, status FROM ledger.observation_receipts WHERE id = ANY($1::uuid[])',
        [[h1.id, h2.id]],
      );
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status[h1.id]).toBe('superseded');
      expect(status[h2.id]).toBe('supported');
    }));
});
