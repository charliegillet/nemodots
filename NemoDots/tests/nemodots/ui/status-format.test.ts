import { describe, expect, it } from 'vitest';
import {
  deriveIntelligenceBadge,
  deriveModeBadge,
  toneForStatus,
} from '../../../src/client/nemodots/status';
import {
  formatAge,
  formatDuration,
  formatTimestamp,
  formatTokens,
  humanize,
  shortId,
  truncate,
} from '../../../src/client/nemodots/format';
import { HealthStatusSchema } from '../../../src/server/nemodots/contracts/index.js';
import { health } from '../contracts/fixtures.js';

const parse = (patch: Record<string, unknown>) =>
  HealthStatusSchema.parse({ ...health(), ...patch });

describe('deriveModeBadge', () => {
  it('labels live mode with model and host', () => {
    const badge = deriveModeBadge(parse({}));
    expect(badge.kind).toBe('live');
    expect(badge.label).toBe('Live');
    expect(badge.description).toContain('api.inference.crusoecloud.com');
  });

  it('never presents fixture mode as live', () => {
    const badge = deriveModeBadge(parse({ mode: 'fixture' }));
    expect(badge.kind).toBe('fixture');
    expect(badge.label).toBe('Fixture');
    expect(badge.description).toMatch(/not a live model/);
  });

  it('lists missing environment variable names when blocked', () => {
    const badge = deriveModeBadge(
      parse({
        mode: 'blocked',
        missingEnv: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
      }),
    );
    expect(badge.kind).toBe('blocked');
    expect(badge.missingEnv).toEqual(['OPENAI_API_KEY', 'OPENAI_MODEL']);
    expect(badge.description).toContain('OPENAI_API_KEY, OPENAI_MODEL');
  });

  it('notes an unreachable provider in live mode and handles null health', () => {
    expect(
      deriveModeBadge(
        parse({ provider: { ...health().provider, reachable: false } }),
      ).description,
    ).toContain('not reachable');
    expect(deriveModeBadge(null).kind).toBe('unknown');
  });

  it('derives the Intelligence badge separately from the mode', () => {
    const blocked = parse({ intelligence: 'blocked' });
    expect(deriveModeBadge(blocked).kind).toBe('live');
    expect(deriveIntelligenceBadge(blocked).kind).toBe('blocked');
    expect(deriveIntelligenceBadge(parse({})).kind).toBe('configured');
    expect(deriveIntelligenceBadge(null).kind).toBe('unknown');
  });
});

describe('tone and format helpers', () => {
  it('maps statuses to tones with a muted fallback', () => {
    expect(toneForStatus('verified')).toBe('ok');
    expect(toneForStatus('blocked')).toBe('bad');
    expect(toneForStatus('outcome_unknown')).toBe('warn');
    expect(toneForStatus('something-new')).toBe('muted');
  });

  it('formats deterministically', () => {
    expect(formatTimestamp('2026-10-17T18:00:05.000Z')).toBe(
      '2026-10-17 18:00:05 UTC',
    );
    expect(formatTimestamp(null)).toBe('unknown');
    expect(formatTimestamp('nonsense')).toBe('unknown');
    const now = Date.parse('2026-10-17T18:10:00.000Z');
    expect(formatAge('2026-10-17T18:00:00.000Z', now)).toBe('10m ago');
    expect(formatAge('2026-10-17T18:10:30.000Z', now)).toBe('just now');
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2500)).toBe('2.5 s');
    expect(formatTokens(null)).toBe('unavailable');
    expect(formatTokens(0)).toBe('0');
    expect(humanize('stale_version')).toBe('Stale version');
    expect(shortId('abcdef0123456789')).toBe('abcdef01');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});
