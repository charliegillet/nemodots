import { createHash } from 'node:crypto';
import { z } from 'zod';

// CONTRACTS.md conventions: digests are lowercase hex SHA-256 of canonical
// JSON (keys sorted, no whitespace, strings NFC, numbers as shortest
// round-trip, `undefined` omitted).

export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Digest = z.infer<typeof DigestSchema>;

export class CanonicalJsonError extends TypeError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || '<root>'}`);
    this.name = 'CanonicalJsonError';
  }
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new CanonicalJsonError('non-finite number', path);
      // JSON.stringify emits the shortest round-trip form; -0 becomes 0.
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
  const object = value as object;
  if (seen.has(object)) throw new CanonicalJsonError('cycle', path);
  const json = (object as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function')
    return encode((json as () => unknown).call(object), path, seen);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object
        .map((item, index) => {
          if (item === undefined)
            throw new CanonicalJsonError(
              'undefined array element',
              `${path}[${index}]`,
            );
          return encode(item, `${path}[${index}]`, seen);
        })
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null)
      throw new CanonicalJsonError('non-plain object', path);
    const entries = new Map<string, unknown>();
    for (const [rawKey, item] of Object.entries(object)) {
      if (item === undefined) continue;
      const key = rawKey.normalize('NFC');
      if (entries.has(key))
        throw new CanonicalJsonError(`duplicate key after NFC "${key}"`, path);
      entries.set(key, item);
    }
    return `{${[...entries.keys()]
      .sort(compareCodeUnits)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${encode(entries.get(key), `${path}.${key}`, seen)}`,
      )
      .join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** Canonical JSON text of a JSON-compatible value. Throws CanonicalJsonError otherwise. */
export function canonicalJson(value: unknown): string {
  if (value === undefined)
    throw new CanonicalJsonError('undefined value', '');
  return encode(value, '', new Set());
}

/** UTF-8 byte length of the canonical JSON form (used for the 16/32 KiB bounds). */
export function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function sha256Hex(text: string): Digest {
  return createHash('sha256').update(text, 'utf8').digest('hex') as Digest;
}

/** Lowercase hex SHA-256 of the canonical JSON of `value`. */
export function digest(value: unknown): Digest {
  return sha256Hex(canonicalJson(value));
}

/** Refinement helper: value must be canonical-JSON encodable within `maxBytes`. */
export function boundedCanonical(maxBytes: number) {
  return (value: unknown, ctx: z.RefinementCtx) => {
    let bytes: number;
    try {
      bytes = canonicalByteLength(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `not canonical JSON: ${(error as Error).message}`,
      });
      return;
    }
    if (bytes > maxBytes)
      ctx.addIssue({
        code: 'custom',
        message: `canonical size ${bytes} exceeds ${maxBytes} bytes`,
      });
  };
}
