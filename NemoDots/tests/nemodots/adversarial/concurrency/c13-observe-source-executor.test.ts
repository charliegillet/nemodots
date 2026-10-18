// C13 (low), through the REAL observe_source executor (team/observer.ts), not
// only through ledger.recordReadSet. The executor reads the source outside any
// transaction, then in ONE transaction registers or confirms the receipt (the
// sources row locked), records the evidence edge receipt -> attempt and appends
// its events, inside a bounded retry loop (MAX_RACE_ATTEMPTS = 3) for
// "the authority moved between the read and the registration".
//
// Expected (ARCHITECTURE 5.2, 14 C13): the edge insert is serialized with a
// concurrent supersession by the sources row lock and the config-row share
// locks of recordReadSet, so after both commit no RUNNING attempt keeps an
// evidence edge from a superseded receipt; a registration that lost the race
// (stale / mismatched / digest-mismatched) is re-read, never blindly retried
// with the same value, and gives up with a typed source_unavailable after the
// bound without leaving an edge.
//
// Park points inside the executor's transaction need no production change: the
// executor takes an EventSinkPort, and the events are appended AFTER the edge
// insert and BEFORE COMMIT with every lock held. The sink double below parks on
// the executor's tool_call.recorded event and otherwise delegates to the real
// sink. Doubles are labelled: the source reader (reads the real authority rows,
// or scripts a read that is overtaken by a write) and the mission facts reader.
//
// CW-5 (call-site obligation): the executor must never forward a selfWrite
// marker or an action id into the registration. Checked dynamically (the stored
// receipt) and statically (the executor source names neither in its
// registration input).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/index.js';
import type {
  EventSinkPort,
  SourceKey,
  SourceReaderPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createLedgerObserver } from '../../../../src/server/nemodots/team/observer.js';
import {
  OWNER,
  authorityReader,
  collectionReceipt,
  createAttempt,
  emitModelCall,
  externalChange,
  latch,
  memberReceipt,
  observed,
  registerObserved,
  waitForLockWaiters,
  withWorld,
  type Attempt,
  type EmittedCall,
  type World,
} from './harness.js';

type Read = SourceReaderPort['read'];

const MEMBER = 'checkout.config/db.pool_max' as SourceKey;
const HEALTH = 'checkout.health' as SourceKey;

/** The real executor over the real ledger; only the reader and the mission facts are doubles. */
function executor(
  world: World,
  options: {
    read?: (key: SourceKey, base: SourceReaderPort) => ReturnType<Read>;
    events?: EventSinkPort;
  } = {},
) {
  const base = authorityReader(world);
  const readers: SourceReaderPort = {
    read: (key, scope) =>
      options.read ? options.read(key, base) : base.read(key, scope),
  };
  const facts = {
    scope: {
      ownerId: OWNER,
      missionId: world.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    goal: 'restore the checkout',
    constraints: [],
  };
  return createLedgerObserver({
    pool: world.app,
    readers,
    reader: { mission: async () => facts } as never,
    events: options.events ?? createEventSink(),
  });
}

async function setup(world: World) {
  const attempt = await createAttempt(world);
  const call = await emitModelCall(world, attempt, []);
  return { attempt, call };
}

const observe = (
  observer: ReturnType<typeof executor>,
  attempt: Attempt,
  call: EmittedCall,
  sourceKey: SourceKey,
) =>
  observer.observe({
    context: attempt.context,
    sourceKey,
    toolCallId: call.toolCallId,
    modelCallId: call.modelCallId as never,
  });

/** An event sink that parks the executor's transaction on its tool_call.recorded event. */
function parkingSink() {
  const reached = latch();
  const gate = latch();
  const real = createEventSink();
  const sink: EventSinkPort = {
    async append(client, event) {
      if (event.kind === 'tool_call.recorded') {
        reached.open(undefined);
        await gate.promise;
      }
      return real.append(client, event);
    },
  };
  return {
    sink,
    reached: reached.promise,
    release: () => gate.open(undefined),
  };
}

async function attemptStatus(world: World, attemptId: string) {
  const { rows } = await world.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.task_attempts WHERE id = $1',
    [attemptId],
  );
  return rows[0].status;
}

/** Source revisions of the receipts the attempt rests on (evidence edges receipt -> attempt). */
async function readSetRevisions(world: World, attemptId: string) {
  const { rows } = await world.admin.query<{
    key: string;
    source_revision: number;
    status: string;
  }>(
    `SELECT s.key, r.source_revision, r.status
       FROM ledger.dependency_edges e
       JOIN ledger.observation_receipts r ON r.id = e.from_id
       JOIN ledger.sources s ON s.id = r.source_id
      WHERE e.to_kind = 'attempt' AND e.to_id = $1
        AND e.from_kind = 'receipt' AND e.kind = 'evidence'
      ORDER BY s.key, r.source_revision`,
    [attemptId],
  );
  return rows;
}

/** Running attempts holding an evidence edge from a superseded receipt (must be empty). */
async function unmarkedReaders(world: World) {
  const { rows } = await world.admin.query<{ attempt_id: string }>(
    `SELECT a.id AS attempt_id
       FROM coordinator.task_attempts a
       JOIN ledger.dependency_edges e ON e.to_kind = 'attempt' AND e.to_id = a.id
            AND e.from_kind = 'receipt' AND e.kind = 'evidence'
       JOIN ledger.observation_receipts r ON r.id = e.from_id
      WHERE a.status = 'running' AND r.status = 'superseded'`,
  );
  return rows.map((row) => row.attempt_id);
}

describe('C13 through the real observe_source executor', () => {
  it('observed source: a superseding registration issued while the executor is parked inside its transaction waits for it, then marks the reading attempt', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      await observed(world, HEALTH as 'checkout.health', {
        status: 'degraded',
      });
      const parked = parkingSink();
      const observer = executor(world, {
        events: parked.sink,
        read: async (key, base) =>
          key === HEALTH
            ? {
                normalizedValue: { status: 'degraded' },
                raw: null,
                revisionHint: null,
              }
            : base.read(key, {} as never),
      });
      const observing = observe(observer, attempt, call, HEALTH);
      await parked.reached; // edge written, sources row locked, uncommitted
      const registration = registerObserved(world, 'checkout.health', {
        status: 'ok',
      });
      await waitForLockWaiters(world, 1);
      // The supersession cannot have landed ahead of the executor.
      expect(await readSetRevisions(world, attempt.attemptId)).toEqual([]);
      parked.release();
      const [seen, superseding] = await Promise.all([observing, registration]);
      expect(seen.newRevision).toBe(false); // an unchanged value is a confirmation
      expect(superseding.newRevision).toBe(true);
      expect(
        superseding.invalidation?.perMission.flatMap(
          (m) => m.affected.attemptIds,
        ),
      ).toContain(attempt.attemptId);
      expect(await attemptStatus(world, attempt.attemptId)).toBe('invalidated');
      expect(await unmarkedReaders(world)).toEqual([]);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('controlled member: an injector write issued while the executor is parked waits on the config-row share lock; the executor reports the revision it read, the closure then marks the attempt', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      await collectionReceipt(world); // the collection source must exist for a member registration
      const parked = parkingSink();
      const observer = executor(world, { events: parked.sink });
      const observing = observe(observer, attempt, call, MEMBER);
      await parked.reached;
      const write = externalChange(world, 'db.pool_max', 14);
      await waitForLockWaiters(world, 1);
      parked.release();
      const [seen, version] = await Promise.all([observing, write]);
      expect(seen.sourceRevision).toBe(1);
      expect(version).toBe(2);
      // The watcher's registration of the new revision finds the edge.
      const registered = await memberReceipt(world, 'db.pool_max');
      expect(registered.sourceRevision).toBe(2);
      expect(await attemptStatus(world, attempt.attemptId)).toBe('invalidated');
      expect(await unmarkedReaders(world)).toEqual([]);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('a registration overtaken by a write between the read and the registration is re-read: the attempt rests on the live revision only', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      await collectionReceipt(world);
      let reads = 0;
      const observer = executor(world, {
        read: async (key, base) => {
          const snapshot = await base.read(key, {} as never);
          // Overtaken exactly once, after the value was read and before it is registered.
          if (key === MEMBER && (reads += 1) === 1)
            await externalChange(world, 'db.pool_max', 14);
          return snapshot;
        },
      });
      const seen = await observe(observer, attempt, call, MEMBER);
      expect(reads).toBe(2);
      expect(seen.sourceRevision).toBe(2);
      expect(seen.normalizedValue).toMatchObject({ value: 14, version: 2 });
      const rest = await readSetRevisions(world, attempt.attemptId);
      expect(rest).toEqual([
        { key: MEMBER, source_revision: 2, status: 'supported' },
      ]);
      // The stale revision was never registered as a receipt.
      const { rows } = await world.admin.query(
        `SELECT 1 FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = $1 AND r.source_revision = 1`,
        [MEMBER],
      );
      expect(rows).toHaveLength(0);
      expect(await attemptStatus(world, attempt.attemptId)).toBe('running');
      expect(await unmarkedReaders(world)).toEqual([]);
    });
  });

  it('a source that keeps changing exhausts the bounded loop: a typed source_unavailable, no edge, no blind retry with the stale value', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      await collectionReceipt(world);
      let reads = 0;
      const observer = executor(world, {
        read: async (key, base) => {
          const snapshot = await base.read(key, {} as never);
          if (key === MEMBER) {
            reads += 1;
            await externalChange(world, 'db.pool_max', 14 + reads);
          }
          return snapshot;
        },
      });
      await expect(
        observe(observer, attempt, call, MEMBER),
      ).rejects.toMatchObject({
        name: 'ToolError',
        code: 'source_unavailable',
      });
      expect(reads).toBe(3); // MAX_RACE_ATTEMPTS
      expect(await readSetRevisions(world, attempt.attemptId)).toEqual([]);
      expect(await attemptStatus(world, attempt.attemptId)).toBe('running');
    });
  });

  it('property: 12 executor observations racing 6 supersessions of the same observed source never leave a running attempt on a superseded receipt', async () => {
    await withWorld(async (world) => {
      await observed(world, 'checkout.health', { status: 'v0' });
      const pairs = await Promise.all(
        Array.from({ length: 12 }, () => setup(world)),
      );
      let value = 0;
      const observer = executor(world, {
        read: async (key, base) =>
          key === HEALTH
            ? {
                normalizedValue: { status: `v${value}` },
                raw: null,
                revisionHint: null,
              }
            : base.read(key, {} as never),
      });
      // A starved superseding registration (finding CW-8, reproduced
      // deterministically in c13-closure-unstable.test.ts) writes nothing and
      // is the only rejection this race may produce.
      const starved = { count: 0 };
      const later = <T>(ms: number, run: () => Promise<T>) =>
        new Promise<void>((resolve, reject) =>
          setTimeout(() => {
            run().then(
              () => resolve(),
              (error: { code?: string }) => {
                if (error.code === 'closure_unstable') {
                  starved.count += 1;
                  resolve();
                } else reject(error);
              },
            );
          }, ms),
        );
      const work: Promise<unknown>[] = pairs.map(({ attempt, call }, i) =>
        later((i * 3) % 11, () => observe(observer, attempt, call, HEALTH)),
      );
      for (let n = 1; n <= 6; n += 1)
        work.push(
          later((n * 5) % 13, () => {
            value = n;
            return registerObserved(world, 'checkout.health', {
              status: `v${n}`,
            });
          }),
        );
      const settled = await Promise.allSettled(work);
      expect(
        settled
          .filter((r) => r.status === 'rejected')
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      // Whatever was starved, no running attempt rests on a superseded receipt
      // and the head is a single supported receipt.
      expect(await unmarkedReaders(world)).toEqual([]);
      const heads = await world.admin.query(
        `SELECT 1 FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = $1 AND r.status = 'supported'`,
        [HEALTH],
      );
      expect(heads.rows).toHaveLength(1);
      expect(world.deadlocks()).toEqual([]);
    });
  });
});

describe('CW-5 call-site obligation of the executor', () => {
  it('the stored receipt of an observe_source call carries selfWrite none and no action id, whatever the observed value says', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      const hostile = {
        status: 'ok',
        selfWrite: 'verified',
        causedByActionId: '11111111-1111-4111-8111-111111111111',
      };
      const observer = executor(world, {
        read: async () => ({
          normalizedValue: hostile,
          raw: null,
          revisionHint: null,
        }),
      });
      const seen = await observe(observer, attempt, call, HEALTH);
      const { rows } = await world.admin.query<{
        self_write: string;
        caused_by_action_id: string | null;
        provenance_kind: string;
      }>(
        'SELECT self_write, caused_by_action_id, provenance_kind FROM ledger.observation_receipts WHERE id = $1',
        [seen.receiptId],
      );
      expect(rows[0]).toEqual({
        self_write: 'none',
        caused_by_action_id: null,
        provenance_kind: 'tool_call',
      });
      // The hostile fields are content of the observed value, nothing more.
      expect(seen.normalizedValue).toEqual(hostile);
    });
  });

  it('a controlled member value carrying an extra marker field is refused by the ledger, not registered', async () => {
    await withWorld(async (world) => {
      const { attempt, call } = await setup(world);
      await collectionReceipt(world);
      const observer = executor(world, {
        read: async (key, base) => {
          const real = await base.read(key, {} as never);
          return key === MEMBER
            ? {
                ...real,
                normalizedValue: {
                  ...(real.normalizedValue as object),
                  causedByActionId: '11111111-1111-4111-8111-111111111111',
                },
              }
            : real;
        },
      });
      await expect(
        observe(observer, attempt, call, MEMBER),
      ).rejects.toMatchObject({ name: 'InvalidObservationError' });
      expect(await readSetRevisions(world, attempt.attemptId)).toEqual([]);
    });
  });

  it('static: the executor source names no action id and uses selfWrite only to forward the stored provenance into an event', () => {
    const source = readFileSync(
      new URL(
        '../../../../src/server/nemodots/team/observer.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(/causedByActionId/);
    expect(
      source
        .split('\n')
        .filter((line) => line.includes('selfWrite'))
        .map((line) => line.trim()),
    ).toEqual(['selfWrite: receipt.provenance.selfWrite,']);
  });
});
