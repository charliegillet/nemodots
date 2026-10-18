// Process entry of the checkout API. Started by `stack.mjs start` /
// `npm run nemodots:checkout` with an explicit minimal environment
// (NEMODOTS_PG_URL_CHECKOUT, NEMODOTS_REDIS_URL, NEMODOTS_REDIS_PREFIX,
// NEMODOTS_CHECKOUT_PORT, NEMODOTS_PROBE_SECRET): it never sees another role's
// URL (finding I3).
import { serve } from '@hono/node-server';
import { NemoDotsEnvError, parseNemoDotsEnv, pgUrl } from '../config/env.js';
import { createCheckoutApp } from './checkout-app.js';

function main() {
  const config = parseNemoDotsEnv(process.env);
  const probeSecret = config.probe.secret;
  if (!probeSecret)
    throw new NemoDotsEnvError(
      ['NEMODOTS_PROBE_SECRET'],
      'NEMODOTS_PROBE_SECRET is not set.',
    );
  const runtime = createCheckoutApp({
    pgUrl: pgUrl(config, 'checkout'),
    redisUrl: config.redis.url,
    redisPrefix: config.redis.prefix,
    probeSecret,
  });
  const server = serve({
    fetch: runtime.app.fetch,
    port: config.checkout.port,
    hostname: '127.0.0.1',
  });
  console.log(`checkout listening on 127.0.0.1:${config.checkout.port}`);
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`checkout ${signal}: shutting down`);
    const force = setTimeout(() => process.exit(0), 3_000);
    force.unref();
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
    // connections held open by clients must not delay shutdown
    (
      server as unknown as { closeAllConnections?: () => void }
    ).closeAllConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  console.error(
    `checkout: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
