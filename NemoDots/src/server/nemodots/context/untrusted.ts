import { canonicalJson, sha256Hex } from '../contracts/index.js';
import type { TruncationRecord } from './types.js';

// Delimited, escaped data blocks. Everything that did not come from the
// compiler's own instruction sections (tool results, runbooks, page text,
// memories, evidence values, task text) is rendered through this module, so
// instruction-like text stays inert data (TEST_PROMPT: prompt injection as data).
//
// Text blocks:   <data kind="k" id="i">\n| escaped line\n</data>
// JSON values:   <data kind="k" id="i" ...>{escaped canonical json}</data>
// '<', '>' and '&' never appear unescaped inside a body, so a body cannot
// close its block or open another one, and every body line starts with
// "| " so it cannot forge a section header.

export const DEFAULT_ITEM_CAP_BYTES = 4096;

const SECRET_PATTERNS: readonly RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:CRUSOE_API_KEY|OPENAI_API_KEY|CPK_INTELLIGENCE_API_KEY)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,"'}\]]+)/g,
];
const SECRET_KEY =
  /^(?:.*(?:api_?key|secret|password|passwd|token|credential|private_?key).*|crusoe_api_key|openai_api_key|cpk_intelligence_api_key)$/i;
const ACTOR_KEY = /^(?:actor|caused_?by_?actor)$/i;

/** Replace obvious credentials with a marker. Returns the text and the count. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, () => {
      count += 1;
      return '[REDACTED]';
    });
  return { text: out, count };
}

/** Drops injector-actor keys at any depth (defence in depth; D10). */
export function stripActors(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        if (ACTOR_KEY.test(key)) {
          count += 1;
          continue;
        }
        if (SECRET_KEY.test(key) && item !== null && item !== undefined) {
          count += 1;
          out[key] = '[REDACTED]';
          continue;
        }
        out[key] = walk(item);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value), count };
}

export type CappedText = {
  text: string;
  truncated: boolean;
  originalBytes: number;
  keptBytes: number;
};

/** Cut `text` to at most `capBytes` UTF-8 bytes on a code point boundary. */
export function truncateUtf8(text: string, capBytes: number): CappedText {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= capBytes)
    return { text, truncated: false, originalBytes, keptBytes: originalBytes };
  let kept = 0;
  let end = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (kept + bytes > capBytes) break;
    kept += bytes;
    end += point.length;
  }
  return {
    text: text.slice(0, end),
    truncated: true,
    originalBytes,
    keptBytes: kept,
  };
}

function token(value: string | number): string {
  return String(value)
    .replace(/[^A-Za-z0-9_./:@+-]/g, '_')
    .slice(0, 200);
}

function attributes(attrs: Readonly<Record<string, string | number>>): string {
  return Object.keys(attrs)
    .sort()
    .map((name) => ` ${token(name)}="${token(attrs[name])}"`)
    .join('');
}

function escapeLine(line: string): string {
  let out = '';
  for (const ch of line) {
    const code = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if ((code < 0x20 && ch !== '\t') || code === 0x7f)
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

/** Make canonical JSON text safe inside a single-line data element. */
export function escapeJsonText(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export type Rendered = {
  rendered: string;
  truncation: TruncationRecord | null;
  redactions: number;
};

function truncationRecord(
  kind: string,
  id: string,
  full: string,
  capped: CappedText,
): TruncationRecord | null {
  return capped.truncated
    ? {
        item: `${kind}:${id}`,
        originalBytes: capped.originalBytes,
        keptBytes: capped.keptBytes,
        originalDigest: sha256Hex(full),
      }
    : null;
}

/** Multi-line untrusted text (tool results, runbooks, pages, memories, task text). */
export function dataBlock(options: {
  kind: string;
  id: string;
  text: string;
  capBytes?: number;
  attrs?: Readonly<Record<string, string | number>>;
}): Rendered {
  const { kind, id } = options;
  const redacted = redactSecrets(options.text.normalize('NFC'));
  const capped = truncateUtf8(
    redacted.text,
    options.capBytes ?? DEFAULT_ITEM_CAP_BYTES,
  );
  const lines = capped.text
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((line) => `| ${escapeLine(line)}`);
  if (capped.truncated)
    lines.push(
      `| [truncated: kept ${capped.keptBytes} of ${capped.originalBytes} bytes]`,
    );
  return {
    rendered: `<data kind="${token(kind)}" id="${token(id)}"${attributes(options.attrs ?? {})}>\n${lines.join('\n')}\n</data>`,
    truncation: truncationRecord(kind, id, redacted.text, capped),
    redactions: redacted.count,
  };
}

/** Single-line untrusted JSON value (receipt values). One line per item. */
export function dataJson(options: {
  kind: string;
  id: string;
  value: unknown;
  capBytes?: number;
  attrs?: Readonly<Record<string, string | number>>;
}): Rendered {
  const { kind, id } = options;
  const stripped = stripActors(options.value);
  const redacted = redactSecrets(canonicalJson(stripped.value));
  const capped = truncateUtf8(
    redacted.text,
    options.capBytes ?? DEFAULT_ITEM_CAP_BYTES,
  );
  const attrs = {
    ...(options.attrs ?? {}),
    ...(capped.truncated
      ? { truncated: `${capped.keptBytes}/${capped.originalBytes}` }
      : {}),
  };
  // A cut JSON document is no longer JSON: it is carried as a string literal.
  const body = capped.truncated ? JSON.stringify(capped.text) : capped.text;
  return {
    rendered: `<data kind="${token(kind)}" id="${token(id)}"${attributes(attrs)}>${escapeJsonText(body)}</data>`,
    truncation: truncationRecord(kind, id, redacted.text, capped),
    redactions: redacted.count + stripped.count,
  };
}
