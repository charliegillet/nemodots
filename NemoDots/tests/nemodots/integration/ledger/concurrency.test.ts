// Serialized registration (finding C8): the sources row lock makes concurrent
// registrations of one source mint exactly one revision per distinct value.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  listConfirmations,
  registerObservation,
  type RegisterOptions,
} from '../../../../src/server/nemodots/ledger/index.js';
import { barrier, withTimeout } from '../../helpers/barrier.js';
import {
  FX,
  count,
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

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

function racingRegistrations(
  scope: ReturnType<typeof newScope>,
  key: string,
  values: unknown[],
) {
  const meet = barrier(values.length);
  const hooks: RegisterOptions['hooks'] = {
    afterPreliminaryRead: async () => {
      await withTimeout(
        meet.arrive(),
        5_000,
        'every registration passed its preliminary read',
      );
    },
  };
  return withTimeout(
    Promise.all(
      values.map((value) =>
        inTx(getDb().app, (client) =>
          registerObservation(
            client,
            {
              source: sourceRef(scope, key),
              normalizedValue: value,
              provenance: { kind: 'watcher' },
            },
            { ledger: FX, marker: null, hooks },
          ),
        ),
      ),
    ),
    15_000,
    'racing registrations',
  );
}

describe('two concurrent registrations of one observed source (C8)', () => {
  it('a new digest raced after the preliminary read: exactly one new revision, the other confirms it', async () => {
    const scope = newScope();
    await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { rev: 1 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    const results = await racingRegistrations(scope, 'checkout.health', [
      { rev: 2 },
      { rev: 2 },
    ]);
    expect(results.filter((r) => r.newRevision)).toHaveLength(1);
    expect(results.filter((r) => !r.newRevision)).toHaveLength(1);
    expect(results[0].receipt.id).toBe(results[1].receipt.id);
    expect(results[0].receipt.sourceRevision).toBe(2);
    const { app } = getDb();
    const sourceCount = await count(
      app,
      'SELECT count(*) AS n FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE s.owner_id = $1',
      [scope.ownerId],
    );
    expect(sourceCount).toBe(2);
    expect(await listConfirmations(app, results[0].receipt.id)).toHaveLength(1);
    expect(
      await count(
        app,
        "SELECT count(*) AS n FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE s.owner_id = $1 AND r.status = 'supported'",
        [scope.ownerId],
      ),
    ).toBe(1);
  });

  it('the very first registration raced (no barrier: the source row insert itself serializes): one revision 1, the losers confirm', async () => {
    const scope = newScope();
    const results = await withTimeout(
      Promise.all(
        [0, 1, 2].map(() =>
          inTx(getDb().app, (client) =>
            registerObservation(
              client,
              {
                source: sourceRef(scope, 'checkout.health'),
                normalizedValue: { rev: 1 },
                provenance: { kind: 'watcher' },
              },
              { ledger: FX, marker: null },
            ),
          ),
        ),
      ),
      15_000,
      'first registration race',
    );
    expect(results.filter((r) => r.newRevision)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receipt.id)).size).toBe(1);
    expect(results.map((r) => r.receipt.sourceRevision)).toEqual([1, 1, 1]);
    expect(
      await listConfirmations(getDb().app, results[0].receipt.id),
    ).toHaveLength(2);
  });

  it('two different digests raced: both commit as consecutive revisions, one supersedes the other', async () => {
    const scope = newScope();
    await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { rev: 1 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    const results = await racingRegistrations(scope, 'checkout.health', [
      { v: 'a' },
      { v: 'b' },
    ]);
    expect(results.map((r) => r.receipt.sourceRevision).sort()).toEqual([2, 3]);
    const { rows } = await getDb().app.query<{
      source_revision: number;
      status: string;
    }>(
      `SELECT r.source_revision, r.status FROM ledger.observation_receipts r
         JOIN ledger.sources s ON s.id = r.source_id WHERE s.owner_id = $1 ORDER BY r.source_revision`,
      [scope.ownerId],
    );
    expect(rows.map((r) => r.status)).toEqual([
      'superseded',
      'superseded',
      'supported',
    ]);
  });

  it('a controlled version raced: one revision, one confirmation', async () => {
    const scope = newScope();
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    await inTx(getDb().app, async (client) => {
      const read = await readMember(client, 'db.pool_max');
      await registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.config/db.pool_max'),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      );
    });
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 4));
    const meet = barrier(2);
    const hooks: RegisterOptions['hooks'] = {
      afterPreliminaryRead: async () => {
        await withTimeout(meet.arrive(), 5_000, 'both registrations');
      },
    };
    const results = await withTimeout(
      Promise.all(
        [0, 1].map(() =>
          inTx(getDb().app, async (client) => {
            const read = await readMember(client, 'db.pool_max');
            return registerObservation(
              client,
              {
                source: sourceRef(scope, 'checkout.config/db.pool_max'),
                normalizedValue: read.normalizedValue,
                provenance: { kind: 'watcher' },
              },
              { ledger: FX, marker: null, hooks },
            );
          }),
        ),
      ),
      15_000,
      'controlled race',
    );
    expect(results.filter((r) => r.newRevision)).toHaveLength(1);
    expect(results[0].receipt.sourceRevision).toBe(2);
    expect(results[0].receipt.id).toBe(results[1].receipt.id);
  });
});
