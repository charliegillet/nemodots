// Authentication of the probe tag. The checkout API tags an order with
// `probe_run_id` (and the probe's PROBE-SKU scope) only when the
// `X-NemoDots-Probe: <runId>.<hmac>` header carries an HMAC of the run id under
// NEMODOTS_PROBE_SECRET, so an ordinary client can never hide an order from the
// normalized observations by claiming it is a probe order.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROBE_HEADER = 'x-nemodots-probe';
export const PROBE_RUN_PATTERN = /^[a-z0-9-]{8,64}$/;

const mac = (secret: string, runId: string) =>
  createHmac('sha256', secret).update(`probe-run:${runId}`).digest('hex');

export function probeHeaderValue(secret: string, runId: string) {
  if (!PROBE_RUN_PATTERN.test(runId))
    throw new RangeError('probe run id must match ^[a-z0-9-]{8,64}$');
  return `${runId}.${mac(secret, runId)}`;
}

export type ProbeHeader =
  { kind: 'absent' } | { kind: 'valid'; runId: string } | { kind: 'invalid' };

export function parseProbeHeader(
  secret: string,
  value: string | null | undefined,
): ProbeHeader {
  if (value === undefined || value === null || value === '')
    return { kind: 'absent' };
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return { kind: 'invalid' };
  const runId = value.slice(0, dot);
  const given = value.slice(dot + 1);
  if (!PROBE_RUN_PATTERN.test(runId) || !/^[0-9a-f]{64}$/.test(given))
    return { kind: 'invalid' };
  const expected = mac(secret, runId);
  const ok = timingSafeEqual(
    Buffer.from(given, 'hex'),
    Buffer.from(expected, 'hex'),
  );
  return ok ? { kind: 'valid', runId } : { kind: 'invalid' };
}
