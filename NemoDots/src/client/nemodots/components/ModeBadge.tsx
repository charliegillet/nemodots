import { CircleHelp, FlaskConical, OctagonAlert, Radio } from 'lucide-react';
import type { IntelligenceBadgeView, ModeBadgeView } from '../status';

const ICONS = {
  live: Radio,
  fixture: FlaskConical,
  blocked: OctagonAlert,
  unknown: CircleHelp,
} as const;

/** Live / Fixture / Blocked badge. Fixture is never presented as live. */
export function ModeBadge({ badge }: { badge: ModeBadgeView }) {
  const Icon = ICONS[badge.kind];
  return (
    <span
      className={`nd-badge nd-mode nd-mode-${badge.kind}`}
      role="group"
      aria-label={`Run mode: ${badge.label}. ${badge.description}`}
      title={badge.description}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{badge.label}</span>
      {badge.missingEnv.length > 0 && (
        <span className="nd-badge-detail">
          Missing {badge.missingEnv.join(', ')}
        </span>
      )}
    </span>
  );
}

/** Intelligence status, shown apart from the mission mode. */
export function IntelligenceBadge({ badge }: { badge: IntelligenceBadgeView }) {
  return (
    <span
      className={`nd-badge nd-intel nd-intel-${badge.kind}`}
      role="group"
      aria-label={`${badge.label}. ${badge.description}`}
      title={badge.description}
    >
      <span>{badge.label}</span>
    </span>
  );
}
