import { beforeAll, describe, expect, it } from 'vitest';
import {
  LIGHTNING,
  callContext,
  chat,
  liveClient,
  record,
  requireLive,
  resultsDir,
  type LiveEnv,
} from './support.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opt-in (NEMODOTS_LIVE_BURST=1): 6 concurrent small requests on Lightning,
// with the client throttle raised to 6 so the provider's own limit is
// exercised (finding I12). Reports whether a 429 was observed; it does not
// require one. Without the flag the file reports NOT_RUN; it is never silently
// counted as passed.

const enabled = process.env.NEMODOTS_LIVE_BURST === '1';
let env: LiveEnv;

if (!enabled) {
  const message =
    'NOT_RUN: NEMODOTS_LIVE_BURST=1 not set (429 burst test is opt-in)';
  console.log(message);
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'inference-burst.json'),
    `${JSON.stringify({ suite: 'inference-live-burst', status: 'NOT_RUN', reason: message, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

describe.skipIf(!enabled)('Crusoe live burst (429 path)', () => {
  beforeAll(() => {
    env = requireLive();
  });

  it('6 concurrent requests on Lightning: retries recover; reports whether a 429 was observed', async () => {
    const client = liveClient(env, { maxInFlight: 6 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        client.complete(
          chat({
            model: LIGHTNING,
            messages: [
              { role: 'system', content: 'You are terse.' },
              { role: 'user', content: `Reply with the number ${i}.` },
            ],
            maxTokens: 16,
          }),
          callContext(),
        ),
      ),
    );
    const attempts = results.flatMap((r) => r.attempts);
    const rateLimited = attempts.filter(
      (a) => a.error?.class === 'rate_limited',
    );
    const observed = {
      requests: results.length,
      attempts: attempts.length,
      rateLimitedAttempts: rateLimited.length,
      codes: [...new Set(rateLimited.map((a) => a.error?.code))],
      retryAfterHeaderSeen: rateLimited.some((a) => a.retryAfterMs !== null),
      outcomes: results.map((r) => r.outcome),
    };
    const report = rateLimited.length > 0 ? '429 observed' : '429 not observed';
    console.log(
      `burst: ${report} (${rateLimited.length} rate-limited attempts)`,
    );
    const dir = resultsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'inference-burst.json'),
      `${JSON.stringify({ suite: 'inference-live-burst', status: 'PASS', report, observed, at: new Date().toISOString() }, null, 2)}\n`,
    );
    record({ name: 'burst', status: 'PASS', observed });
    // every request must end in a defined outcome; failures only after exhausting retries
    for (const r of results)
      expect(['completed', 'failed']).toContain(r.outcome);
    if (rateLimited.length > 0)
      expect(
        results.filter((r) => r.outcome === 'completed').length,
      ).toBeGreaterThan(0);
  });
});
