import { useState } from 'react';
import type { Page } from '../../../server/pages';
import type { Space } from '../../../shared/types';
import { api } from '../../api';
import { openPageLink } from '../../page-navigation';
import { truncate } from '../format';
import type { ReceiptNode } from '../mission-events';

// "Save evidence page": projects the ledger receipts shown on the mission page
// into an ordinary Space page. Each line names the receipt id and revision it
// projects, so the page can never be mistaken for the evidence itself.

export function evidencePageTitle(goal: string, missionId: string): string {
  return truncate(`Evidence: ${goal.replace(/\s+/g, ' ').trim()}`, 150)
    .concat(` (${missionId.slice(0, 8)})`)
    .slice(0, 160);
}

export function buildEvidencePageMarkdown(
  missionId: string,
  goal: string,
  receipts: readonly ReceiptNode[],
): string {
  const lines = receipts.map(
    (receipt) =>
      `- \`${receipt.sourceKey || 'unknown source'}\` revision ${
        receipt.sourceRevision ?? 'unknown'
      }: ${receipt.status} (projection of ledger fact ${receipt.id} rev ${
        receipt.sourceRevision ?? 'unknown'
      })`,
  );
  return [
    `# Evidence for mission ${missionId}`,
    '',
    `Goal: ${goal.replace(/\s+/g, ' ').trim()}`,
    '',
    `Mission page: [#/missions/${missionId}](#/missions/${missionId})`,
    '',
    'This page is a projection of ledger receipts at the time it was saved. The ledger stays the source of truth.',
    '',
    ...(lines.length ? lines : ['No receipts were recorded yet.']),
    '',
  ].join('\n');
}

export function SaveEvidencePage({
  missionId,
  goal,
  receipts,
  spaces,
}: {
  missionId: string;
  goal: string;
  receipts: readonly ReceiptNode[];
  spaces: readonly Pick<Space, 'id' | 'name'>[];
}) {
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Page | null>(null);
  const target = spaces.find((space) => space.id === spaceId) ?? spaces[0];

  const save = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const page = await api<Page>(`/spaces/${target.id}/pages`, 'POST', {
        title: evidencePageTitle(goal, missionId),
        content: buildEvidencePageMarkdown(missionId, goal, receipts),
      });
      setSaved(page);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'Could not save the evidence page.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nd-save" role="group" aria-label="Save evidence page">
      {spaces.length > 1 && (
        <label className="nd-field nd-inline-field">
          <span>Space</span>
          <select
            value={target?.id ?? ''}
            disabled={busy}
            onChange={(event) => setSpaceId(event.target.value)}
          >
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        disabled={busy || !target || receipts.length === 0}
        title={
          !target
            ? 'No Space is available to hold the page.'
            : receipts.length === 0
              ? 'There is no evidence to save yet.'
              : `Save a projection of ${receipts.length} receipts to ${target.name}`
        }
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Save evidence page'}
      </button>
      {error && (
        <p className="nd-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p role="status">
          Saved{' '}
          <a
            href={`#/spaces/${saved.spaceId}/pages/${saved.id}`}
            onClick={(event) => {
              event.preventDefault();
              openPageLink(`/#/spaces/${saved.spaceId}/pages/${saved.id}`);
            }}
          >
            {saved.title}
          </a>
          .
        </p>
      )}
    </div>
  );
}
