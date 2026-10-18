// A separate NemoDots worker process (finding I9): the same worker host and
// the same Nemotron team handler as the server, in its own process, so a
// worker can be killed (SIGKILL) and replaced without touching the server.
//
//   npm run nemodots:worker
//
// It holds the app role only through the shared runtime builder (the verifier
// and injector pools are created lazily by pg and never used here). It starts
// no outbox, watcher or routes; the server owns those. Live mode needs the
// three OPENAI_* names; without them it prints BLOCKED with the names and
// exits non-zero. No fallback provider.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NemoDotsEnvError } from './config/env.js';
import { buildRuntime } from './bootstrap.js';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

// Fills only names that are unset; never overrides the environment.
if (process.env.NEMODOTS_ENV_FILE !== 'none')
  try {
    process.loadEnvFile(path.join(APP_ROOT, '.env'));
  } catch {
    /* no .env: the environment must already carry the variables */
  }

async function main(): Promise<number> {
  const ownerId = process.env.OWNER_ID ?? 'opendots-owner';
  let runtime;
  try {
    runtime = buildRuntime(process.env, {
      workspace: { ownerId },
      log: (event, detail) =>
        console.log(`worker: ${event}`, detail ? JSON.stringify(detail) : ''),
    });
  } catch (error) {
    const names =
      error instanceof NemoDotsEnvError ? error.names.join(', ') : 'unknown';
    console.error(`BLOCKED: ${names} missing or invalid`);
    return 2;
  }
  if (runtime.mode.mode === 'blocked' || !runtime.handler) {
    const names = [
      ...(runtime.mode.mode === 'blocked'
        ? [...runtime.mode.missingEnv, ...runtime.mode.invalidEnv]
        : []),
    ];
    console.error(`BLOCKED: ${names.join(', ') || 'inference mode'} missing`);
    await runtime.close();
    return 2;
  }
  const workerId = `worker-main-${process.pid}-${randomUUID().slice(0, 8)}`;
  const concurrency = Math.max(
    1,
    Number(process.env.NEMODOTS_WORKER_CONCURRENCY ?? 1) || 1,
  );
  const host = runtime.coordinator.createWorkerHost({
    workerId,
    handler: runtime.handler,
    concurrency,
    onError: (error) =>
      console.error(
        'worker: error',
        error instanceof Error ? error.message : 'unknown',
      ),
  });
  host.start();
  console.log(`worker: ${workerId} started (concurrency ${concurrency})`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await host.stop().catch(() => undefined);
  await runtime.close();
  console.log('worker: stopped');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      'worker: fatal',
      error instanceof Error ? error.message : 'unknown',
    );
    process.exit(1);
  },
);
