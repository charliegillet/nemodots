// Gate 6 building blocks: verifier-owned checkout data invariants and the
// frozen held-out trial list. INV-1 is implemented end to end with the
// verifier role and plain HTTP; the others fail until their entry points
// exist and the driver is bound. Trials need the full composed system.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

/** A free ephemeral port on 127.0.0.1 (never the running stack's checkout port). */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? done(address.port)
          : fail(new Error('no ephemeral port')),
      );
    });
  });
}

/**
 * Starts this suite's own checkout process on a free port with the minimal
 * checkout environment (finding I3) and returns its base URL. The stack's
 * running checkout is never contacted, reused or signalled.
 */
async function startOwnCheckout(
  entry: string,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const pass = [
    'PATH',
    'HOME',
    'NEMODOTS_INSTANCE',
    'NEMODOTS_PG_PORT',
    'NEMODOTS_REDIS_PORT',
    'NEMODOTS_REDIS_URL',
    'NEMODOTS_REDIS_PREFIX',
    'NEMODOTS_PG_URL_CHECKOUT',
    'NEMODOTS_PROBE_SECRET',
  ];
  const env: Record<string, string> = { NEMODOTS_CHECKOUT_PORT: String(port) };
  for (const name of pass)
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', entry],
    { cwd: APP_ROOT, env, stdio: 'ignore' },
  );
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await exited;
  };
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(
        `own checkout exited with code ${child.exitCode} before /health answered`,
      );
    }
    try {
      const response = await fetch(`${base}/health`);
      await response.arrayBuffer();
      return { base, stop };
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`own checkout on ${port} did not answer within 30 s`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe('gate 6: checkout data invariants (verifier access)', () => {
  it('INV-1 read-only phase leaves business data untouched', async () => {
    const entries = await requireEntries([
      'checkoutMigration',
      'checkoutMain',
      'seed',
    ]);
    const checkout = await startOwnCheckout(entries.checkoutMain as string);
    const client = new pg.Client({
      connectionString: verifierUrl(),
      application_name: 'nemodots-acceptance-verifier',
    });
    try {
      await client.connect();
      const before = await businessSnapshot(client);
      expect(before.perTable['checkout.products'].rows).toBeGreaterThan(0);
      const base = checkout.base;
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
      await client.end().catch(() => undefined);
      await checkout.stop();
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
