import type { HealthStatus } from '../../server/nemodots/contracts/index.js';
import { humanize } from './format';

// Status derivation shared by the badges and pills. Every status is also
// rendered as text, so colour is never the only signal.

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

export type ModeKind = 'live' | 'fixture' | 'blocked' | 'unknown';
export interface ModeBadgeView {
  kind: ModeKind;
  label: string;
  description: string;
  /** Environment variable names only, never values. */
  missingEnv: string[];
}

export function deriveModeBadge(health: HealthStatus | null): ModeBadgeView {
  if (!health)
    return {
      kind: 'unknown',
      label: 'Mode unknown',
      description: 'Health has not been loaded, so the run mode is not known.',
      missingEnv: [],
    };
  const missingEnv = [...health.missingEnv];
  switch (health.mode) {
    case 'live': {
      const via = `${health.provider.model ?? 'an unknown model'} via ${health.provider.host ?? 'an unknown host'}`;
      return {
        kind: 'live',
        label: 'Live',
        description: `Live mode: Nemotron reasoning runs on ${via}.${
          health.provider.reachable ? '' : ' The provider is not reachable.'
        }`,
        missingEnv,
      };
    }
    case 'fixture':
      return {
        kind: 'fixture',
        label: 'Fixture',
        description:
          'Fixture mode: model responses are scripted fixtures, not a live model.',
        missingEnv,
      };
    case 'blocked':
      return {
        kind: 'blocked',
        label: 'Blocked',
        description: missingEnv.length
          ? `Blocked: live mode needs ${missingEnv.join(', ')}.`
          : 'Blocked: live mode is not available.',
        missingEnv,
      };
  }
}

export type IntelligenceKind = 'configured' | 'blocked' | 'unknown';
export interface IntelligenceBadgeView {
  kind: IntelligenceKind;
  label: string;
  description: string;
}

/** Intelligence (OpenDots conversations) is reported separately from the mission mode. */
export function deriveIntelligenceBadge(
  health: HealthStatus | null,
): IntelligenceBadgeView {
  if (!health)
    return {
      kind: 'unknown',
      label: 'Intelligence unknown',
      description: 'Health has not been loaded.',
    };
  return health.intelligence === 'configured'
    ? {
        kind: 'configured',
        label: 'Intelligence configured',
        description: 'OpenDots conversations are available.',
      }
    : {
        kind: 'blocked',
        label: 'Intelligence blocked',
        description:
          'OpenDots conversations are unavailable. Mission control does not depend on them.',
      };
}

const TONES: Record<string, Tone> = {
  // good
  succeeded: 'ok',
  verified: 'ok',
  supported: 'ok',
  published: 'ok',
  pass: 'ok',
  ok: 'ok',
  configured: 'ok',
  live: 'ok',
  resolved: 'ok',
  fresh: 'ok',
  applied: 'ok',
  already_applied: 'ok',
  // in motion
  running: 'info',
  leased: 'info',
  runnable: 'info',
  repairing: 'info',
  proposed: 'info',
  admitted: 'info',
  committed: 'info',
  dispatched: 'info',
  created: 'info',
  open: 'info',
  // needs attention
  pending: 'warn',
  waiting: 'warn',
  paused: 'warn',
  contested: 'warn',
  superseded: 'warn',
  expired: 'warn',
  invalidated: 'warn',
  outcome_unknown: 'warn',
  degraded: 'warn',
  awaiting_acceptance: 'warn',
  blocked_provider: 'warn',
  stale: 'warn',
  fixture: 'warn',
  fence_newer: 'warn',
  unknown: 'warn',
  // bad
  failed: 'bad',
  blocked: 'bad',
  retracted: 'bad',
  down: 'bad',
  fail: 'bad',
  aborted: 'bad',
  mismatch: 'bad',
  // neutral
  cancelled: 'muted',
};

export function toneForStatus(status: string): Tone {
  return TONES[status] ?? 'muted';
}

export function statusLabel(status: string): string {
  return humanize(status);
}
