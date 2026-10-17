// Read models: evidence with consuming branches and lastConfirmedAt, read
// sets, and receipt DTOs that satisfy the contract schema.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservationReceiptSchema } from '../../../../src/server/nemodots/contracts/index.js';
import {
  currentReceipt,
  getReceipt,
  linkInheritance,
  linkPublication,
  listEvidence,
  readSetOf,
  recordReadSet,
  registerObservation,
  staleReads,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  FX,
  collectionState,
  inTx,
  newScope,
  readMember,
  resetAuthority,
  seedConfig,
  sourceRef,
  updateConfig,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();
const opts = { ledger: FX, marker: null } as const;

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

describe('evidence view', () => {
  it('lists head receipts with lastConfirmedAt, confirmations and the branches that consume them', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const { app } = getDb();
    const member = await inTx(app, async (client) => {
      const read = await readMember(client, 'db.pool_max');
      return registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'watcher' },
        },
        opts,
      );
    });
    const collection = await inTx(app, async (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config'),
          normalizedValue: await collectionState(client),
          provenance: { kind: 'watcher' },
        },
        opts,
      ),
    );
    const health1 = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
          observedAt: new Date(Date.now() - 600_000),
        },
        opts,
      ),
    );
    await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'probe' },
        },
        opts,
      ),
    );
    const health2 = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'down' },
          provenance: { kind: 'watcher' },
        },
        opts,
      ),
    );

    const [missionA, missionB] = [randomUUID(), randomUUID()];
    const [taskA, taskB] = [randomUUID(), randomUUID()];
    const [attemptA, attemptB] = [randomUUID(), randomUUID()];
    await inTx(app, async (client) => {
      await recordReadSet(
        client,
        {
          missionId: missionA,
          taskId: taskA,
          attemptId: attemptA,
          receiptIds: [member.receipt.id, health2.receipt.id],
        },
        FX,
      );
      await recordReadSet(
        client,
        {
          missionId: missionB,
          taskId: taskB,
          attemptId: attemptB,
          receiptIds: [health2.receipt.id],
        },
        FX,
      );
    });

    const head = await listEvidence(app, {
      ownerId: scope.ownerId,
      environment: 'test',
      resource: 'checkout',
    });
    expect(head.map((item) => item.receipt.source.key)).toEqual([
      'checkout.config',
      'checkout.config/db.pool_max',
      'checkout.health',
    ]);
    for (const item of head)
      expect(ObservationReceiptSchema.safeParse(item.receipt).success).toBe(
        true,
      );
    const byKey = new Map<string, (typeof head)[number]>(
      head.map((item) => [item.receipt.source.key as string, item]),
    );
    expect(byKey.get('checkout.health')!.receipt.id).toBe(health2.receipt.id);
    expect(byKey.get('checkout.health')!.consumers).toEqual(
      [
        {
          missionId: missionA,
          taskId: taskA,
          attemptIds: [attemptA],
          modelCallIds: [],
        },
        {
          missionId: missionB,
          taskId: taskB,
          attemptIds: [attemptB],
          modelCallIds: [],
        },
      ].sort((a, b) => (a.missionId < b.missionId ? -1 : 1)),
    );
    expect(byKey.get('checkout.config/db.pool_max')!.consumers).toEqual([
      {
        missionId: missionA,
        taskId: taskA,
        attemptIds: [attemptA],
        modelCallIds: [],
      },
    ]);
    expect(byKey.get('checkout.config')!.consumers).toEqual([]);
    expect(collection.receipt.id).toBe(
      byKey.get('checkout.config')!.receipt.id,
    );

    // a mission-scoped view lists only that mission's branches
    const scoped = await listEvidence(app, {
      ownerId: scope.ownerId,
      environment: 'test',
      resource: 'checkout',
      missionId: missionB,
    });
    expect(
      scoped
        .find((item) => item.receipt.source.key === 'checkout.health')!
        .consumers.map((c) => c.missionId),
    ).toEqual([missionB]);
    expect(
      scoped.find(
        (item) => item.receipt.source.key === 'checkout.config/db.pool_max',
      )!.consumers,
    ).toEqual([]);

    // history: the superseded health receipt with its confirmations and lastConfirmedAt
    const history = await listEvidence(app, {
      ownerId: scope.ownerId,
      environment: 'test',
      resource: 'checkout',
      includeHistory: true,
    });
    const old = history.find((item) => item.receipt.id === health1.receipt.id)!;
    expect(old.receipt.status).toBe('superseded');
    expect(old.confirmations).toBe(1);
    expect(Date.parse(old.receipt.lastConfirmedAt)).toBeGreaterThan(
      Date.parse(old.receipt.observedAt) + 500_000,
    );

    // other owners see nothing
    expect(
      await listEvidence(app, {
        ownerId: 'someone-else',
        environment: 'test',
        resource: 'checkout',
      }),
    ).toEqual([]);
    expect(
      await listEvidence(app, {
        ownerId: scope.ownerId,
        environment: 'eval',
        resource: 'checkout',
      }),
    ).toEqual([]);
  });

  it('getReceipt and currentReceipt return the same DTO; unknown sources have no head', async () => {
    const scope = newScope();
    const { app } = getDb();
    const result = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'redis.stats'),
          normalizedValue: { reachable: true },
          provenance: { kind: 'tool_call', toolCallId: 'call_9' },
          rawRef: {
            kind: 'inline',
            digest: 'a'.repeat(64),
            bytes: 12,
            id: null,
          },
        },
        opts,
      ),
    );
    const byId = await getReceipt(app, result.receipt.id);
    const head = await currentReceipt(app, {
      ownerId: scope.ownerId,
      environment: 'test',
      resource: 'checkout',
      key: 'redis.stats',
    });
    expect(byId).toEqual(result.receipt);
    expect(head).toEqual(byId);
    expect(byId.rawRef).toEqual({
      kind: 'inline',
      digest: 'a'.repeat(64),
      bytes: 12,
      id: null,
    });
    expect(byId.provenance.toolCallId).toBe('call_9');
    expect(
      await currentReceipt(app, {
        ownerId: scope.ownerId,
        environment: 'test',
        resource: 'checkout',
        key: 'checkout.metrics',
      }),
    ).toBeNull();
    await expect(getReceipt(app, randomUUID())).rejects.toMatchObject({
      code: 'receipt_not_found',
    });
  });
});

describe('read sets and publication links', () => {
  it('records receipts as an attempt reads them and reports what went stale', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const { app } = getDb();
    const member = await inTx(app, async (client) => {
      const read = await readMember(client, 'db.pool_max');
      return registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'watcher' },
        },
        opts,
      );
    });
    const health = await inTx(app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
        },
        opts,
      ),
    );
    const [missionId, taskId, attemptId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const link = {
      missionId,
      taskId,
      attemptId,
      receiptIds: [member.receipt.id, health.receipt.id, member.receipt.id],
    };
    expect(await inTx(app, (client) => recordReadSet(client, link, FX))).toEqual({
      inserted: 2,
      existing: 0,
    });
    expect(await inTx(app, (client) => recordReadSet(client, link, FX))).toEqual({
      inserted: 0,
      existing: 2,
    });
    expect(await readSetOf(app, attemptId)).toEqual(
      [member.receipt.id, health.receipt.id].sort(),
    );
    expect(await staleReads(app, attemptId, FX)).toEqual([]);

    await inTx(app, (client) => updateConfig(client, 'db.pool_max', 6));
    expect(await staleReads(app, attemptId, FX)).toEqual([
      {
        receiptId: member.receipt.id,
        sourceKey: 'checkout.config/db.pool_max',
        reason: 'stale_pending_observation',
      },
    ]);
  });

  it('linkPublication and linkInheritance create the evidence and inheritance shapes the closure walks', async () => {
    const { app } = getDb();
    const [
      missionId,
      taskId,
      attemptId,
      outputId,
      modelCallId,
      childAttempt,
      childTask,
    ] = Array.from({ length: 7 }, () => randomUUID());
    const result = await inTx(app, async (client) => {
      const published = await linkPublication(client, {
        missionId,
        taskId,
        attemptId,
        modelCallIds: [modelCallId],
        outputId,
      });
      const inherited = await linkInheritance(client, {
        missionId,
        taskId: childTask,
        attemptId: childAttempt,
        outputId,
      });
      return { published, inherited };
    });
    expect(result.published).toEqual({ inserted: 2, existing: 0 }); // attempt -> output, model_call -> output
    expect(result.inherited).toEqual({ inserted: 1, existing: 0 }); // output -> child attempt
  });
});
