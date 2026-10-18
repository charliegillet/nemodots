// The sandbox command line, run as a real subprocess against a test database,
// and the checkout served over real HTTP on an ephemeral port.
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { Injector } from '../../../../src/server/nemodots/sandbox/injector.js';
import { loadScenario } from '../../../../src/server/nemodots/sandbox/manifest.js';
import { withSandbox, type Sandbox } from './harness.js';

function runCli(
  s: Sandbox,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/server/nemodots/sandbox/cli.ts', ...args],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH ?? '',
            LC_ALL: 'C',
            NEMODOTS_PG_URL_ADMIN: s.db.urls.admin,
            NEMODOTS_PG_URL_APP: s.db.urls.app,
            NEMODOTS_PG_URL_INJECTOR: s.db.urls.injector,
            NEMODOTS_PG_URL_VERIFIER: s.db.urls.verifier,
            NEMODOTS_PG_URL_CHECKOUT: s.db.urls.checkout,
            NEMODOTS_PROBE_SECRET: s.probeSecret,
            NEMODOTS_REDIS_URL: s.redis.url,
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('close', (code) => resolve({ code, out, err }));
    },
  );
}

describe('sandbox cli', () => {
  it('inject applies an immediate scenario and exits 0; the checkout reflects it', async () => {
    await withSandbox(async (s) => {
      const result = await runCli(s, [
        'inject',
        '--scenario',
        'writes_disabled',
        '--seed',
        '1',
      ]);
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(result.out).toContain('inject: step 0 applied');
      expect(result.out).toContain('inject: completed');
      s.reloadConfig();
      expect(
        (
          await s.request('/orders', {
            body: { items: [{ sku: 'SKU-0001', quantity: 1 }] },
          })
        ).status,
      ).toBe(503);
    });
  }, 60_000);

  it('rejects unknown scenarios and bad arguments without touching the database', async () => {
    await withSandbox(async (s) => {
      const unknown = await runCli(s, ['inject', '--scenario', 'nope_nope']);
      expect(unknown.code).toBe(1);
      const traversal = await runCli(s, ['inject', '--scenario', '../secrets']);
      expect(traversal.code).toBe(1);
      const noScenario = await runCli(s, ['inject']);
      expect(noScenario.code).toBe(2);
      const noKey = await runCli(s, ['notify-proposed']);
      expect(noKey.code).toBe(2);
      const versions = await s.pools.verifier.query(
        'SELECT count(*) AS n FROM checkout.config_versions WHERE version > 1',
      );
      expect(versions.rows[0].n).toBe('0');
    });
  }, 60_000);

  it('notify-proposed fires the armed dependent step', async () => {
    await withSandbox(async (s) => {
      const run = await new Injector({
        pool: s.pools.injector,
        listenUrl: s.db.urls.injector,
      }).start(loadScenario('dependent_change_after_proposal'), 1);
      try {
        await run.stepSettled(0);
        const sent = await runCli(s, [
          'notify-proposed',
          '--key',
          'cache.schema_version',
        ]);
        expect(sent.code).toBe(0);
        const sentAt = Number(/at=(\d+)/.exec(sent.out)![1]);
        const second = await run.stepSettled(1);
        expect(second.status).toBe('applied');
        // C15: the step fires within 500 ms of the CLI emitting the NOTIFY
        expect(second.settledAt - sentAt).toBeLessThan(500);
      } finally {
        await run.cancel();
      }
    });
  }, 60_000);

  it('seed is idempotent and probe passes against the checkout over real HTTP', async () => {
    await withSandbox(async (s) => {
      const seeded = await runCli(s, ['seed']);
      expect(seeded.code).toBe(0);
      expect(seeded.out).toContain('24 listed products, 200 orders');
      expect(seeded.out).toContain('config inserted 0');
      let server!: ReturnType<typeof serve>;
      const port = await new Promise<number>((resolve) => {
        server = serve(
          { fetch: s.runtime.app.fetch, port: 0, hostname: '127.0.0.1' },
          (info) => resolve(info.port),
        );
      });
      try {
        const probe = await runCli(s, ['probe', '--window-ms', '0'], {
          NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${port}`,
        });
        expect(probe.out).toContain('probe: PASS');
        expect(probe.code).toBe(0);
        expect(probe.out + probe.err).not.toContain(s.probeSecret);
      } finally {
        server.close();
      }
    });
  }, 60_000);
});
