// Pure formatting helpers for the NemoDots mission views. Deterministic (UTC,
// en-US) so server-rendered markup in tests does not depend on the host locale.

const UNKNOWN = 'unknown';

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return UNKNOWN;
  return id.length <= length ? id : id.slice(0, length);
}

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `2026-10-17 18:00:05 UTC`, or `unknown` for a missing or invalid value. */
export function formatTimestamp(value: string | null | undefined): string {
  const ms = parseTime(value);
  if (ms === null) return UNKNOWN;
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Age of `value` relative to `nowMs`; clock skew into the future reads as "just now". */
export function formatAge(
  value: string | null | undefined,
  nowMs: number,
): string {
  const ms = parseTime(value);
  if (ms === null) return UNKNOWN;
  const seconds = Math.floor((nowMs - ms) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return UNKNOWN;
  return Math.round(value).toLocaleString('en-US');
}

/** Token counts where `null` means the provider did not report the field. */
export function formatTokens(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'unavailable'
    : formatCount(value);
}

/** `stale_version` -> `Stale version`. */
export function humanize(value: string | null | undefined): string {
  if (!value) return UNKNOWN;
  const text = value.replace(/[_.]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function plural(count: number, noun: string, pluralForm?: string) {
  return `${formatCount(count)} ${count === 1 ? noun : (pluralForm ?? `${noun}s`)}`;
}
