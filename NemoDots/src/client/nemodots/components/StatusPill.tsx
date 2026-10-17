import { statusLabel, toneForStatus, type Tone } from '../status';

/** Status as text plus a decorative dot; colour is never the only signal. */
export function StatusPill({
  status,
  label,
  tone,
}: {
  status: string;
  label?: string;
  tone?: Tone;
}) {
  const resolved = tone ?? toneForStatus(status);
  return (
    <span className={`nd-pill nd-tone-${resolved}`} data-status={status}>
      <span className="nd-dot" aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}
