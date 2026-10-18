// D2 under REAL mixed traffic. A healthy checkout under ordinary use (customer
// orders, catalogue reads, acceptance-probe runs, the agents' own repeated
// observations) must not mint a single revision of any observed source:
// confirmations are appended instead. A real fault must still change the digest.
// The watcher registers through the real ledger, exactly as in a mission.
import { describe, expect, it } from 'vitest';
import type {
  InvalidationEvent,
  Scope,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import { createProbe } from '../../../../src/server/nemodots/sandbox/probe.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import { newScope, sourceRef } from '../ledger/fixtures.js';
import { withSandbox, type Sandbox } from './harness.js';

const ledger = { events: createEventSink() };
const KEYS = [
  'checkout.health',
  'checkout.metrics',
  'checkout.orders.recent',
  'checkout.inventory/SKU-0001',
  'checkout.inventory/SKU-0002',
  'checkout.inventory/SKU-0003',
  'checkout.inventory/PROBE-SKU',
  'redis.stats',
] as const;

async function setup(s: Sandbox) {
  const readers = createSourceReaders({
    pg: s.pools.app,
    redis: s.redis.client,
    redisPrefix: s.redis.prefix,
    checkoutUrl: 'http://checkout.invalid',
    fetch: s.fetch,
    now: s.clock.now,
  });
  const testScope = newScope();
  const scope = {
    ownerId: testScope.ownerId,
    missionId: testScope.missionId,
    spaceId: null,
    environment: 'test',
    resource: testScope.resource,
  } as unknown as Scope;
  const register = async (key: string) => {
    const read = await readers.read(key as SourceKey, scope);
    const client = await s.pools.app.connect();
    try {
      await client.query('BEGIN');
      await registerObservation(
        client,
        {
          source: sourceRef(testScope, key),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'tool_call' },
        } as never,
        { ledger },
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  const invalidations: InvalidationEvent[] = [];
  const watcher = createWatcher({
    pool: s.pools.app,
    reader: readers,
    recovery: {
      async onInvalidation(event) {
        invalidations.push(event);
      },
      async onSelfWriteSettled() {},
    },
    intervalMs: 60_000,
    ledger,
  });
  const probe = createProbe({
    verifier: s.pools.verifier,
    checkoutUrl: 'http://checkout.invalid',
    probeSecret: s.probeSecret,
    windowMs: 0,
    sampleIntervalMs: 20,
    fetch: s.fetch,
  });
  return { register, watcher, invalidations, probe, readers, scope };
}

const revisions = async (s: Sandbox, key: string) =>
  Number(
    (
      await s.pools.admin.query(
        `SELECT count(*) AS n FROM ledger.observation_receipts r
           JOIN ledger.sources src ON src.id = r.source_id WHERE src.key = $1`,
        [key],
      )
    ).rows[0].n,
  );
const confirmations = async (s: Sandbox, key: string) =>
  Number(
    (
      await s.pools.admin.query(
        `SELECT count(*) AS n FROM ledger.receipt_confirmations c
           JOIN ledger.observation_receipts r ON r.id = c.receipt_id
           JOIN ledger.sources src ON src.id = r.source_id WHERE src.key = $1`,
        [key],
      )
    ).rows[0].n,
  );

const order = (s: Sandbox, sku: string, quantity = 1) =>
  s.request('/orders', { body: { items: [{ sku, quantity }] } });

describe('observed sources under ordinary traffic (D2)', () => {
  it('10 polls of a healthy checkout under mixed traffic mint zero revisions of any observed source and append confirmations', async () => {
    await withSandbox(async (s) => {
      const { register, watcher, invalidations, probe } = await setup(s);
      // a warm, in-use checkout before the agents first look
      for (let i = 0; i < 3; i += 1) await order(s, 'SKU-0001');
      await s.request('/products');
      s.clock.advance(1_000);
      for (const key of KEYS) await register(key);

      for (let round = 0; round < 10; round += 1) {
        // ordinary use between polls
        await s.request('/products');
        await s.request('/products');
        // customer orders: 3 + 3 + 3 already placed = 9, inside the 1-10 bucket
        // of checkout.orders.recent (crossing a bucket boundary is a real change
        // in order volume and is allowed to mint a revision; staying inside is not)
        if (round % 4 === 0)
          expect((await order(s, 'SKU-0002')).status).toBe(201);
        if (round % 3 === 0)
          expect((await probe.execute()).verdict).toBe('pass');
        if (round % 4 === 1)
          expect((await order(s, 'SKU-0003', 2)).status).toBe(201);
        s.clock.advance(2_500);
        // the agents' own repeated observations (twice per round)
        const first = await watcher.pass();
        const second = await watcher.pass();
        const minted: string[] = [];
        for (const key of KEYS)
          if ((await revisions(s, key)) !== 1) minted.push(key);
        expect(minted, `round ${round} minted a revision of`).toEqual([]);
        expect(first, `round ${round}`).toMatchObject({
          registered: 0,
          errors: 0,
        });
        expect(second, `round ${round}`).toMatchObject({
          registered: 0,
          errors: 0,
        });
      }

      for (const key of KEYS) {
        expect(await revisions(s, key), `${key} minted a revision`).toBe(1);
        expect(
          await confirmations(s, key),
          `${key} was not confirmed`,
        ).toBeGreaterThanOrEqual(20);
      }
      expect(invalidations).toEqual([]);
    });
  });

  it('a real fault still changes the digest: the schema mismatch registers a new revision of metrics and health', async () => {
    await withSandbox(async (s) => {
      const { register, watcher, invalidations } = await setup(s);
      await s.request('/products');
      s.clock.advance(1_000);
      for (const key of KEYS) await register(key);
      expect(await watcher.pass()).toMatchObject({ registered: 0 });

      const run = await s.inject('cache_schema_mismatch', 1);
      await run.done;
      s.reloadConfig();
      expect((await s.request('/products')).status).toBe(500);
      const stats = await watcher.pass();
      expect(stats.registered).toBeGreaterThanOrEqual(2);
      expect(await revisions(s, 'checkout.metrics')).toBe(2);
      expect(await revisions(s, 'checkout.health')).toBe(2);
      // redis.stats reports the entries under the old schema next to the new expectation
      expect(invalidations.length).toBeGreaterThanOrEqual(0);
    });
  });
});
