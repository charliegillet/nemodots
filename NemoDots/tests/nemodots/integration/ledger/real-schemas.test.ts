// The ledger against the real checkout authority (0004) and the real
// coordinator tables (0003), with the default schema names: registration reads
// checkout.config_entries / config_collection under FOR SHARE, and the
// closure's compare-and-set marks satisfy the coordinator's own CHECKs.
// action_intents (0005) belongs to the actions package and is not required.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addEdges,
  assertCurrent,
  liveVersion,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  inMission,
  inTx,
  registerReal,
  newScope,
  sourceRef,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();

describe('real authority and coordinator schemas', () => {
  it('registers controlled sources from checkout.*, invalidates through the real coordinator tables and stays inside their CHECKs', async () => {
    const { admin, app } = getDb();
    const scope = newScope();
    const key = `ledger.real_${randomUUID().slice(0, 8)}`;

    // authority rows, written as the owner (nemodots_app may only UPDATE them)
    await admin.query(
      `INSERT INTO checkout.config_entries (key, value, version, caused_by_actor) VALUES ($1, '3'::jsonb, 1, 'seed')`,
      [key],
    );
    await admin.query(
      'UPDATE checkout.config_collection SET version = version + 1',
    );

    const missionId = randomUUID();
    const [t1, t2] = [randomUUID(), randomUUID()];
    const [a1, a2, o1] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query(
      `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
       VALUES ($1, $2, 'test', 'checkout', 'ledger contract test', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
      [missionId, scope.ownerId],
    );
    for (const [i, id] of [t1, t2].entries())
      await admin.query(
        `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
         VALUES ($1, $2, 0, $3, 'task', 'question', 'investigator', 'succeeded', 0, '{}'::jsonb)`,
        [id, missionId, i],
      );
    const attempt = (id: string, taskId: string, status: string) =>
      admin.query(
        `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner,
                                                fencing_token, lease_expires_at, lease_renewed_at)
         VALUES ($1, $2, $3, 1, 'initial', $4, 0, 'test', 1, now() + interval '1 minute', now())`,
        [id, taskId, missionId, status],
      );
    await attempt(a1, t1, 'running');
    await attempt(a2, t2, 'running');
    await admin.query(
      `INSERT INTO coordinator.task_outputs (id, task_id, attempt_id, mission_id, kind, content, digest)
       VALUES ($1, $2, $3, $4, 'finding', '{}'::jsonb, repeat('a', 64))`,
      [o1, t1, a1, missionId],
    );

    // registration with the default schema names
    const member = await inTx(app, async (client) => {
      const versions = await liveVersion(
        client,
        [`checkout.config/${key}`, 'checkout.config'],
        'share',
      );
      expect(versions.get(`checkout.config/${key}`)).toBe(1);
      return registerReal(client, {
        source: sourceRef(scope, `checkout.config/${key}`),
        normalizedValue: { key, value: 3, version: 1 },
        provenance: { kind: 'watcher' },
      });
    });
    expect(member.receipt.sourceRevision).toBe(1);
    expect(typeof member.receipt.collectionRevision).toBe('number');
    const health = await inTx(app, (client) =>
      registerReal(client, {
        source: sourceRef(scope, 'checkout.health'),
        normalizedValue: { status: 'ok' },
        provenance: { kind: 'watcher' },
      }),
    );
    const collection = await inTx(app, async (client) => {
      const { rows: keys } = await client.query<{ key: string }>(
        'SELECT key FROM checkout.config_entries ORDER BY key',
      );
      const { rows: version } = await client.query<{ version: string }>(
        'SELECT version FROM checkout.config_collection',
      );
      return registerReal(client, {
        source: sourceRef(scope, 'checkout.config'),
        normalizedValue: {
          keys: keys.map((row) => row.key),
          collectionVersion: Number(version[0].version),
        },
        provenance: { kind: 'watcher' },
      });
    });
    expect(collection.receipt.source.sourceType).toBe('controlled_collection');

    await inTx(app, (client) =>
      addEdges(client, [
        {
          kind: 'evidence',
          from: { kind: 'receipt', id: member.receipt.id },
          to: { kind: 'attempt', id: a1, missionId, taskId: t1 },
        },
        {
          kind: 'evidence',
          from: { kind: 'attempt', id: a1, missionId, taskId: t1 },
          to: { kind: 'task_output', id: o1, missionId, taskId: t1 },
        },
        {
          kind: 'evidence',
          from: { kind: 'receipt', id: health.receipt.id },
          to: { kind: 'attempt', id: a2, missionId, taskId: t2 },
        },
      ]),
    );
    await inTx(app, async (client) =>
      assertCurrent(
        client,
        [member.receipt.id, collection.receipt.id, health.receipt.id],
        await inMission(member.receipt.id, { lockMode: 'update' }),
      ),
    );

    // the authority moves (as nemodots_app, the only writer role of the version)
    await app.query(
      "UPDATE checkout.config_entries SET value = '4'::jsonb, version = version + 1 WHERE key = $1",
      [key],
    );
    await expect(
      inTx(app, async (client) =>
        assertCurrent(
          client,
          [member.receipt.id],
          await inMission(member.receipt.id, { lockMode: 'share' }),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'stale_pending_observation' });
    // the collection receipt is untouched by a value change (C1/D1)
    await inTx(app, async (client) =>
      assertCurrent(
        client,
        [collection.receipt.id],
        await inMission(collection.receipt.id, { lockMode: 'share' }),
      ),
    );

    const change = await inTx(app, (client) =>
      registerReal(client, {
        source: sourceRef(scope, `checkout.config/${key}`),
        normalizedValue: { key, value: 4, version: 2 },
        provenance: { kind: 'watcher' },
      }),
    );
    const event = change.invalidation!;
    expect(event.affected).toEqual({
      modelCallIds: [],
      attemptIds: [a1],
      outputIds: [o1],
      actionIds: [],
      taskIds: [t1],
    });
    // preserved comes from the real coordinator.tasks table: t2 has no node in the graph
    expect(event.perMission).toEqual([
      { missionId, affected: event.affected, preserved: { taskIds: [t2] } },
    ]);

    const attempts = await admin.query(
      'SELECT id, status, abort_reason, finished_at IS NOT NULL AS finished FROM coordinator.task_attempts ORDER BY id',
    );
    const byId = new Map(attempts.rows.map((row) => [row.id, row]));
    expect(byId.get(a1)).toMatchObject({
      status: 'invalidated',
      abort_reason: 'readset_invalidated',
      finished: true,
    });
    expect(byId.get(a2)).toMatchObject({
      status: 'running',
      abort_reason: null,
    });
    const tasks = await admin.query(
      'SELECT id, status, transition_version FROM coordinator.tasks',
    );
    const taskById = new Map(tasks.rows.map((row) => [row.id, row]));
    expect(taskById.get(t1)).toMatchObject({
      status: 'invalidated',
      transition_version: 1,
    });
    expect(taskById.get(t2)).toMatchObject({
      status: 'succeeded',
      transition_version: 0,
    });
    const outputs = await admin.query(
      'SELECT usable, unusable_reason FROM coordinator.task_outputs WHERE id = $1',
      [o1],
    );
    expect(outputs.rows[0]).toEqual({
      usable: false,
      unusable_reason: `invalidated:${event.id}`,
    });
  });
});
