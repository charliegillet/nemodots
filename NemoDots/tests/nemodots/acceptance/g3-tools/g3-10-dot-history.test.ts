// Gate 3, TOOL_COVERAGE R1 and R4: what a Dot turn records in ledger.context_snapshots.
//   R1  the snapshot names the Dot and a DIGEST of its instructions, not the instructions text;
//   R4  replayed conversation history is recorded as digests and inherits the dependency vector of the turn
//       that produced it; a page edit between two turns leaves the turn-2 snapshot depending on a page revision
//       that is no longer current (its receipt is superseded).
//
// The "model" is the scripted OpenAI-compatible stream (mock) used across this folder. Expected values are
// hand-enumerated from the scenario: page P (revision 1 -> 2), thread T, two turns.
// Until src/server/nemodots/interception/provenance-middleware.ts exists these cases FAIL with ENTRY POINT MISSING.
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminQuery,
  lazyWorld,
  load,
  runDotTurn,
  type World,
} from './g3-support.js';

const lazy = lazyWorld({ nemodots: true }, async () => {
  await load('src/server/nemodots/interception/provenance-middleware.ts');
});
let w: World;
beforeEach(async () => {
  w = await lazy.get();
}, 600_000);
afterAll(async () => {
  await lazy.close();
}, 120_000);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const INCIDENT_INSTRUCTIONS = 'Investigate incidents.'; // hand copy of the instructions given in g3-support openWorld

describe('[TP3.1][R1] a Dot turn records the Dot id and an instructions digest, not the instructions', () => {
  it('ledger.context_snapshots.injected names the Dot, holds the digest of its instructions (plain or canonical form) and never the text itself', async () => {
    const since = (
      await adminQuery<{ t: string }>(
        w.db!.admin,
        `SELECT clock_timestamp()::text AS t`,
      )
    )[0].t;
    const turn = await runDotTurn(w, w.incident.id, [{ text: 'hello' }]);
    expect(turn.runError).toBeUndefined();
    const rows = await adminQuery<{ injected: unknown }>(
      w.db!.admin,
      `SELECT injected FROM ledger.context_snapshots WHERE created_at > $1::timestamptz`,
      [since],
    );
    expect(rows.length, 'the turn recorded a context snapshot').toBeGreaterThan(
      0,
    );
    const text = JSON.stringify(rows.map((row) => row.injected));
    expect(text).toContain(w.incident.id);
    const digests = [
      sha(INCIDENT_INSTRUCTIONS),
      sha(JSON.stringify(INCIDENT_INSTRUCTIONS)),
    ];
    expect(
      digests.some((d) => text.includes(d)),
      'the digest of the Dot instructions is recorded',
    ).toBe(true);
    expect(text).not.toContain(INCIDENT_INSTRUCTIONS);
  });
});

describe('[TP3.1][R4] replayed history inherits the vector of the turn that produced it', () => {
  it('turn 2 records history digests and depends on page revision 1 (read in turn 1); after the owner edit that receipt is superseded', async () => {
    const p = w.workspace.pages.create(w.spaceA, {
      title: 'History page',
      content: 'R4-HISTORY-BODY',
    });
    const key = `opendots.page/${p.id}`;
    const turn1 = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: [
          { id: 'h1', name: 'read_space_page', arguments: { id: p.id } },
        ],
      },
      { text: 'noted' },
    ]);
    expect(turn1.runError).toBeUndefined();
    const result1 = turn1.resultOf('h1');
    expect(result1 ?? '').toContain('R4-HISTORY-BODY');

    const edit = await w.authed(`/api/spaces/${w.spaceA}/pages/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 1, content: 'R4-EDITED-BODY' }),
    });
    expect(edit.status).toBe(200);
    const since = (
      await adminQuery<{ t: string }>(
        w.db!.admin,
        `SELECT clock_timestamp()::text AS t`,
      )
    )[0].t;

    // turn 2 replays turn 1 exactly as the browser would: user, assistant tool call, tool result, assistant text
    const history = [
      {
        id: 'u1',
        role: 'user',
        content: 'Please help with the incident pages.',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'h1',
            type: 'function',
            function: {
              name: 'read_space_page',
              arguments: JSON.stringify({ id: p.id }),
            },
          },
        ],
      },
      { id: 't1', role: 'tool', toolCallId: 'h1', content: result1 },
      { id: 'a2', role: 'assistant', content: 'noted' },
    ];
    const turn2 = await runDotTurn(w, w.incident.id, [{ text: 'continue' }], {
      threadId: turn1.threadId,
      history,
      prompt: 'Continue with what you read.',
    });
    expect(turn2.runError).toBeUndefined();

    const snapshots = await adminQuery<{
      injected: { historyItems?: unknown[] } | null;
      dependency_vector: {
        sourceKey: string;
        sourceRevision: number;
        receiptId: string;
      }[];
    }>(
      w.db!.admin,
      `SELECT injected, dependency_vector FROM ledger.context_snapshots WHERE created_at > $1::timestamptz`,
      [since],
    );
    expect(snapshots.length, 'turn 2 recorded a snapshot').toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      // hand-enumerated history: user, assistant tool call, tool result, assistant text = at least 4 items
      expect(
        snapshot.injected?.historyItems?.length ?? 0,
      ).toBeGreaterThanOrEqual(4);
      const entries = snapshot.dependency_vector.filter(
        (e) => e.sourceKey === key,
      );
      expect(
        entries.map((e) => e.sourceRevision),
        'the replayed tool result carries the page revision it was read at (1), not the current revision (2)',
      ).toEqual([1]);
    }
    const receipts = await adminQuery<{
      source_revision: number;
      status: string;
    }>(
      w.db!.admin,
      `SELECT r.source_revision, r.status FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1 ORDER BY r.source_revision`,
      [key],
    );
    expect(
      receipts.map((r) => [Number(r.source_revision), r.status]),
      'revision 1 is superseded by the owner edit, so the turn-2 snapshot rests on a non-current receipt',
    ).toEqual([
      [1, 'superseded'],
      [2, 'supported'],
    ]);
  });
});
