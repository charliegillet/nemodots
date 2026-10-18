import type { FindingNode } from '../mission-events';
import { humanize, plural, shortId } from '../format';
import { Panel, type PanelState } from './Panel';
import { UntrustedText } from './UntrustedText';

/** Findings are model claims, never evidence; every item is labelled "claim". */
export function FindingList({
  findings,
  loading,
  error,
}: PanelState & { findings: readonly FindingNode[] }) {
  return (
    <Panel
      title="Findings"
      className="nd-findings"
      loading={loading}
      error={error}
      empty={findings.length === 0}
      emptyText="No findings published yet."
    >
      <p className="nd-note">
        Findings are claims made by a model. They are not evidence until backed
        by a receipt.
      </p>
      <ul aria-label="Findings">
        {findings.map((finding) => (
          <li key={finding.id} className="nd-finding">
            <p className="nd-finding-head">
              <span className="nd-claim-tag">claim</span>
              <span>{humanize(finding.confidence)} confidence</span>
              <span className="nd-id">finding {shortId(finding.id)}</span>
              {!finding.usable && (
                <span className="nd-flag">marked unusable</span>
              )}
            </p>
            <UntrustedText text={finding.claim} />
            <p className="nd-note">
              Cites {plural(finding.supportingReceiptIds.length, 'receipt')}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
