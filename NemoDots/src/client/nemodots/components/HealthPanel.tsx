import type {
  CheckoutHealthResponse,
  HealthStatus,
} from '../../../server/nemodots/contracts/index.js';
import { formatTimestamp, humanize } from '../format';
import { deriveIntelligenceBadge, deriveModeBadge } from '../status';
import { IntelligenceBadge, ModeBadge } from './ModeBadge';
import { Panel, type PanelState } from './Panel';
import { StatusPill } from './StatusPill';

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

export function HealthPanel({
  health,
  checkout,
  loading,
  error,
}: PanelState & {
  health: HealthStatus | null;
  /** proxied checkout /health, when loaded */
  checkout?: CheckoutHealthResponse | null;
}) {
  const mode = deriveModeBadge(health);
  return (
    <div className="nd-console">
      <Panel
        title="System health"
        className="nd-health"
        loading={loading}
        error={error}
        empty={health === null}
        emptyText="Health is unavailable."
      >
        {health && (
          <div>
            <p className="nd-badges">
              <ModeBadge badge={mode} />
              <IntelligenceBadge badge={deriveIntelligenceBadge(health)} />
            </p>
            <p className="nd-mode-note">{mode.description}</p>
            <dl className="nd-dl">
              <dt>Provider reachable</dt>
              <dd>{yesNo(health.provider.reachable)}</dd>
              <dt>Model listed</dt>
              <dd>{yesNo(health.provider.modelListed)}</dd>
              <dt>Model</dt>
              <dd>{health.provider.model ?? 'unavailable'}</dd>
              <dt>Provider host</dt>
              <dd>{health.provider.host ?? 'unavailable'}</dd>
              <dt>Last provider check</dt>
              <dd>{formatTimestamp(health.provider.checkedAt)}</dd>
              <dt>Postgres</dt>
              <dd>
                <StatusPill status={health.postgres} />
              </dd>
              <dt>Redis</dt>
              <dd>
                <StatusPill status={health.redis} />
              </dd>
              <dt>Checkout app</dt>
              <dd>
                {health.checkout.reachable ? (
                  <StatusPill status={health.checkout.status ?? 'unknown'} />
                ) : (
                  <StatusPill status="down" label="Unreachable" />
                )}
              </dd>
              <dt>Incident dots</dt>
              <dd>{health.incidentDotIds}</dd>
            </dl>
            {health.missingEnv.length > 0 && (
              <div className="nd-missing">
                <p>Missing environment variables (names only):</p>
                <ul aria-label="Missing environment variables">
                  {health.missingEnv.map((name) => (
                    <li key={name}>
                      <code>{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {checkout && (
              <dl className="nd-dl" aria-label="Checkout health detail">
                <dt>Checkout status</dt>
                <dd>
                  <StatusPill status={checkout.status} />
                </dd>
                <dt>Config parses</dt>
                <dd>{yesNo(checkout.config_parse)}</dd>
                <dt>Writes</dt>
                <dd>{yesNo(checkout.writes)}</dd>
                <dt>Error classes</dt>
                <dd>
                  {checkout.errorClasses.length
                    ? checkout.errorClasses.map(humanize).join(', ')
                    : 'none'}
                </dd>
                <dt>Sampled</dt>
                <dd>{formatTimestamp(checkout.sampledAt)}</dd>
              </dl>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
