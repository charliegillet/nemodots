// W2-R5 (ARCHITECTURE 5.2 step 5, finding I10): the registration transaction
// writes one ledger.invalidation_events row (global) and one coordinator
// `invalidation.recorded` event per affected mission through the injected
// EventSinkPort, each carrying only that mission's subset. Real default
// schemas and the coordinator's real sink (C6 advisory lock).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventPayloadSchema } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  addEdges,
  registerObservation,
  registerWithoutClosure,
} from '../../../../src/server/nemodots/ledger/index.js';
import type { RegistrationLedgerOptions } from '../../../../src/server/nemodots/ledger/options.js';
import {
  backendPid,
  inTx,
  newScope,
  sourceRef,
  useLedgerDb,
  waitsOnLock,
  type TestScope,
} from './fixtures.js';

const getDb = useLedgerDb();
const LEDGER = { events: createEventSink() };

async function mission(scope: TestScope, id: string = randomUUID()) {
  const { admin } = getDb();
  await admin.query(
    `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
     VALUES ($1, $2, 'test', 'checkout', 'events', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
    [id, scope.ownerId],
  );
  const task = randomUUID();
  const attempt = randomUUID();
  await admin.query(
    `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
     VALUES ($1, $2, 0, 0, 't', 'q', 'investigator', 'running', 0, '{}'::jsonb)`,
    [task, id],
  );
  const spare = randomUUID();
  await admin.query(
    `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
     VALUES ($1, $2, 0, 1, 't2', 'q', 'investigator', 'running', 0, '{}'::jsonb)`,
    [spare, id],
  );
  await admin.query(
    `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner,
                                            fencing_token, lease_expires_at, lease_renewed_at)
     VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'w', 1, now() + interval '1 hour', now())`,
    [attempt, task, id],
  );
  return { id, task, attempt, spare };
}

const register = (
  scope: TestScope,
  key: string,
  value: unknown,
  ledger: RegistrationLedgerOptions = LEDGER,
) =>
  inTx(getDb().app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(scope, key),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
      },
      { ledger },
    ),
  );

const link = (receiptId: string, m: Awaited<ReturnType<typeof mission>>) =>
  inTx(getDb().app, (client) =>
    addEdges(client, [
      {
        kind: 'evidence',
        from: { kind: 'receipt', id: receiptId },
        to: { kind: 'attempt', id: m.attempt, missionId: m.id, taskId: m.task },
      },
    ]),
  );

const eventsOf = async (ownerMissions: string[]) =>
  (
    await getDb().admin.query(
      `SELECT id, mission_id, payload FROM coordinator.events
        WHERE kind = 'invalidation.recorded' AND mission_id = ANY($1::uuid[]) ORDER BY id`,
      [ownerMissions],
    )
  ).rows.map((r) => ({ ...r, id: Number(r.id) }));

describe('per-mission invalidation events', () => {
  it('two affected missions get two events with only their own subset; an unaffected mission gets none; the payload validates', async () => {
    const scope = newScope();
    const a = await mission(scope);
    const b = await mission(scope);
    const c = await mission(scope);
    const first = (await register(scope, 'checkout.health', { status: 'ok' }))
      .receipt;
    await link(first.id, a);
    await link(first.id, b);
    const second = await register(scope, 'checkout.health', { status: 'down' });
    expect(second.invalidation!.missionIds.sort()).toEqual([a.id, b.id].sort());

    const events = await eventsOf([a.id, b.id, c.id]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.mission_id).sort()).toEqual([a.id, b.id].sort());
    for (const event of events) {
      expect(EventPayloadSchema.safeParse(event.payload).success).toBe(true);
      const own = event.mission_id === a.id ? a : b;
      expect(event.payload).toMatchObject({
        kind: 'invalidation.recorded',
        invalidationEventId: second.invalidation!.id,
        sourceKey: 'checkout.health',
        oldReceiptId: first.id,
        newReceiptId: second.receipt.id,
        reason: 'newer_observation',
        affected: { attemptIds: [own.attempt], taskIds: [own.task] },
        preserved: { taskIds: [own.spare] },
        closure: { capped: false },
      });
    }
    // the global event is untouched and the unaffected mission has none
    expect(second.invalidation!.perMission).toHaveLength(2);
    expect(await eventsOf([c.id])).toHaveLength(0);
  });

  it('is atomic with the receipt: a rollback leaves neither the receipt nor any event', async () => {
    const scope = newScope();
    const a = await mission(scope);
    const first = (await register(scope, 'checkout.health', { status: 'ok' }))
      .receipt;
    await link(first.id, a);
    const client = await getDb().app.connect();
    try {
      await client.query('BEGIN');
      await registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        { ledger: LEDGER },
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await eventsOf([a.id])).toHaveLength(0);
    const head = await getDb().admin.query(
      'SELECT count(*)::int AS n FROM ledger.observation_receipts WHERE id = $1 AND status = $2',
      [first.id, 'supported'],
    );
    expect(head.rows[0].n).toBe(1);
  });

  it('a registration without a sink is refused before anything is written; a confirmation emits nothing', async () => {
    const scope = newScope();
    const a = await mission(scope);
    const first = (await register(scope, 'checkout.health', { status: 'ok' }))
      .receipt;
    await link(first.id, a);
    const refused = await register(
      scope,
      'checkout.health',
      { status: 'down' },
      {} as never,
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'event_sink_missing' });
    const confirmed = await register(scope, 'checkout.health', {
      status: 'ok',
    });
    expect(confirmed.newRevision).toBe(false);
    expect(await eventsOf([a.id])).toHaveLength(0);
    const head = await getDb().admin.query(
      'SELECT count(*)::int AS n FROM ledger.observation_receipts WHERE id = $1 AND status = $2',
      [first.id, 'supported'],
    );
    expect(head.rows[0].n).toBe(1);
  });

  it('event ids follow commit order: a second registration waits for the first to commit and gets the later id', async () => {
    const { app, admin } = getDb();
    const scope = newScope();
    const a = await mission(scope);
    const h = (await register(scope, 'checkout.health', { status: 'ok' }))
      .receipt;
    const m = (await register(scope, 'checkout.metrics', { errors: [] }))
      .receipt;
    await link(h.id, a);
    await link(m.id, a);

    const one = await app.connect();
    const two = await app.connect();
    try {
      await one.query('BEGIN');
      const r1 = await registerObservation(
        one,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        { ledger: LEDGER },
      );
      const pid = await backendPid(two);
      await two.query('BEGIN');
      const r2 = registerObservation(
        two,
        {
          source: sourceRef(scope, 'checkout.metrics'),
          normalizedValue: { errors: ['x'] },
          provenance: { kind: 'watcher' },
        },
        { ledger: LEDGER },
      );
      expect(await waitsOnLock(admin, pid, 3_000)).toBe(true);
      await one.query('COMMIT');
      await r2;
      await two.query('COMMIT');
      expect(r1.invalidation).not.toBeNull();
    } finally {
      one.release();
      two.release();
    }
    const events = await eventsOf([a.id]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.sourceKey)).toEqual([
      'checkout.health',
      'checkout.metrics',
    ]);
    expect(events[0].id).toBeLessThan(events[1].id);
  });

  it('the coarse (closure cap) path emits one event per mission of the coarse set', async () => {
    const scope = newScope();
    const a = await mission(scope);
    const first = (await register(scope, 'checkout.health', { status: 'ok' }))
      .receipt;
    const result = await inTx(getDb().app, (client) =>
      registerWithoutClosure(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        {
          ledger: LEDGER,
          coarse: {
            perMission: [
              {
                missionId: a.id as never,
                affected: {
                  modelCallIds: [],
                  attemptIds: [a.attempt],
                  outputIds: [],
                  actionIds: [],
                  taskIds: [a.task],
                } as never,
                preserved: { taskIds: [a.spare as never] },
              },
            ],
          },
        },
      ),
    );
    expect(result.supersededReceiptId).toBe(first.id);
    const events = await eventsOf([a.id]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      reason: 'closure_cap_exceeded',
      closure: { capped: true },
      affected: { attemptIds: [a.attempt] },
    });
    expect(EventPayloadSchema.safeParse(events[0].payload).success).toBe(true);
  });
});
