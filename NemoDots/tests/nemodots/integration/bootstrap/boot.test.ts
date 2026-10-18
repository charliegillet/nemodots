// Composition root (src/server/nemodots/bootstrap.ts) against the NemoDots
// stack. See support.ts for what is real and what is a labelled double.
import net from 'node:net';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  MigrationsPendingError,
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import {
  getActivePolicy,
  hasActivePolicy,
} from '../../../../src/server/nemodots/interception/index.js';
import {
  DUMMY_LIVE,
  freePort,
  mount,
  sleep,
  until,
  withSuite,
} from './support.js';

const GOAL = 'Restore checkout availability while preserving customer data.';
const quiet = { log: () => {} };

async function json<T = Record<string, unknown>>(response: Response) {
  return (await response.json()) as T;
}

describe('blocked mode (finding I1): the missing name is reported, never a value', () => {
  for (const missing of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
  ] as const) {
    it(`without ${missing}: health lists it and mission create answers 503`, async () => {
      await withSuite(async (suite) => {
        const nd = createNemoDots(
          suite.env({
            mode: 'live',
            extra: { ...DUMMY_LIVE, [missing]: undefined },
          }),
          quiet,
        );
        const mounted = mount(nd);
        try {
          await nd.start();
          expect(nd.state).toBe('running');
          const health = await json<{
            mode: string;
            missingEnv: string[];
            postgres: string;
          }>(await mounted.get('/api/nemodots/health'));
          expect(health.mode).toBe('blocked');
          expect(health.missingEnv).toEqual([missing]);
          expect(health.postgres).toBe('ok');

          const created = await mounted.post('/api/nemodots/missions', {
            goal: GOAL,
          });
          expect(created.status).toBe(503);
          const body = await json<{ error: string; missingEnv: string[] }>(
            created,
          );
          expect(body.missingEnv).toEqual([missing]);
          expect(body.error).toContain(missing);
          const text = JSON.stringify(body);
          for (const value of Object.values(DUMMY_LIVE))
            expect(text).not.toContain(value);

          // No mission row was created behind the refusal.
          const admin = new pg.Pool({
            connectionString: suite.db.urls.admin,
            max: 1,
          });
          try {
            const { rows } = await admin.query(
              'SELECT count(*)::int AS n FROM coordinator.missions',
            );
            expect(rows[0].n).toBe(0);
          } finally {
            await admin.end();
          }
          // No worker hosts were built: there is no provider to run them on.
          expect((await nd.runtime()).workers.running).toBe(false);
        } finally {
          await nd.stop();
          mounted.close();
        }
      });
    });
  }

  it('with all three names but an unreachable provider: live, honestly unreachable, a started mission is blocked_provider', async () => {
    await withSuite(async (suite) => {
      const nd = createNemoDots(
        suite.env({ mode: 'live', extra: { ...DUMMY_LIVE } }),
        quiet,
      );
      const mounted = mount(nd);
      try {
        await nd.start();
        const health = await json<{
          mode: string;
          missingEnv: string[];
          provider: { host: string; reachable: boolean; modelListed: boolean };
        }>(await mounted.get('/api/nemodots/health'));
        expect(health.mode).toBe('live');
        expect(health.missingEnv).toEqual([]);
        expect(health.provider.host).toBe(
          new URL(DUMMY_LIVE.OPENAI_BASE_URL).host,
        );
        expect(health.provider.reachable).toBe(false);
        expect(health.provider.modelListed).toBe(false);

        const created = await mounted.post('/api/nemodots/missions', {
          goal: GOAL,
        });
        expect(created.status).toBe(201);
        const mission = await json<{ id: string; mode: string }>(created);
        expect(mission.mode).toBe('live');
        const started = await mounted.post(
          `/api/nemodots/missions/${mission.id}/start`,
          {},
        );
        expect(started.status).toBe(200);
        expect((await json<{ status: string }>(started)).status).toBe(
          'blocked_provider',
        );
      } finally {
        await nd.stop();
        mounted.close();
      }
    });
  });
});

describe('migrations', () => {
  it('start() refuses an unmigrated database and the routes say so', async () => {
    await withSuite(
      async (suite) => {
        const nd = createNemoDots(suite.env(), quiet);
        const mounted = mount(nd);
        try {
          await expect(nd.start()).rejects.toBeInstanceOf(
            MigrationsPendingError,
          );
          expect(nd.state).toBe('migrations_pending');
          const runtime = await json<{ state: string; migrations: string }>(
            await mounted.get('/api/nemodots/runtime'),
          );
          expect(runtime.state).toBe('migrations_pending');
          expect(runtime.migrations).toBe('pending');
          const refused = await mounted.get('/api/nemodots/missions');
          expect(refused.status).toBe(503);
          expect((await json<{ error: string }>(refused)).error).toMatch(
            /migrat/i,
          );
          // Health still answers; PostgreSQL itself is fine.
          const health = await json<{ postgres: string }>(
            await mounted.get('/api/nemodots/health'),
          );
          expect(health.postgres).toBe('ok');
          // Nothing was started: no outbox, no workers.
          const detail = await nd.runtime();
          expect(detail.outbox).toBe(false);
          expect(detail.workers.running).toBe(false);
        } finally {
          await nd.stop();
          mounted.close();
        }
      },
      { migrate: false },
    );
  });

  it('start() refuses a database that holds migrations this code does not know', async () => {
    await withSuite(async (suite) => {
      const admin = new pg.Pool({
        connectionString: suite.db.urls.admin,
        max: 1,
      });
      try {
        await admin.query(
          "INSERT INTO public.schema_migrations (id) VALUES ('9999_from_the_future')",
        );
      } finally {
        await admin.end();
      }
      const nd = createNemoDots(suite.env(), quiet);
      try {
        const error = await nd.start().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(MigrationsPendingError);
        expect((error as MigrationsPendingError).unknown).toEqual([
          '9999_from_the_future',
        ]);
      } finally {
        await nd.stop();
      }
    });
  });
});

describe('without the stack', () => {
  it('unconfigured: /api/nemodots/health says postgres is down, /api/state still serves', async () => {
    const nd = createNemoDots(
      { PATH: process.env.PATH, NEMODOTS_INFERENCE_MODE: 'blocked' },
      quiet,
    );
    const mounted = mount(nd);
    try {
      expect(nd.state).toBe('unconfigured');
      await nd.start();
      const state = await mounted.get('/api/state');
      expect(state.status).toBe(200);
      const health = await mounted.get('/api/nemodots/health');
      expect(health.status).toBe(200);
      const body = await json<{
        postgres: string;
        redis: string;
        mode: string;
      }>(health);
      expect(body.postgres).toBe('down');
      expect(body.redis).toBe('down');
      expect(body.mode).toBe('blocked');
      const refused = await mounted.get('/api/nemodots/missions');
      expect(refused.status).toBe(503);
    } finally {
      await nd.stop();
      mounted.close();
    }
  });

  it('a configured but stopped PostgreSQL: start resolves degraded, health says down, and the composition recovers when the database appears', async () => {
    await withSuite(async (suite) => {
      const port = await freePort();
      const real = new URL(suite.db.urls.app).port;
      const viaPort = (url: string) => {
        const next = new URL(url);
        next.port = String(port);
        return next.toString();
      };
      const env = suite.env({
        extra: {
          NEMODOTS_PG_URL_ADMIN: viaPort(suite.db.urls.admin),
          NEMODOTS_PG_URL_APP: viaPort(suite.db.urls.app),
          NEMODOTS_PG_URL_CHECKOUT: viaPort(suite.db.urls.checkout),
          NEMODOTS_PG_URL_INJECTOR: viaPort(suite.db.urls.injector),
          NEMODOTS_PG_URL_VERIFIER: viaPort(suite.db.urls.verifier),
        },
      });
      const nd = createNemoDots(env, quiet);
      const mounted = mount(nd);
      const sockets = new Set<net.Socket>();
      let proxy: net.Server | null = null;
      try {
        await nd.start();
        expect(nd.state).toBe('degraded');
        const state = await mounted.get('/api/state');
        expect(state.status).toBe(200);
        const health = await json<{ postgres: string }>(
          await mounted.get('/api/nemodots/health'),
        );
        expect(health.postgres).toBe('down');
        expect((await mounted.get('/api/nemodots/missions')).status).toBe(503);

        // PostgreSQL "starts": a forwarder appears on the configured port.
        proxy = net.createServer((client) => {
          const upstream = net.connect(Number(real), '127.0.0.1');
          sockets.add(client);
          sockets.add(upstream);
          client.pipe(upstream).pipe(client);
          const drop = () => {
            client.destroy();
            upstream.destroy();
          };
          client.on('error', drop);
          upstream.on('error', drop);
          client.on('close', drop);
          upstream.on('close', drop);
        });
        await new Promise<void>((resolve) =>
          proxy!.listen(port, '127.0.0.1', resolve),
        );
        await until(
          async () => nd.state === 'running',
          'the composition to start once PostgreSQL answers',
          20_000,
        );
        const after = await json<{ postgres: string }>(
          await mounted.get('/api/nemodots/health'),
        );
        expect(after.postgres).toBe('ok');
        expect((await mounted.get('/api/nemodots/missions')).status).toBe(200);
      } finally {
        await nd.stop();
        mounted.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          proxy ? proxy.close(() => resolve()) : resolve(),
        );
      }
    });
  });
});

describe('lifecycle', () => {
  it('start runs the outbox, the watcher and the worker hosts; stop ends them and closes every connection', async () => {
    await withSuite(async (suite) => {
      const nd = createNemoDots(suite.env({ workers: 2 }), quiet);
      const mounted = mount(nd);
      const admin = new pg.Pool({
        connectionString: suite.db.urls.admin,
        max: 1,
      });
      try {
        await nd.start();
        expect(nd.state).toBe('running');
        const runtime = await until(async () => {
          const body = await json<{
            state: string;
            workers: { configured: number; running: boolean };
            outbox: boolean;
            watcher: { leader: boolean };
            probe: string;
            injector: string;
            migrations: string;
            interception: boolean;
            provider: { mode: string; verified: boolean | null };
          }>(await mounted.get('/api/nemodots/runtime'));
          return body.watcher.leader ? body : null;
        }, 'the watcher to win the election');
        expect(runtime.state).toBe('running');
        expect(runtime.workers).toEqual({ configured: 2, running: true });
        expect(runtime.outbox).toBe(true);
        expect(runtime.probe).toBe('configured');
        expect(runtime.injector).toBe('configured');
        expect(runtime.migrations).toBe('ok');
        expect(runtime.provider.mode).toBe('fixture');
        // Hooks stay inactive without incident Dots: upstream behaviour is unchanged.
        expect(runtime.interception).toBe(false);
        expect(hasActivePolicy()).toBe(false);

        const connections = async () =>
          Number(
            (
              await admin.query(
                `SELECT count(*) AS n FROM pg_stat_activity
                  WHERE datname = $1 AND usename IN ('nemodots_app','nemodots_injector','nemodots_verifier')`,
                [suite.db.name],
              )
            ).rows[0].n,
          );
        expect(await connections()).toBeGreaterThan(0);

        await nd.stop();
        expect(nd.state).toBe('stopped');
        const after = await nd.runtime();
        expect(after.workers.running).toBe(false);
        expect(after.outbox).toBe(false);
        expect(after.watcher.leader).toBe(false);
        await until(
          async () => (await connections()) === 0,
          'every NemoDots connection to close',
          10_000,
        );
        // A stopped composition refuses work instead of hanging.
        expect((await mounted.get('/api/nemodots/missions')).status).toBe(503);
        // Idempotent.
        await nd.stop();
      } finally {
        await nd.stop();
        await admin.end();
        mounted.close();
      }
    });
  });

  it('the two worker hosts hold distinct identities', async () => {
    await withSuite(async (suite) => {
      const nd = createNemoDots(suite.env({ workers: 2 }), quiet);
      const mounted = mount(nd);
      try {
        await nd.start();
        const created = await json<{ id: string }>(
          await mounted.post('/api/nemodots/missions', { goal: GOAL }),
        );
        await mounted.post(`/api/nemodots/missions/${created.id}/start`, {});
        const admin = new pg.Pool({
          connectionString: suite.db.urls.admin,
          max: 1,
        });
        try {
          // The empty fixture cannot answer the planner, so the attempt fails;
          // what matters here is who held the lease.
          const owners = await until(async () => {
            const { rows } = await admin.query<{ lease_owner: string }>(
              'SELECT DISTINCT lease_owner FROM coordinator.task_attempts WHERE mission_id = $1',
              [created.id],
            );
            return rows.length > 0 ? rows.map((r) => r.lease_owner) : null;
          }, 'a worker to claim the planner attempt');
          for (const owner of owners) expect(owner).toMatch(/^server-\d+-/);
          await mounted.post(`/api/nemodots/missions/${created.id}/cancel`, {});
        } finally {
          await admin.end();
        }
      } finally {
        await nd.stop();
        mounted.close();
      }
    });
  });
});

describe('interception hooks (incident Dots)', () => {
  it('are installed only for listed Dots, record page revisions in the ledger, and are removed at stop', async () => {
    await withSuite(async (suite) => {
      const pages: { onRevision?: (event: unknown) => void } = {};
      const workspace = { ownerId: 'boot-suite-owner', pages } as never;
      const nd = createNemoDots(
        suite.env({ extra: { NEMODOTS_INCIDENT_DOT_IDS: 'dot-incident-1' } }),
        { ...quiet, workspace },
      );
      const admin = new pg.Pool({
        connectionString: suite.db.urls.admin,
        max: 1,
      });
      try {
        await nd.start();
        expect(hasActivePolicy()).toBe(true);
        const policy = getActivePolicy();
        expect(policy.isIncidentDot('dot-incident-1')).toBe(true);
        expect(policy.isIncidentDot('dot-ordinary')).toBe(false);
        expect(typeof pages.onRevision).toBe('function');

        pages.onRevision!({
          op: 'create',
          spaceId: 'space-1',
          pageId: 'page-boot-1',
          revision: 3,
          page: {
            id: 'page-boot-1',
            spaceId: 'space-1',
            parentId: null,
            title: 'Checkout notes',
            content: 'db.pool_max is 3',
            revision: 3,
            createdAt: 1,
            updatedAt: 2,
            sourceThreadId: null,
          },
          sourceThreadId: null,
          review: null,
          reparented: [],
        });
        const receipt = await until(async () => {
          const { rows } = await admin.query(
            `SELECT r.normalized_value, s.source_type, r.trust, r.status
               FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
              WHERE s.key = 'opendots.page/page-boot-1'`,
          );
          return rows[0] ?? null;
        }, 'the page revision to reach the ledger');
        expect(receipt.source_type).toBe('page_snapshot');
        expect(receipt.trust).toBe('page_snapshot');
        expect(receipt.status).toBe('supported');
        expect(receipt.normalized_value.revision).toBe(3);

        await nd.stop();
        expect(hasActivePolicy()).toBe(false);
        expect(pages.onRevision).toBeUndefined();
      } finally {
        await nd.stop();
        await admin.end();
      }
    });
  });
});

describe('construction', () => {
  it('createNemoDots never throws for an unusable NEMODOTS_* value; it reports and stays inert', async () => {
    const nd = createNemoDots(
      {
        NEMODOTS_PG_URL_APP:
          'postgres://nemodots_app:x@127.0.0.1:5432/nemodots',
      },
      quiet,
    );
    expect(nd.state).toBe('misconfigured');
    const health = await nd.health();
    expect(health.postgres).toBe('down');
    await nd.stop();
    await sleep(0);
  });
});
