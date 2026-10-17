import type { ReceiptNode } from '../mission-events';
import { formatAge, formatTimestamp, humanize, shortId } from '../format';
import { Panel, type PanelState } from './Panel';
import { StatusPill } from './StatusPill';

const ORIGIN: Record<string, string> = {
  none: 'External observation',
  verified: 'Own write, verified',
  mismatch: 'Own write, mismatch',
};

function LastConfirmed({
  value,
  nowMs,
}: {
  value: string | null;
  nowMs?: number;
}) {
  if (value === null) return <span>Never confirmed</span>;
  return (
    <time dateTime={value}>
      {formatTimestamp(value)}
      {nowMs !== undefined && ` (${formatAge(value, nowMs)})`}
    </time>
  );
}

export function EvidenceLedger({
  receipts,
  nowMs,
  loading,
  error,
}: PanelState & {
  receipts: readonly ReceiptNode[];
  /** when set, ages are shown next to timestamps */
  nowMs?: number;
}) {
  return (
    <Panel
      title="Evidence ledger"
      className="nd-ledger"
      loading={loading}
      error={error}
      empty={receipts.length === 0}
      emptyText="No evidence recorded yet."
    >
      <div className="nd-table-wrap">
        <table className="nd-table" aria-label="Evidence receipts">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Revision</th>
              <th scope="col">Status</th>
              <th scope="col">Trust</th>
              <th scope="col">Origin</th>
              <th scope="col">Last confirmed</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id}>
                <th scope="row">
                  <code>{receipt.sourceKey || 'unknown source'}</code>
                  <span className="nd-id">receipt {shortId(receipt.id)}</span>
                  {receipt.supersedes && (
                    <span className="nd-id">
                      supersedes {shortId(receipt.supersedes)}
                    </span>
                  )}
                </th>
                <td>{receipt.sourceRevision ?? 'unknown'}</td>
                <td>
                  <StatusPill status={receipt.status} />
                </td>
                <td>{receipt.trust ? humanize(receipt.trust) : 'unknown'}</td>
                <td>
                  {receipt.selfWrite
                    ? (ORIGIN[receipt.selfWrite] ?? humanize(receipt.selfWrite))
                    : 'unknown'}
                </td>
                <td>
                  <LastConfirmed
                    value={receipt.lastConfirmedAt}
                    nowMs={nowMs}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
