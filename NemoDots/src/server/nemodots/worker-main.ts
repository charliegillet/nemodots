import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NemoDotsEnvError,
  parseNemoDotsEnv,
  type NemoDotsConfig,
} from './config/env.js';
import {
  MigrationsPendingError,
  checkMigrations,
  createCore,
  resolveNemoDotsEnv,
  type Core,
} from './bootstrap.js';

// A separate worker process (finding I9): the same worker host and the same
// team handler as the in-process hosts, composed by the same createCore(), so
// there is no second implementation of an attempt. Run it with
//
//   npm run nemodots:worker
//
// next to a server started with NEMODOTS_WORKERS=0 (or alongside in-process
// workers). It claims attempts through the coordinator, so a SIGKILL leaves
// leases that the reaper in the server process expires and requeues; the fence
// rejects anything this process publishes late.
//
// It opens the app role (and Redis for the redis.stats reader) only: no
// verifier, no injector, no watcher, no outbox.
//
// Exit codes: 0 clean stop; 1 failed to start; 2 BLOCKED (inference
// requirements unmet or database unconfigured).

type Env = Record<string, string | undefined>;

export interface WorkerMain {
  core: Core;
  stop(): Promise<void>;
}

/** Composes and starts the worker hosts. Rejects with a BLOCKED message when it cannot run. */
export async function startWorkerMain(
  rawEnv: Env = process.env,
  log: (line: string) => void = (line) =>
    console.log(`[nemodots-worker] ${line}`),
): Promise<WorkerMain> {
  const env = resolveNemoDotsEnv(rawEnv, process.cwd());
  const config: NemoDotsConfig = parseNemoDotsEnv(env);
  if (!config.pg.urls.app) throw new BlockedStart(['NEMODOTS_PG_URL_APP']);
  const core = createCore(env, config, { role: 'worker', log });
  try {
    if (core.mode === 'blocked' || !core.inference)
      throw new BlockedStart(
        core.resolved.mode === 'blocked'
          ? [...core.resolved.missingEnv, ...core.resolved.invalidEnv]
          : ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
      );
    if (core.hosts.length === 0)
      throw new BlockedStart(['NEMODOTS_WORKERS (set it above 0)']);
    await core.pools.app.query('SELECT 1');
    const migrations = await checkMigrations(config);
    await core.connectRedis();
    const verified = await core.verifyProvider();
    log(
      `provider ${core.inference.host()} model ${core.models.worker}: ${
        verified ? 'verified' : 'NOT verified'
      }; migrations ${migrations}`,
    );
    for (const host of core.hosts) host.start();
    log(`ready: ${core.hosts.length} worker(s), instance ${config.instance}`);
  } catch (error) {
    await core.close().catch(() => undefined);
    throw error;
  }
  let stopping: Promise<void> | null = null;
  return {
    core,
    stop() {
      stopping ??= (async () => {
        await Promise.allSettled(core.hosts.map((host) => host.stop()));
        await core.close();
      })();
      return stopping;
    },
  };
}

export class BlockedStart extends Error {
  constructor(readonly names: string[]) {
    super(`BLOCKED: set ${names.join(', ')}`);
    this.name = 'BlockedStart';
  }
}

async function main(): Promise<number> {
  let worker: WorkerMain;
  try {
    worker = await startWorkerMain();
  } catch (error) {
    if (error instanceof BlockedStart) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof NemoDotsEnvError) {
      console.error(`worker: ${error.names.join(', ')} is unusable`);
      return 2;
    }
    if (error instanceof MigrationsPendingError) {
      console.error(error.message);
      return 1;
    }
    console.error(
      `worker: failed to start (${error instanceof Error ? error.name : 'error'})`,
    );
    return 1;
  }
  return new Promise<number>((resolve) => {
    const stop = () => {
      worker.stop().then(
        () => resolve(0),
        () => resolve(1),
      );
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked && pathToFileURL(invoked).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
