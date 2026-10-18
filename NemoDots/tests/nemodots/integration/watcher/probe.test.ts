// D2 through the watcher: an acceptance-probe run (probe-tagged orders, a
// PROBE-SKU decrement, probe traffic) must not move the normalized values of
// the sources agents depend on. Real checkout app, real readers, real probe.
import { expect, it } from 'vitest';
import type {
  InvalidationEvent,
  Scope,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  registerObservation,
  type RegisterObservationInput,
} from '../../../../src/server/nemodots/ledger/index.js';
import { createProbe } from '../../../../src/server/nemodots/sandbox/probe.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import { createWatcher } from '../../../../src/server/nemodots/watcher/index.js';
import { withSandbox } from '../sandbox/harness.js';
import { newScope, sourceRef } from '../ledger/fixtures.js';

const KEYS = [
  'checkout.health',
  'checkout.metrics',
  'checkout.orders.recent',
  'checkout.inventory/SKU-0001',
  'checkout.inventory/PROBE-SKU',
];

it('a probe run leaves the health, metrics, orders.recent and inventory receipts current (D2)', async () => {
  await withSandbox(async (s) => {
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

    // an agent's first reads
    for (const key of KEYS) {
      const read = await readers.read(key as SourceKey, scope);
      const client = await s.pools.app.connect();
      try {
        await client.query('BEGIN');
        await registerObservation(client, {
          source: sourceRef(testScope, key),
          normalizedValue: read.normalizedValue,
          provenance: { kind: 'tool_call' },
        } as RegisterObservationInput);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }

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
    });
    try {
      expect(await watcher.pass()).toMatchObject({
        sources: KEYS.length,
        confirmed: KEYS.length,
        registered: 0,
      });

      const probe = createProbe({
        verifier: s.pools.verifier,
        checkoutUrl: 'http://checkout.invalid',
        probeSecret: s.probeSecret,
        windowMs: 0,
        sampleIntervalMs: 50,
        fetch: s.fetch,
      });
      const result = await probe.execute();
      expect(result.verdict).toBe('pass');

      expect(await watcher.pass()).toMatchObject({
        sources: KEYS.length,
        confirmed: KEYS.length,
        registered: 0,
        errors: 0,
      });
      const { rows } = await s.pools.admin.query<{ n: string; status: string }>(
        `SELECT count(*) AS n, min(r.status) AS status
           FROM ledger.observation_receipts r JOIN ledger.sources src ON src.id = r.source_id
          WHERE src.key = ANY($1::text[])`,
        [KEYS],
      );
      expect(Number(rows[0].n)).toBe(KEYS.length);
      expect(rows[0].status).toBe('supported');
      expect(invalidations).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });
});
