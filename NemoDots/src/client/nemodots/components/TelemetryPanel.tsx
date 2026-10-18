import type { TelemetrySummary } from '../../../server/nemodots/contracts/index.js';
import {
  formatCount,
  formatDuration,
  formatTokens,
  humanize,
  shortId,
} from '../format';
import { Panel, type PanelState } from './Panel';

export function TelemetryPanel({
  telemetry,
  loading,
  error,
}: PanelState & { telemetry: TelemetrySummary | null }) {
  return (
    <Panel
      title="Telemetry"
      className="nd-telemetry"
      loading={loading}
      error={error}
      empty={telemetry === null}
      emptyText="Telemetry unavailable."
    >
      {telemetry && (
        <div>
          <dl className="nd-dl">
            <dt>Model calls</dt>
            <dd>{formatCount(telemetry.calls)}</dd>
            <dt>Orphaned calls</dt>
            <dd>
              {formatCount(telemetry.orphanedCalls)}
              <span className="nd-note">
                {' '}
                finished after their attempt lost its lease fence
              </span>
            </dd>
            <dt>Prompt tokens</dt>
            <dd>{formatTokens(telemetry.tokens.prompt)}</dd>
            <dt>Completion tokens</dt>
            <dd>{formatTokens(telemetry.tokens.completion)}</dd>
            <dt>Cached tokens</dt>
            <dd>
              {telemetry.tokens.cached.available
                ? formatTokens(telemetry.tokens.cached.total)
                : 'unavailable'}
            </dd>
            <dt>Time to first token</dt>
            <dd>
              {telemetry.ttftMs
                ? `p50 ${formatDuration(telemetry.ttftMs.p50)}, p95 ${formatDuration(telemetry.ttftMs.p95)}`
                : 'unavailable'}
            </dd>
            <dt>Retries</dt>
            <dd>{formatCount(telemetry.retries)}</dd>
            <dt>Errors</dt>
            <dd>{formatCount(telemetry.errors)}</dd>
          </dl>
          {telemetry.byModel.length > 0 && (
            <div className="nd-table-wrap">
              <table className="nd-table" aria-label="Usage by model">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Prompt</th>
                    <th scope="col">Completion</th>
                    <th scope="col">Cached</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.byModel.map((row) => (
                    <tr key={row.model}>
                      <th scope="row">{row.model}</th>
                      <td>{formatCount(row.calls)}</td>
                      <td>{formatTokens(row.promptTokens)}</td>
                      <td>{formatTokens(row.completionTokens)}</td>
                      <td>{formatTokens(row.cachedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {telemetry.byRole.length > 0 && (
            <div className="nd-table-wrap">
              <table className="nd-table" aria-label="Usage by role">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Prompt</th>
                    <th scope="col">Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.byRole.map((row) => (
                    <tr key={row.role}>
                      <th scope="row">{humanize(row.role)}</th>
                      <td>{formatCount(row.calls)}</td>
                      <td>{formatTokens(row.promptTokens)}</td>
                      <td>{formatTokens(row.completionTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {telemetry.prefixGroups.length > 0 && (
            <div>
              <p>Calls sharing a prompt prefix:</p>
              <ul aria-label="Prefix groups">
                {telemetry.prefixGroups.map((group) => (
                  <li key={group.prefixDigest}>
                    <code>{shortId(group.prefixDigest, 12)}</code>:{' '}
                    {formatCount(group.calls)} calls
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
