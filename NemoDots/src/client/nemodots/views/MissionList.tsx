import type { Mission } from '../../../server/nemodots/contracts/index.js';
import { StatusPill } from '../components/StatusPill';
import { formatTimestamp, truncate } from '../format';

/** Missions as links to #/missions/:id, newest first. */
export function MissionList({
  missions,
  loading,
  error,
  onOpen,
}: {
  missions: readonly Mission[];
  loading: boolean;
  error: string | null;
  onOpen: (missionId: string) => void;
}) {
  const sorted = [...missions].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <section className="nd-panel nd-mission-list" aria-label="Missions">
      <h3 className="nd-panel-title">Missions</h3>
      {error ? (
        <p className="nd-error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="nd-loading" role="status">
          Loading missions…
        </p>
      ) : sorted.length === 0 ? (
        <p className="nd-empty">No missions yet. Create one to begin.</p>
      ) : (
        <ul aria-label="Mission list">
          {sorted.map((mission) => (
            <li key={mission.id}>
              <a
                className="nd-task-row"
                href={`#/missions/${encodeURIComponent(mission.id)}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(mission.id);
                }}
              >
                <span className="nd-task-title">
                  {truncate(mission.goal, 120)}
                </span>
                <StatusPill status={mission.status} />
                {mission.mode === 'fixture' && (
                  <StatusPill status="fixture" label="Fixture" />
                )}
                <span className="nd-task-meta">
                  {formatTimestamp(mission.createdAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
