import { Hono } from 'hono';
import type pg from 'pg';
import type { HealthStatus } from './contracts/index.js';
import type { WatcherStats } from './watcher/index.js';
import { createHealth } from './routes/health.js';

// Health for the composition root (ARCHITECTURE.md section 10).
//
// GET /api/nemodots/health is served by routes/health.ts and answers honestly
// from whatever is actually reachable. This module adds two things around it:
//
//   - the router a process mounts when NemoDots cannot be composed at all (no
//     NEMODOTS_PG_URL_APP, or an unusable NEMODOTS_* value). Upstream OpenDots
//     keeps serving; `/api/nemodots/health` still answers, with `postgres:
//     down` and the missing names, and every other NemoDots route answers 503;
//   - RuntimeHealth, the process-level view (what is running in THIS process)
//     served at GET /api/nemodots/runtime.
//
// Only names, counts and states are reported; never URLs, keys or error text
// that could carry a connection string.

type Env = Record<string, string | undefined>;

export type NemoDotsState =
  /** NEMODOTS_* is not configured: only /health answers. */
  | 'unconfigured'
  /** A NEMODOTS_* value is unusable: only /health answers. */
  | 'misconfigured'
  | 'created'
  | 'starting'
  | 'running'
  /** PostgreSQL was unreachable at start; the process retries in the background. */
  | 'degraded'
  /** start() refused: migrations are pending or unknown. */
  | 'migrations_pending'
  | 'stopped';

export type MigrationState =
  | 'unchecked'
  | 'ok'
  | 'pending'
  /** No admin URL in this process: the check could not run. */
  | 'unverified';

export interface RuntimeHealth {
  state: NemoDotsState;
  /** Names or a short fixed phrase; never a value. */
  detail: string | null;
  migrations: MigrationState;
  workers: { configured: number; running: boolean };
  outbox: boolean;
  watcher: { running: boolean; leader: boolean; stats: WatcherStats | null };
  probe: 'configured' | 'unconfigured';
  injector: 'configured' | 'unconfigured';
  redis: 'ok' | 'down';
  actionsSweep: boolean;
  /** Interception hooks installed (incident Dots listed). */
  interception: boolean;
  provider: {
    mode: 'live' | 'fixture' | 'blocked';
    model: string | null;
    host: string | null;
    verified: boolean | null;
    checkedAt: string | null;
  };
}

/** A pool stand-in whose every query fails: health then reports `postgres: down`. */
function downPool(): pg.Pool {
  return {
    query: () => Promise.reject(new Error('NemoDots is not configured')),
  } as unknown as pg.Pool;
}

/**
 * Router for a process in which NemoDots could not be composed. `/health`
 * reports the truth (the mode and missing names come from the environment,
 * PostgreSQL is `down`); every other route says why it is unavailable.
 */
export function createUnavailableRouter(options: {
  env: Env;
  state: Extract<NemoDotsState, 'unconfigured' | 'misconfigured'>;
  reason: string;
  now?: () => Date;
}): Hono {
  const now = options.now ?? (() => new Date());
  const health = createHealth({
    pool: downPool(),
    env: options.env,
    checkout: null,
    intelligenceConfigured: () =>
      Boolean(options.env.CPK_INTELLIGENCE_API_KEY?.trim()),
    incidentDotIds: () =>
      (options.env.NEMODOTS_INCIDENT_DOT_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean).length,
    now,
    probeTimeoutMs: 1_000,
    providerTtlMs: 10_000,
  });
  const app = new Hono();
  app.get('/health', async (c) => {
    const status: HealthStatus = await health();
    return c.json(status);
  });
  app.get('/runtime', (c) =>
    c.json({ state: options.state, detail: options.reason }),
  );
  app.all('*', (c) =>
    c.json({ error: `NemoDots is unavailable: ${options.reason}` }, 503),
  );
  return app;
}

/** Fixed, value-free description of why a route answers 503 in a state. */
export function stateNotice(state: NemoDotsState): string | null {
  switch (state) {
    case 'degraded':
      return 'NemoDots is waiting for PostgreSQL; start the stack (npm run nemodots:stack -- start).';
    case 'migrations_pending':
      return 'NemoDots refused to start: migrations are pending or unknown (npm run nemodots:migrate).';
    case 'stopped':
      return 'NemoDots has been stopped.';
    default:
      return null;
  }
}
