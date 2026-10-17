// Inputs that must be refused before the database is touched. The stub client
// fails the test on any query, which also proves "writes nothing".
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PgClient, SourceRef } from '../../../src/server/nemodots/contracts/index.js';
import { digest } from '../../../src/server/nemodots/contracts/index.js';
import { addEdges } from '../../../src/server/nemodots/ledger/edges.js';
import {
  DigestMismatchError,
  EdgeError,
  InvalidObservationError,
  InvalidSourceKeyError,
  LedgerError,
  ModelCallRecordError,
  ObservationTooLargeError,
} from '../../../src/server/nemodots/ledger/errors.js';
import {
  recordModelCall,
  recordOrphanedAttempt,
} from '../../../src/server/nemodots/ledger/model-calls.js';
import {
  registerObservation,
  type RegisterObservationInput,
} from '../../../src/server/nemodots/ledger/receipts.js';
import { identifier } from '../../../src/server/nemodots/ledger/options.js';

const untouched: PgClient & { calls: number } = {
  calls: 0,
  async query() {
    this.calls += 1;
    throw new Error('the database must not be touched');
  },
};

const mission = randomUUID();
const source = (key: string, sourceType: SourceRef['sourceType'] = 'observed_endpoint') =>
  ({
    key,
    sourceType,
    authority:
      sourceType === 'controlled_config' || sourceType === 'controlled_collection'
        ? 'controlled'
        : 'observed',
    scope: {
      ownerId: 'owner',
      missionId: mission,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
  }) as unknown as SourceRef;

const base = (overrides: Partial<RegisterObservationInput> = {}): RegisterObservationInput => ({
  source: source('checkout.health'),
  normalizedValue: { status: 'ok' },
  provenance: { kind: 'watcher' },
  ...overrides,
});

async function refused(input: RegisterObservationInput) {
  try {
    await registerObservation(untouched, input);
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('registerObservation refuses malformed input without a query', () => {
  it.each([
    'billing.ledger',
    'runbook/../../.env',
    'checkout.config/Bad Key',
    'checkout.inventory/a/b',
    '',
  ])('unknown or traversing source key %j', async (key) => {
    const error = await refused(base({ source: source(key) }));
    expect(error).toBeInstanceOf(InvalidSourceKeyError);
    expect((error as LedgerError).code).toBe('invalid_source_key');
  });

  it('a normalized value over 16 KiB canonical', async () => {
    const error = await refused(base({ normalizedValue: { blob: 'x'.repeat(16_384) } }));
    expect(error).toBeInstanceOf(ObservationTooLargeError);
    expect((error as LedgerError).code).toBe('too_large');
  });

  it('a claimed digest that disagrees with the value', async () => {
    const error = await refused(
      base({ claimed: { contentDigest: digest({ status: 'degraded' }) } }),
    );
    expect(error).toBeInstanceOf(DigestMismatchError);
  });

  it('non-canonical JSON (undefined array element, cycles, NaN, NUL)', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [[undefined], cyclic, { n: Number.NaN }, { s: 'a\u0000b' }]) {
      const error = await refused(base({ normalizedValue: value }));
      expect(error).toBeInstanceOf(InvalidObservationError);
    }
  });

  it('a self write marker without the action id', async () => {
    const error = await refused(
      base({ provenance: { kind: 'watcher', selfWrite: 'verified' } }),
    );
    expect(error).toBeInstanceOf(InvalidObservationError);
  });

  it('trust that contradicts the authority', async () => {
    expect(await refused(base({ trust: 'controlled_authority' }))).toBeInstanceOf(
      InvalidObservationError,
    );
    expect(
      await refused(
        base({
          source: source('checkout.config/db.pool_max', 'controlled_config'),
          trust: 'observed_tool',
          normalizedValue: { key: 'db.pool_max', value: 3, version: 1 },
        }),
      ),
    ).toBeInstanceOf(InvalidObservationError);
  });

  it('a collection value that is not a sorted key list, and a negative predicate off the collection', async () => {
    expect(
      await refused(
        base({
          source: source('checkout.config', 'controlled_collection'),
          normalizedValue: { keys: ['b', 'a'], collectionVersion: 1 },
        }),
      ),
    ).toBeInstanceOf(InvalidObservationError);
    expect(
      await refused(
        base({ negative: { predicate: "key 'x' does not exist", collectionRevision: 1 } }),
      ),
    ).toBeInstanceOf(InvalidObservationError);
  });

  it('a source whose type contradicts its key family', async () => {
    expect(
      await refused(base({ source: source('checkout.config', 'controlled_config') })),
    ).toBeInstanceOf(InvalidObservationError);
  });

  it('never queried the database', () => {
    expect(untouched.calls).toBe(0);
  });
});

describe('addEdges refuses invalid edges without a query', () => {
  const node = (kind: 'attempt' | 'task' | 'receipt' | 'task_output', extra = {}) => ({
    kind,
    id: randomUUID(),
    ...extra,
  });

  it('an edge into a receipt, a self loop, a scheduling edge between non-tasks, malformed ids', async () => {
    const attempt = node('attempt', { missionId: mission });
    const cases = [
      { kind: 'evidence' as const, from: attempt, to: node('receipt') },
      { kind: 'evidence' as const, from: attempt, to: attempt },
      { kind: 'scheduling' as const, from: attempt, to: node('attempt', { missionId: mission }) },
      { kind: 'evidence' as const, from: { kind: 'attempt' as const, id: 'not-a-uuid' }, to: attempt },
      { kind: 'evidence' as const, from: node('receipt', { missionId: mission }), to: attempt },
    ];
    for (const edge of cases) {
      await expect(addEdges(untouched, [edge])).rejects.toBeInstanceOf(EdgeError);
    }
    expect(untouched.calls).toBe(0);
  });
});

describe('model call records refuse invalid input without a query', () => {
  it('an invalid record shape and an orphan without attempts', async () => {
    await expect(
      recordModelCall(untouched, { record: {} as never, snapshot: {} as never }),
    ).rejects.toBeInstanceOf(ModelCallRecordError);
    await expect(
      recordOrphanedAttempt(untouched, {
        modelCallId: randomUUID() as never,
        scope: { ownerId: 'o', missionId: mission, spaceId: null, environment: 'test', resource: 'checkout' } as never,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        role: 'worker',
        model: { requested: 'm', returned: null },
        provider: { host: 'h', mode: 'live' },
        attempts: [],
      }),
    ).rejects.toBeInstanceOf(ModelCallRecordError);
    expect(untouched.calls).toBe(0);
  });
});

describe('schema identifiers', () => {
  it('accepts plain names and refuses anything that could alter SQL', () => {
    expect(identifier('checkout')).toBe('checkout');
    expect(identifier('ledger_test_coord')).toBe('ledger_test_coord');
    for (const bad of ['Checkout', 'a;drop', 'a b', '', '1abc', 'x'.repeat(64)])
      expect(() => identifier(bad)).toThrow(LedgerError);
  });
});
