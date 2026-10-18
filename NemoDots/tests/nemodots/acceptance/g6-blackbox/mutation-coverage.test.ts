/* eslint-disable @typescript-eslint/no-explicit-any */
// G6.10 explicit statement of which gate-8 mutations the black-box gate 6
// suite can catch, and which only gate 2/8 can. The table is checked against
// the frozen mutation list and against the files of this suite, so the claim
// cannot drift: a covered mutation must be named by a race test and by a
// scorer-shaped test, an uncovered one must be listed as not covered.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from './helpers/config.js';
import { loadThresholds } from './helpers/frozen.js';
import {
  aggregate,
  scoreInvalidationCoverage,
  scoreSafety,
  scoreTrial,
} from './helpers/scoring.js';
import { goodRecord } from './helpers/synthetic.js';

const thresholds = loadThresholds();
const here = new URL('.', import.meta.url).pathname;
const read = (file: string) => readFileSync(resolve(here, file), 'utf8');

interface Row {
  mutation: string;
  /** how G6 catches it, or null when G6 does not */
  g6: { race: string | null; scorer: string } | null;
  gate2: string;
  note: string;
}

export const COVERAGE: Row[] = [
  {
    mutation: 'bypass_final_version_check',
    g6: {
      race: 'R1 stale between preliminary read and commit (adapter-races.test.ts)',
      scorer: 'INV-7 expectedTargetVersion/vector ordering',
    },
    gate2: 'ADM-02, ADM-03b, ADM-04, ADM-07',
    note: 'in the live dependent-change trials the change usually lands before admission (3000 ms minimum age), so the final check is not reached there; only R1 forces it',
  },
  {
    mutation: 'ignore_fencing',
    g6: {
      race: 'R6 zombie worker after lease expiry (adapter-races.test.ts)',
      scorer: 'commitsUnderObsoleteFence',
    },
    gate2: 'LS-3, ADM-09, ADM-15',
    note: 'SIGKILL leaves no zombie; only SIGSTOP/SIGCONT does',
  },
  {
    mutation: 'skip_effect_marker',
    g6: {
      race: 'R4 and R5 (adapter-races.test.ts)',
      scorer: 'independent Redis effect-marker count per action',
    },
    gate2: 'ADM-11d, ADM-12a',
    note: 'counted by a verifier keyspace subscriber, not by system events',
  },
  {
    mutation: 'drop_inherited_edges',
    g6: {
      race: null,
      scorer: 'independent missed-invalidation derivation (G6.7)',
    },
    gate2: 'CL-1, CL-2a, CL-3, ADM-07b',
    note: 'caught in live trials only when the team delegates or chains tasks across the superseded receipt; the scorer shape is proven by self-tests',
  },
  {
    mutation: 'accept_duplicate_differing_payloads',
    g6: null,
    gate2: 'ADM-05a, ADM-05d',
    note: 'NOT COVERED by G6: no external entry point submits an intent with a chosen idempotency key, and the harness never submits intents. The scorer rejects the resulting history shape, but nothing in G6 can provoke it.',
  },
  {
    mutation: 'skip_freshness',
    g6: null,
    gate2: 'ADM-17, LG-09',
    note: 'NOT COVERED by G6: freshness windows need a controlled evidence age, which only the in-process gate 2 harness sets.',
  },
];

describe('G6.10 which gate-8 mutations gate 6 covers', () => {
  it('G6.10 the table lists exactly the frozen mutation catalogue', () => {
    const doc = readFileSync(
      resolve(APP_ROOT, 'docs/nemodots/ACCEPTANCE_CONTRACT.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('### 4.2'), doc.indexOf('### 4.3'));
    const frozen = [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(frozen.length).toBe(6);
    expect(COVERAGE.map((r) => r.mutation).sort()).toEqual([...frozen].sort());
  });

  it('G6.10 every covered mutation is named by a race test that expects it to fail; uncovered ones are stated', () => {
    const races = read('adapter-races.test.ts');
    for (const row of COVERAGE) {
      if (row.g6?.race)
        expect(
          races.includes(`G6.10 ${row.mutation} is caught by`),
          `${row.mutation} has a mutation race test`,
        ).toBe(true);
      if (row.g6 === null)
        expect(row.note, row.mutation).toContain('NOT COVERED by G6');
    }
  });

  it('G6.10 the scorer rejects the history shape of each mutation it can see', () => {
    // bypass_final_version_check: a commit written under a version the key had already left
    const stale = goodRecord();
    stale.snapshot!.actions[0].expectedTargetVersion = 1 as never;
    expect(scoreSafety(stale).metrics.staleControlledCommits).toBeGreaterThan(
      0,
    );

    // ignore_fencing: a commit under an invalid author fence
    const fenced = goodRecord();
    fenced.snapshot!.authorizations[1].authorFence = {
      token: 0,
      valid: false,
    } as never;
    expect(
      scoreSafety(fenced).metrics.commitsUnderObsoleteFence,
    ).toBeGreaterThan(0);

    // accept_duplicate_differing_payloads: one idempotency key, two payloads, both committed
    const twin = goodRecord();
    twin.snapshot!.actions.push({
      ...twin.snapshot!.actions[0],
      id: 'twin' as never,
      payloadHash: 'e'.repeat(64) as never,
    });
    const message = scoreSafety(twin).details.duplicateExternalEffects.join();
    expect(message).toContain('differing payloads');

    // skip_effect_marker: a flush reported applied with no marker, or two markers
    const flushed = goodRecord();
    const flush = {
      ...flushed.snapshot!.actions[0],
      id: 'a0000000-0000-4000-8000-0000000000f1' as never,
      action: 'flush_cache_namespace',
      idempotencyKey: 'f'.repeat(64) as never,
      payload: { namespace: 'ns', reason: 'r' },
    };
    flushed.snapshot!.actions.push(flush as never);
    flushed.events.push({
      id: 30,
      kind: 'action.dispatched',
      receivedAt: 1,
      payload: { actionId: flush.id, scriptResult: 'applied' },
    });
    flushed.frozen.expected!.flushAllowed = true;
    flushed.redisEffects!.markerSets = {};
    expect(
      scoreSafety(flushed).details.duplicateExternalEffects.join(),
    ).toContain('not exactly 1');
    flushed.redisEffects!.markerSets = { [flush.id]: 2 };
    expect(
      scoreSafety(flushed).metrics.duplicateExternalEffects,
    ).toBeGreaterThan(0);
    flushed.redisEffects!.markerSets = { [flush.id]: 1 };
    expect(
      scoreSafety(flushed).details.duplicateExternalEffects.join(),
    ).not.toContain('not exactly 1');

    // drop_inherited_edges: work that rested on the superseded receipt is not reported affected
    const edges = goodRecord();
    const s = edges.snapshot as any;
    s.tasks.push({
      id: 'child',
      status: 'succeeded',
      role: 'routing_specialist',
      parentId: s.tasks[0].id,
      prerequisites: [s.tasks[0].id],
      createdByModelCallId: null,
    });
    s.invalidations = [
      {
        id: 'inv',
        missionIds: [s.mission.id],
        sourceKey: 'checkout.config/orders.write_enabled',
        oldReceiptId: s.receipts[0].id,
        newReceiptId: s.receipts[1].id,
        createdAt: new Date(Date.now()).toISOString(),
        perMission: [
          {
            missionId: s.mission.id,
            affected: {
              modelCallIds: [],
              attemptIds: [],
              outputIds: [],
              actionIds: [],
              taskIds: [s.tasks[0].id],
            },
            preserved: { taskIds: [] },
          },
        ],
      },
    ];
    expect(scoreInvalidationCoverage(edges).missed).toBe(1);
    expect(aggregate([scoreTrial(edges, thresholds)], thresholds).gate).toBe(
      'FAIL',
    );
  });
});
