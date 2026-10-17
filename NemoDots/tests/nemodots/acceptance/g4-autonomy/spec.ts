// Verifier-owned transcription of the parts of the specification that gate 4
// asserts against. Deliberately NOT imported from src/server/nemodots: an
// expectation read back from production would agree with a production bug.
// Sources: CONTRACTS.md section 4 (ROLE_CAPABILITIES, caps), section 5
// (policy-v1, block reasons), section 3 (retry/in-flight rules) and
// ARCHITECTURE.md sections 11 and 12.
import { createHash } from 'node:crypto';

export type Capability =
  | 'observe'
  | 'delegate'
  | 'propose_config_change'
  | 'propose_cache_flush'
  | 'publish_finding'
  | 'request_replan';

/** CONTRACTS.md section 4, ROLE_CAPABILITIES (rev2 D5). */
export const SPEC_ROLE_CAPABILITIES: Readonly<
  Record<string, readonly Capability[]>
> = Object.freeze({
  planner: [],
  investigator: ['observe', 'delegate', 'publish_finding', 'request_replan'],
  cache_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
    'propose_cache_flush',
  ],
  database_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ],
  routing_specialist: [
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ],
  verifier: ['observe', 'publish_finding'],
  postcondition: ['observe', 'publish_finding'],
});

/** ARCHITECTURE.md section 11: breadth is fixed at 4 (not an operator knob). */
export const SPEC_MAX_BREADTH = 4;
/** ARCHITECTURE.md section 11: at most 12 iterations per attempt. */
export const SPEC_MAX_ITERATIONS = 12;
/** ARCHITECTURE.md section 12 and CONTRACTS section 3: at most 4 in flight per model. */
export const SPEC_MAX_IN_FLIGHT = 4;
/** CONTRACTS.md section 3: 1 + at most 4 retries, 1 s base backoff. */
export const SPEC_MAX_RETRIES = 4;
export const SPEC_BACKOFF_BASE_MS = 1000;
/** CONTRACTS.md section 5, policy-v1 set_config: checkout.health maxAgeMs. */
export const SPEC_HEALTH_MAX_AGE_MS = 120_000;

/** policy-v1 required sources of a set_config on `key`. */
export const specRequiredSources = (key: string) => [
  `checkout.config/${key}`,
  'checkout.health',
];

/**
 * Block reasons that are legitimate for an intent whose evidence really was
 * superseded before it committed (R4: blocked(stale_version); G3 allows
 * stale_pending_observation while the replacement is unregistered).
 */
export const STALE_BLOCK_REASONS = [
  'stale_version',
  'stale_pending_observation',
] as const;

/** Statuses an intent can hold while it is still a live reservation (CONTRACTS section 5). */
export const SPEC_LIVE_OR_DONE = [
  'proposed',
  'admitted',
  'committed',
  'dispatched',
  'verified',
  'outcome_unknown',
] as const;

/**
 * CONTRACTS.md conventions: sha256 of canonical JSON (keys sorted, no
 * whitespace, strings NFC, shortest round-trip numbers). Only scalars and
 * plain arrays/objects are needed by gate 4; written here, not imported.
 */
export function specCanonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((item) => specCanonicalJson(item)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries
        .map(
          ([k, v]) =>
            `${JSON.stringify(k.normalize('NFC'))}:${specCanonicalJson(v)}`,
        )
        .join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported ${typeof value}`);
  }
}
export const specDigest = (value: unknown) =>
  createHash('sha256').update(specCanonicalJson(value)).digest('hex');
