// Gate 6 building blocks: verifier-owned checkout data invariants and the
// frozen held-out trial list. INV-1 is implemented end to end with the
// verifier role and plain HTTP; the others fail until their entry points
// exist and the driver is bound. Trials need the full composed system.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_INVARIANTS, PROBE } from '../oracle/checkout-invariants.js';
import { businessSnapshot } from '../driver/business-hash.js';
import {
  APP_ROOT,
  bindOrFail,
  requireEntries,
} from '../driver/entry-points.js';

function verifierUrl() {
  const url = process.env.NEMODOTS_PG_URL_VERIFIER;
  if (!url)
    throw new Error(
      'BLOCKED: NEMODOTS_PG_URL_VERIFIER is not set; run through npm run test:nemodots:acceptance with a started, seeded NemoDots stack.',
    );
  const port = new URL(url).port;
  if (port === '5432') throw new Error('Refusing the user PostgreSQL on 5432.');
  return url;
}

function checkoutUrl() {
  const url = process.env.NEMODOTS_CHECKOUT_URL;
  if (!url) throw new Error('BLOCKED: NEMODOTS_CHECKOUT_URL is not set.');
  return url.replace(/\/$/, '');
}

describe('gate 6: checkout data invariants (verifier access)', () => {
  it('INV-1 read-only phase leaves business data untouched', async () => {
    await requireEntries(['checkoutMigration', 'checkoutMain', 'seed']);
    const client = new pg.Client({
      connectionString: verifierUrl(),
      application_name: 'nemodots-acceptance-verifier',
    });
    await client.connect();
    try {
      const before = await businessSnapshot(client);
      expect(before.perTable['checkout.products'].rows).toBeGreaterThan(0);
      const base = checkoutUrl();
      for (const path of [
        '/health',
        '/ready',
        '/products',
        `/inventory/${PROBE.sku}`,
        '/metrics',
      ]) {
        for (let n = 0; n < 3; n += 1) {
          const response = await fetch(`${base}${path}`);
          expect([200, 500, 503], `${path} status`).toContain(response.status);
          await response.arrayBuffer();
        }
      }
      const after = await businessSnapshot(client);
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });

  it.each(
    CHECKOUT_INVARIANTS.filter((i) => i.id !== 'INV-1').map(
      (i) => [i.id, i.title] as const,
    ),
  )('%s %s', async (id) => {
    await bindOrFail(id, [
      'checkoutMigration',
      'checkoutMain',
      'seed',
      'injector',
    ]);
  });
});

describe('gate 6: frozen held-out trials (black box)', () => {
  const frozen = resolve(APP_ROOT, 'evals/nemodots/frozen');
  const manifest = JSON.parse(
    readFileSync(resolve(frozen, 'manifest.json'), 'utf8'),
  ) as {
    classes: { class: string; file: string }[];
  };
  const trials = manifest.classes.flatMap((entry) => {
    const scenario = JSON.parse(
      readFileSync(resolve(frozen, entry.file), 'utf8'),
    ) as {
      trials: { trialId: string }[];
    };
    return scenario.trials.map((t) => [entry.class, t.trialId] as const);
  });

  it.each(trials)('%s %s', async (_cls, trialId) => {
    await bindOrFail(trialId, [
      'bootstrap',
      'workerMain',
      'injector',
      'checkoutMain',
      'seed',
      'watcher',
    ]);
  });
});
