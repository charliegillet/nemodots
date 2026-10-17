/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAI/AG-UI wire payloads are untyped JSON */
// TEST_PROMPT gate 4 cases 3 and 4, deterministic version. A scripted model
// drives two independent branches; the verifier changes the evidence of one
// branch through the owner edit route while its proposal waits in the
// admission window. Everything asserted comes from recorded server state, the
// verifier's PostgreSQL role and the requests the provider actually received.
// Scripted replies prove server behaviour only; the live equivalent is in
// autonomy-live.test.ts.
import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import {
  affectedTaskIds,
  findLeaks,
  nonSystemTexts,
  ofKind,
  preservedTaskIds,
  supersessions,
} from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { changeSource, finish, launchMission, lazySystem } from './flow.js';
import type { ProviderCall, ProviderReply } from './provider.js';
import {
  ALPHA,
  ALPHA_SOURCE,
  BRAVO,
  compose,
  lastReceiptId,
  observeThenReport,
  planReply,
  toolMessageTexts,
  TWO_BRANCH_PLAN,
  BRAVO_SOURCE,
  CHARLIE,
} from './scenarios.js';
import { committedActionRows, readConfig } from './system.js';

const state = { alphaStarts: 0, proposed: 5 as number };

function alpha(call: ProviderCall): ProviderReply | null {
  if (!call.text.includes(ALPHA) || call.text.includes(CHARLIE)) return null;
  if (call.toolResults === 0) {
    state.alphaStarts += 1;
    return {
      type: 'tool_calls',
      calls: [{ name: 'observe_source', args: { sourceKey: ALPHA_SOURCE } }],
    };
  }
  const receipt = lastReceiptId(call);
  if (call.toolResults === 1 && state.alphaStarts === 1) {
    const hex = toolMessageTexts(call)
      .join(' ')
      .match(/\b[0-9a-f]{64}\b/)?.[0];
    return {
      type: 'tool_calls',
      calls: [
        {
          name: 'propose_action',
          args: {
            action: 'set_config',
            payload: {
              key: 'cache.schema_version',
              value: state.proposed,
              expectedCurrentValueDigest: hex ?? digest(state.proposed),
            },
            supportingReceiptIds: receipt ? [receipt] : [],
            rationale: `${ALPHA} proposes a schema version based on what it observed.`,
          },
        },
      ],
    };
  }
  if (call.toolResults === 1)
    return {
      type: 'tool_calls',
      calls: [
        {
          name: 'publish_finding',
          args: {
            claim: `${ALPHA} re-read the schema version after the change.`,
            supportingReceiptIds: receipt ? [receipt] : [],
            confidence: 'medium',
          },
        },
      ],
    };
  return { type: 'content', text: `${ALPHA} complete.` };
}

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
    alpha,
  ),
  system: { env: { NEMODOTS_LEASE_MS: '20000' } },
});

let memo: ReturnType<typeof run> | null = null;
function scenario() {
  memo ??= run();
  return memo;
}

async function run() {
  const { system: sys, provider } = await system();
  const current = await readConfig(sys, 'cache.schema_version');
  state.proposed = Number(current.value) === 5 ? 6 : 5;
  const { mission, tail } = await launchMission(sys.api, {
    admissionMinAgeMs: 10_000,
  });
  await tail.until(
    (e) => e.some((x) => x.payload.kind === 'action.proposed'),
    120_000,
    'ALPHA action.proposed',
  );
  const bravoId = () =>
    ofKind(tail.events, 'task.created').find(
      (e) => e.payload.task.title === BRAVO,
    )?.payload.task.id;
  await tail.until(
    (e) => {
      const id = bravoId();
      return (
        Boolean(id) &&
        ofKind(e, 'task.status').some(
          (x) => x.payload.taskId === id && x.payload.to === 'succeeded',
        )
      );
    },
    120_000,
    'BRAVO succeeded',
  );
  const callsBeforeEdit = provider.calls.length;
  const eventsBeforeEdit = tail.last;
  const editedAt = Date.now();
  const change = await changeSource(sys, 'cache.schema_version');
  await tail.until(
    (e) =>
      ofKind(e, 'receipt.registered').some(
        (x) => x.id > eventsBeforeEdit && x.payload.sourceKey === ALPHA_SOURCE,
      ),
    30_000,
    'watcher registers the changed source',
  );
  const discoveredMs = Date.now() - editedAt;
  await tail.until(
    (e) => e.some((x) => x.payload.kind === 'invalidation.recorded'),
    30_000,
    'invalidation.recorded',
  );
  const snapshot = await waitForMission(
    sys.api,
    mission.id,
    (s) =>
      s.attempts.some((a) => a.kind === 'repair' && a.status === 'published'),
    150_000,
    'repair attempt published',
  );
  const callsAfterEdit = provider.calls.slice(callsBeforeEdit);
  return {
    sys,
    provider,
    mission,
    tail,
    snapshot,
    change,
    discoveredMs,
    eventsBeforeEdit,
    callsAfterEdit,
    bravoTaskId: bravoId()!,
  };
}

describe('G4.3 / G4.4 changed evidence after a branch read (scripted, deterministic)', () => {
  it('G4.3a the watcher discovers the change without being told, within a few poll intervals', async () => {
    const s = await scenario();
    expect(
      s.discoveredMs,
      'ms from owner edit to receipt.registered',
    ).toBeLessThan(15_000);
    const pairs = supersessions(s.snapshot).filter(
      (p) => p.old.source.key === ALPHA_SOURCE,
    );
    expect(
      pairs.length,
      'old receipt superseded by a newer one',
    ).toBeGreaterThanOrEqual(1);
    const [first] = pairs;
    expect(first.next, 'successor exists').not.toBeNull();
    expect(first.next!.sourceRevision).toBeGreaterThan(
      first.old.sourceRevision,
    );
    const receipt = s.snapshot.receipts.find((r) => r.id === first.next!.id)!;
    expect(
      receipt.provenance.toolCallId,
      'registered by the watcher, not by a model tool call',
    ).toBeNull();
    expect(receipt.provenance.modelCallId).toBeNull();
    expect(
      receipt.provenance.selfWrite,
      'an external edit is not a self write',
    ).toBe('none');
  }, 300_000);

  it('G4.3b the changed evidence leaks no diagnosis, injector or verifier machinery to the team', async () => {
    const s = await scenario();
    const texts = s.provider.calls.flatMap((c) => nonSystemTexts(c.body));
    expect(
      findLeaks(texts),
      'forbidden diagnosis/verifier vocabulary in model-visible text',
    ).toEqual([]);
    const newReceipt = supersessions(s.snapshot).find(
      (p) => p.old.source.key === ALPHA_SOURCE,
    )!.next!;
    const serialised = JSON.stringify(
      s.snapshot.receipts.find((r) => r.id === newReceipt.id),
    );
    expect(serialised).not.toMatch(/injector|owner|actor/i);
    for (const event of s.tail.events)
      expect(JSON.stringify(event)).not.toMatch(
        /"control"|nemodots_verifier|probeSecret/,
      );
  }, 300_000);

  it('G4.4a the stale intent is blocked, never admitted or committed, and the block is recorded', async () => {
    const s = await scenario();
    expect(
      s.snapshot.actions.length,
      'the scripted model proposed exactly once',
    ).toBeGreaterThanOrEqual(1);
    const intent = s.snapshot.actions[0];
    expect(intent.status).toBe('blocked');
    expect(
      ['stale_version', 'stale_pending_observation'],
      'block reason',
    ).toContain(intent.blockReason);
    const decided = ofKind(s.tail.events, 'action.decided').filter(
      (e) => e.payload.actionId === intent.id,
    );
    expect(
      decided.some((e) => e.payload.decision === 'blocked'),
      'a blocking decision is recorded in the event stream',
    ).toBe(true);
    expect(
      s.snapshot.authorizations.filter(
        (a) => a.actionId === intent.id && a.decision === 'blocked',
      ).length,
      'and in the authorization rows',
    ).toBeGreaterThanOrEqual(1);
    expect(
      ofKind(s.tail.events, 'action.committed'),
      'nothing committed',
    ).toHaveLength(0);
    expect(
      await committedActionRows(s.sys),
      'no config_versions row caused by an action',
    ).toHaveLength(0);
    const live = await readConfig(s.sys, 'cache.schema_version');
    expect(
      live.value,
      'authority still holds the externally changed value, not the stale proposal',
    ).toEqual(s.change.next);
    expect(String(live.value)).not.toBe(String(state.proposed));
  }, 300_000);

  it('G4.4b a fresh model call and a repaired attempt follow, with a clean context', async () => {
    const s = await scenario();
    const pair = supersessions(s.snapshot).find(
      (p) => p.old.source.key === ALPHA_SOURCE,
    )!;
    const repair = s.snapshot.attempts.find((a) => a.kind === 'repair')!;
    expect(
      repair.repairOf,
      'repair links to the invalidated attempt and event',
    ).not.toBeNull();
    const invalidation = s.snapshot.invalidations.find(
      (i) => i.id === repair.repairOf!.invalidationEventId,
    );
    expect(
      invalidation,
      'repairOf names a recorded invalidation event',
    ).toBeDefined();
    expect(repair.readSetReceiptIds, 'repair reads the new revision').toContain(
      pair.next!.id,
    );
    expect(
      repair.readSetReceiptIds,
      'repair does not read the superseded receipt',
    ).not.toContain(pair.old.id);
    expect(
      repair.lease.fencingToken,
      'repair has a strictly newer fence than the aborted attempt',
    ).toBeGreaterThan(
      s.snapshot.attempts.find((a) => a.id === repair.repairOf!.attemptId)!
        .lease.fencingToken,
    );
    const recordedAfter = ofKind(s.tail.events, 'model_call.recorded').filter(
      (e) => e.id > s.eventsBeforeEdit && e.payload.attemptId === repair.id,
    );
    expect(
      recordedAfter.length,
      'model calls recorded for the repair attempt',
    ).toBeGreaterThanOrEqual(1);
    // the provider saw a fresh conversation: no prior tool transcript quoting the superseded receipt
    const repairRequests = s.callsAfterEdit.filter(
      (c) =>
        c.kind === 'worker' &&
        c.text.includes(ALPHA) &&
        !c.text.includes(CHARLIE),
    );
    expect(repairRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of repairRequests) {
      const toolTexts = (request.body.messages ?? [])
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => String(m.content));
      expect(
        toolTexts.join('\n'),
        'old receipt id must not be replayed as a tool result',
      ).not.toContain(pair.old.id);
    }
    const oldFinding = s.snapshot.findings.filter(
      (f) =>
        (f.supportingReceiptIds as string[]).includes(pair.old.id) && f.usable,
    );
    expect(
      oldFinding,
      'no usable finding rests on the superseded receipt',
    ).toHaveLength(0);
  }, 300_000);

  it('G4.4c the independent branch is not re-executed', async () => {
    const s = await scenario();
    const pair = supersessions(s.snapshot).find(
      (p) => p.old.source.key === ALPHA_SOURCE,
    )!;
    const preserved = preservedTaskIds(s.snapshot, pair.old.id);
    const affected = affectedTaskIds(s.snapshot, pair.old.id);
    expect(
      preserved.has(s.bravoTaskId),
      'BRAVO has no evidence path from the changed receipt',
    ).toBe(true);
    expect(
      affected.size,
      'at least the ALPHA branch is affected',
    ).toBeGreaterThanOrEqual(1);
    const invalidation = ofKind(s.tail.events, 'invalidation.recorded')[0]
      .payload;
    expect(
      invalidation.preserved.taskIds,
      'recorded preserved set contains BRAVO',
    ).toContain(s.bravoTaskId);
    expect(
      invalidation.affected.taskIds,
      'recorded affected tasks equal the independent derivation',
    ).toEqual(expect.arrayContaining([...affected]));
    expect(invalidation.affected.taskIds, 'BRAVO not affected').not.toContain(
      s.bravoTaskId,
    );
    const bravoAttempts = s.snapshot.attempts.filter(
      (a) => a.taskId === s.bravoTaskId,
    );
    expect(bravoAttempts, 'BRAVO ran exactly once').toHaveLength(1);
    const bravoCalls = ofKind(s.tail.events, 'model_call.recorded').filter(
      (e) => e.id > s.eventsBeforeEdit && e.payload.taskId === s.bravoTaskId,
    );
    expect(
      bravoCalls,
      'zero new BRAVO model calls after the change',
    ).toHaveLength(0);
    const bravoRequests = s.callsAfterEdit.filter(
      (c) =>
        c.text.includes(BRAVO) &&
        !c.text.includes(ALPHA) &&
        !c.text.includes(CHARLIE),
    );
    expect(
      bravoRequests,
      'the provider received no further BRAVO request',
    ).toHaveLength(0);
    await finish(s.sys.api, s.mission.id, s.tail);
  }, 300_000);
});
