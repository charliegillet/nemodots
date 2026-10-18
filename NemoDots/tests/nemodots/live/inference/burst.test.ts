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
import { INFERENCE_RETRY } from '../../../../src/server/nemodots/contracts/index.js';

import { join } from 'node:path';

// Opt-in (NEMODOTS_LIVE_BURST=1): 6 concurrent small requests on Lightning,
// with the client throttle raised to 6 so the provider's own limit is
// exercised (finding I12). Reports whether a 429 was observed; it does not
// require one. Without the flag the file reports NOT_RUN; it is never silently
// counted as passed.

const enabled = process.env.NEMODOTS_LIVE_BURST === '1';
let env: LiveEnv;

// A NOT_RUN note goes to its own file so it can never overwrite a real burst
// result; real results are kept per run (timestamped) and the newest is also
// copied to inference-burst.json.
if (!enabled) {
  const message =
    'NOT_RUN: NEMODOTS_LIVE_BURST=1 not set (429 burst test is opt-in)';
  console.log(message);
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'inference-burst.notrun.json'),
    `${JSON.stringify({ suite: 'inference-live-burst', status: 'NOT_RUN', reason: message, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

const MAX_RETRIES = INFERENCE_RETRY.maxRetries;
const RETRYABLE = new Set(['rate_limited', 'provider_unavailable']);

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
    // A failed request is acceptable only after exhausting retries on a
    // retryable class; any other failure (provider_error, invalid_*) fails.
    const unacceptable = results.filter(
      (r) =>
        r.outcome !== 'completed' &&
        !(
          r.outcome === 'failed' &&
          r.attempts.length >= 1 + MAX_RETRIES &&
          RETRYABLE.has(r.attempts.at(-1)?.error?.class ?? '')
        ),
    );
    const status = unacceptable.length === 0 ? 'PASS' : 'FAIL';
    const dir = resultsDir();
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const text = `${JSON.stringify({ suite: 'inference-live-burst', status, report, observed, unacceptableOutcomes: unacceptable.map((r) => ({ outcome: r.outcome, error: r.attempts.at(-1)?.error ?? null, attempts: r.attempts.length })), at }, null, 2)}\n`;
    writeFileSync(
      join(dir, `inference-burst-${at.replace(/[:.]/g, '-')}.json`),
      text,
    );
    writeFileSync(join(dir, 'inference-burst.json'), text);
    record({ name: 'burst', status, observed });
    expect(unacceptable).toEqual([]);
    if (rateLimited.length > 0)
      expect(
        results.filter((r) => r.outcome === 'completed').length,
      ).toBeGreaterThan(0);
  });
});
