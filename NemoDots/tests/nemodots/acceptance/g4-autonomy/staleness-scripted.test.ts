/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAI/AG-UI wire payloads are untyped JSON */
// TEST_PROMPT gate 4 cases 3 and 4, deterministic version. A scripted model
// drives two independent branches (ALPHA with a verifier CHARLIE that inherits
// it, and BRAVO). ALPHA's admissible proposal waits in a long admission window
// while the verifier changes ALPHA's evidence OUT OF BAND (injector role, no
// app route), so any receipt that follows was found by the watcher.
// Everything asserted comes from recorded server state, the verifier's
// PostgreSQL role and the requests the provider actually received. Expected
// affected/preserved sets are hand-enumerated below, never derived from the
// recorded vectors alone. Scripted replies prove server behaviour only; the
// live equivalent is in autonomy-live.test.ts.
//
// Hand-enumerated world (plan TWO_BRANCH_PLAN):
//   ALPHA   reads checkout.config/cache.schema_version (R0) and checkout.health
//   BRAVO   reads checkout.config/orders.write_enabled only
//   CHARLIE depends on ALPHA (inherits its output, whose vector contains R0)
//           and reads checkout.health
//   change  R0 -> R1 on cache.schema_version
//   expected affected tasks = {ALPHA, CHARLIE}; preserved contains BRAVO.
import { describe, expect, it } from 'vitest';
import {
  affectedTaskIds,
  ofKind,
  rolesMentioning,
  scanRequestsForLeaks,
  supersessions,
} from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import {
  changeSource,
  distinctSchemaVersion,
  finish,
  launchMission,
  lazySystem,
  notMet,
  prepareProposer,
  waitRegistered,
} from './flow.js';
import { STALE_BLOCK_REASONS } from './spec.js';
import {
  ALPHA,
  ALPHA_SOURCE,
  alphaProposer,
  BRAVO,
  BRAVO_SOURCE,
  CHARLIE,
  compose,
  newProposerState,
  observeThenReport,
  planReply,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import { committedActionRows, readConfig } from './system.js';

const proposer = newProposerState();
const ADMISSION_WINDOW_MS = 45_000;
const PROVENANCE_KINDS = [
  'watcher',
  'tool_call',
  'probe',
  'commit_postcondition',
  'owner_edit',
];

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
    alphaProposer(proposer),
  ),
  system: { env: { NEMODOTS_LEASE_MS: '20000' } },
});

let memo: ReturnType<typeof run> | null = null;
function scenario() {
  memo ??= run();
  return memo;
}

const taskIdOf = (events: Parameters<typeof ofKind>[0], title: string) =>
  ofKind(events, 'task.created').find((e) => e.payload.task.title === title)
    ?.payload.task.id as string | undefined;

async function run() {
  const { system: sys, provider } = await system();
  const current = await prepareProposer(sys, proposer);
  const injectedValue = distinctSchemaVersion([current.value, proposer.value]);
  const { mission, tail } = await launchMission(sys.api, {
    admissionMinAgeMs: ADMISSION_WINDOW_MS,
  });
  try {
    await tail.until(
      (e) => e.some((x) => x.payload.kind === 'action.proposed'),
      120_000,
      'ALPHA action.proposed',
    );
    const settled = (title: string) => (e: readonly any[]) => {
      const id = taskIdOf(e, title);
      return (
        Boolean(id) &&
        ofKind(e, 'task.status').some(
          (x) => x.payload.taskId === id && x.payload.to === 'succeeded',
        )
      );
    };
    await tail.until(settled(BRAVO), 120_000, 'BRAVO succeeded');
    await tail.until(settled(CHARLIE), 150_000, 'CHARLIE succeeded');
    const alphaId = taskIdOf(tail.events, ALPHA)!;
    const bravoId = taskIdOf(tail.events, BRAVO)!;
    const charlieId = taskIdOf(tail.events, CHARLIE)!;

    // ---- preconditions (NOT_MET, never misattributed to the product) ----
    const pre = await sys.api.snapshot(mission.id);
    const alphaIntent = pre.actions.filter((a) => a.taskId === alphaId);
    if (alphaIntent.length !== 1)
      notMet(`ALPHA proposed ${alphaIntent.length} times before the edit`);
    if (alphaIntent[0].status !== 'proposed')
      notMet(
        `the intent is already ${alphaIntent[0].status} when the edit lands; the admission window (${ADMISSION_WINDOW_MS} ms) was too short for this machine`,
      );
    if (
      ofKind(tail.events, 'action.decided').some(
        (e) => e.payload.actionId === alphaIntent[0].id,
      )
    )
      notMet('an action.decided event exists before the edit');
    const alphaAttempt = pre.attempts.find(
      (a) => a.taskId === alphaId && a.status === 'published',
    );
    if (!alphaAttempt) notMet('ALPHA has not published before the edit');
    const r0 = pre.receipts.find(
      (r) =>
        r.source.key === ALPHA_SOURCE &&
        alphaAttempt.readSetReceiptIds.includes(r.id),
    );
    if (!r0) notMet('ALPHA did not read the cache.schema_version source');
    const charlieAttempt = pre.attempts.find(
      (a) => a.taskId === charlieId && a.status === 'published',
    );
    if (!charlieAttempt) notMet('CHARLIE has not published before the edit');
    if (
      !charlieAttempt.inheritedDependencyVector.some(
        (d) => d.receiptId === r0.id,
      )
    )
      notMet(
        'CHARLIE did not inherit ALPHA output carrying R0: the plan dependency is scheduling only, so the inheritance edge is not exercised',
      );
    if (
      ofKind(tail.events, 'model_call.recorded').filter(
        (e) => e.payload.taskId === charlieId,
      ).length < 1
    )
      notMet('CHARLIE completed no recorded model call before the edit');
    const charlieOutputsBefore = pre.outputs
      .filter((o) => o.taskId === charlieId)
      .map((o) => o.id);
    if (!charlieOutputsBefore.length)
      notMet('CHARLIE has no published output before the edit');

    const callsBeforeEdit = provider.calls.length;
    const eventsBeforeEdit = tail.last;
    const editedAt = Date.now();
    const change = await changeSource(
      sys,
      'cache.schema_version',
      injectedValue,
    );
    await waitRegistered(
      tail,
      ALPHA_SOURCE,
      change.result.version,
      eventsBeforeEdit,
      30_000,
      'watcher registers the changed source',
    );
    const discoveredMs = Date.now() - editedAt;
    await tail.until(
      (e) =>
        e.some(
          (x) =>
            x.payload.kind === 'invalidation.recorded' &&
            x.payload.sourceKey === ALPHA_SOURCE &&
            x.payload.oldReceiptId === r0.id,
        ),
      30_000,
      'invalidation.recorded for R0',
    );
    const snapshot = await waitForMission(
      sys.api,
      mission.id,
      (s) =>
        s.attempts.some(
          (a) =>
            a.taskId === alphaId &&
            a.kind === 'repair' &&
            a.status === 'published',
        ) &&
        s.attempts.some(
          (a) =>
            a.taskId === charlieId &&
            ['repair', 'replan'].includes(a.kind) &&
            a.status === 'published',
        ),
      180_000,
      'ALPHA and CHARLIE repair attempts published',
    );
    return {
      sys,
      provider,
      mission,
      tail,
      snapshot,
      change,
      discoveredMs,
      eventsBeforeEdit,
      callsAfterEdit: provider.calls.slice(callsBeforeEdit),
      alphaId,
      bravoId,
      charlieId,
      r0,
      alphaAttemptId: alphaAttempt.id,
      charlieAttemptId: charlieAttempt.id,
      charlieOutputsBefore,
      injectedValue,
      proposedValue: proposer.value,
    };
  } catch (error) {
    await finish(sys.api, mission.id, tail);
    throw error;
  }
}

describe('G4.3 / G4.4 changed evidence after a branch read (scripted, deterministic)', () => {
  it('G4.3a the watcher, not the app, discovers an out-of-band change within a few poll intervals', async () => {
    const s = await scenario();
    expect(
      s.discoveredMs,
      'ms from injector write to receipt.registered',
    ).toBeLessThan(15_000);
    const pair = supersessions(s.snapshot).find((p) => p.old.id === s.r0.id);
    expect(pair, 'R0 is superseded').toBeDefined();
    expect(pair!.next, 'successor exists').not.toBeNull();
    expect(pair!.next!.sourceRevision).toBeGreaterThan(
      pair!.old.sourceRevision,
    );
    expect(pair!.next!.sourceRevision).toBeGreaterThanOrEqual(
      s.change.result.version,
    );
    const receipt = s.snapshot.receipts.find((r) => r.id === pair!.next!.id)!;
    expect(
      receipt.provenance.kind,
      'registered by the watcher (nothing told the app about the injector write)',
    ).toBe('watcher');
    expect(receipt.provenance.toolCallId).toBeNull();
    expect(receipt.provenance.modelCallId).toBeNull();
    expect(receipt.provenance.causedByActionId).toBeNull();
    expect(
      receipt.provenance.selfWrite,
      'an external change is not a self write',
    ).toBe('none');
    const registered = ofKind(s.tail.events, 'receipt.registered').find(
      (e) => e.payload.receiptId === receipt.id,
    );
    expect(
      registered,
      'receipt.registered event for the successor',
    ).toBeDefined();
    expect(registered!.payload.provenanceKind).toBe('watcher');
    expect(registered!.payload.selfWrite).toBe('none');
  }, 600_000);

  it('G4.3b the changed evidence leaks no diagnosis, injector or verifier machinery to the team', async () => {
    const s = await scenario();
    expect(
      scanRequestsForLeaks(s.provider.calls.map((c) => c.body)),
      'forbidden diagnosis/verifier vocabulary in ANY message role of ANY model request',
    ).toEqual([]);
    const pair = supersessions(s.snapshot).find((p) => p.old.id === s.r0.id)!;
    const receipt = s.snapshot.receipts.find((r) => r.id === pair.next!.id)!;
    // Only the fields a model can see or that would carry a diagnosis. The
    // contract's own field names (scope.ownerId, provenance.kind) are checked
    // against their spec enums instead of by vocabulary.
    expect(
      scanRequestsForLeaks([
        {
          messages: [
            { role: 'tool', content: JSON.stringify(receipt.normalizedValue) },
          ],
        },
      ]),
      'normalizedValue',
    ).toEqual([]);
    expect(JSON.stringify(receipt)).not.toMatch(/injector/i);
    expect(PROVENANCE_KINDS).toContain(receipt.provenance.kind);
    expect(typeof receipt.source.scope.ownerId).toBe('string');
    expect(receipt.source.scope.ownerId.length).toBeGreaterThan(0);
    for (const event of s.tail.events)
      expect(JSON.stringify(event)).not.toMatch(
        /"control"|nemodots_verifier|nemodots_injector|probeSecret/,
      );
  }, 600_000);

  it('G4.4a the stale intent is blocked, never admitted or committed, and the block is recorded', async () => {
    const s = await scenario();
    const intents = s.snapshot.actions.filter((a) => a.taskId === s.alphaId);
    expect(intents, 'ALPHA proposed exactly once').toHaveLength(1);
    const intent = intents[0];
    expect(intent.status).toBe('blocked');
    expect(STALE_BLOCK_REASONS as readonly string[], 'block reason').toContain(
      intent.blockReason,
    );
    const decided = ofKind(s.tail.events, 'action.decided').filter(
      (e) => e.payload.actionId === intent.id,
    );
    expect(
      decided.some((e) => e.payload.decision === 'blocked'),
      'a blocking decision is recorded in the event stream',
    ).toBe(true);
    expect(
      decided.some((e) => e.payload.decision === 'admitted'),
      'the stale intent was never admitted',
    ).toBe(false);
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
    ).toEqual(s.injectedValue);
    expect(String(live.value)).not.toBe(String(s.proposedValue));
  }, 600_000);

  it('G4.4b a fresh model call and a repaired ALPHA attempt follow, with a clean context in every message role', async () => {
    const s = await scenario();
    const pair = supersessions(s.snapshot).find((p) => p.old.id === s.r0.id)!;
    const repair = s.snapshot.attempts.find(
      (a) => a.taskId === s.alphaId && a.kind === 'repair',
    )!;
    expect(repair, 'a repair attempt of ALPHA').toBeDefined();
    expect(
      repair.repairOf,
      'repair links to the invalidated attempt and event',
    ).not.toBeNull();
    expect(repair.repairOf!.attemptId).toBe(s.alphaAttemptId);
    expect(
      s.snapshot.invalidations.find(
        (i) => i.id === repair.repairOf!.invalidationEventId,
      ),
      'repairOf names a recorded invalidation event',
    ).toBeDefined();
    expect(repair.readSetReceiptIds, 'repair reads the new revision').toContain(
      pair.next!.id,
    );
    expect(
      repair.readSetReceiptIds,
      'repair does not read the superseded receipt',
    ).not.toContain(pair.old.id);
    const original = s.snapshot.attempts.find(
      (a) => a.id === s.alphaAttemptId,
    )!;
    expect(
      repair.lease.fencingToken,
      'repair has a strictly newer fence than the invalidated attempt',
    ).toBeGreaterThan(original.lease.fencingToken);
    expect(
      ofKind(s.tail.events, 'model_call.recorded').filter(
        (e) => e.id > s.eventsBeforeEdit && e.payload.attemptId === repair.id,
      ).length,
      'model calls recorded for the repair attempt',
    ).toBeGreaterThanOrEqual(1);
    // The provider saw a fresh conversation. The old receipt id and old content
    // digest must appear in NO message of ANY role (system, user, assistant, tool).
    const needles = [pair.old.id, pair.old.contentDigest ?? ''].filter(Boolean);
    const alphaRequests = s.callsAfterEdit.filter(
      (c) =>
        c.kind === 'worker' &&
        c.text.includes(ALPHA) &&
        !c.text.includes(CHARLIE),
    );
    expect(alphaRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of alphaRequests)
      expect(
        rolesMentioning(request.body, needles),
        `roles whose text replays the superseded receipt or its digest (request #${request.n})`,
      ).toEqual([]);
    expect(
      s.snapshot.findings.filter(
        (f) =>
          (f.supportingReceiptIds as string[]).includes(pair.old.id) &&
          f.usable,
      ),
      'no usable finding rests on the superseded receipt',
    ).toHaveLength(0);
  }, 600_000);

  it('G4.4c invalidation reaches exactly {ALPHA, CHARLIE}; CHARLIE is repaired on clean inputs; BRAVO is untouched', async () => {
    const s = await scenario();
    const r0 = s.r0;
    const event = ofKind(s.tail.events, 'invalidation.recorded').find(
      (e) =>
        e.payload.sourceKey === ALPHA_SOURCE &&
        e.payload.oldReceiptId === r0.id,
    )!.payload;
    // hand-enumerated expectation, independent of any recorded vector
    expect(
      [...(event.affected.taskIds as string[])].sort(),
      'affected tasks equal exactly {ALPHA, CHARLIE}',
    ).toEqual([s.alphaId, s.charlieId].sort());
    expect(
      event.preserved.taskIds,
      'recorded preserved set contains BRAVO',
    ).toContain(s.bravoId);
    expect(event.affected.taskIds).not.toContain(s.bravoId);
    // the recorded closure must also cover the vector-derived set (secondary check)
    for (const id of affectedTaskIds(s.snapshot, r0.id))
      expect(event.affected.taskIds as string[]).toContain(id);

    const charlieRepair = s.snapshot.attempts.find(
      (a) => a.taskId === s.charlieId && ['repair', 'replan'].includes(a.kind),
    )!;
    expect(
      charlieRepair,
      'CHARLIE gets a repair or replan attempt',
    ).toBeDefined();
    expect(charlieRepair.readSetReceiptIds).not.toContain(r0.id);
    expect(
      charlieRepair.inheritedDependencyVector.map((d) => d.receiptId),
      "CHARLIE's inherited vector no longer cites the old receipt",
    ).not.toContain(r0.id);
    const needles = [r0.id, r0.contentDigest ?? ''].filter(Boolean);
    for (const request of s.callsAfterEdit.filter(
      (c) => c.kind === 'worker' && c.text.includes(CHARLIE),
    ))
      expect(
        rolesMentioning(request.body, needles),
        `CHARLIE request #${request.n} replays the superseded receipt`,
      ).toEqual([]);
    for (const outputId of s.charlieOutputsBefore)
      expect(
        s.snapshot.outputs.find((o) => o.id === outputId)?.usable,
        "CHARLIE's pre-edit output is no longer usable",
      ).toBe(false);
    expect(
      s.snapshot.outputs.some(
        (o) =>
          o.taskId === s.charlieId &&
          !s.charlieOutputsBefore.includes(o.id) &&
          o.usable,
      ),
      'CHARLIE republished a usable output from the repair',
    ).toBe(true);

    // BRAVO: not re-executed
    expect(
      s.snapshot.attempts.filter((a) => a.taskId === s.bravoId),
      'BRAVO ran exactly once',
    ).toHaveLength(1);
    expect(
      ofKind(s.tail.events, 'model_call.recorded').filter(
        (e) => e.id > s.eventsBeforeEdit && e.payload.taskId === s.bravoId,
      ),
      'zero new BRAVO model calls after the change',
    ).toHaveLength(0);
    expect(
      s.callsAfterEdit.filter(
        (c) =>
          c.text.includes(BRAVO) &&
          !c.text.includes(ALPHA) &&
          !c.text.includes(CHARLIE),
      ),
      'the provider received no further BRAVO request',
    ).toHaveLength(0);
    await finish(s.sys.api, s.mission.id, s.tail);
  }, 600_000);

  it('G4.4z positive control: the same flow without the change commits exactly once, so G4.4a is caused by staleness', async () => {
    const { system: sys } = await system();
    // make sure the mission of the main scenario is not still running
    const earlier = memo ? await memo.catch(() => null) : null;
    if (earlier)
      await finish(earlier.sys.api, earlier.mission.id, earlier.tail);
    const before = await prepareProposer(sys, proposer);
    const { mission, tail } = await launchMission(sys.api, {
      admissionMinAgeMs: 1_500,
    });
    try {
      await tail.until(
        (e) => e.some((x) => x.payload.kind === 'action.proposed'),
        120_000,
        'ALPHA action.proposed',
      );
      const actionId = ofKind(tail.events, 'action.proposed')[0].payload
        .actionId;
      const snapshot = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          ['verified', 'blocked', 'failed', 'outcome_unknown'].includes(
            s.actions.find((a) => a.id === actionId)?.status ?? '',
          ),
        150_000,
        'the intent settles',
      );
      const intent = snapshot.actions.find((a) => a.id === actionId)!;
      expect(
        intent.status,
        `the admissible proposal commits and verifies (blockReason ${intent.blockReason})`,
      ).toBe('verified');
      const rows = (await committedActionRows(sys)).filter(
        (r) => r.caused_by_action_id === actionId,
      );
      expect(
        rows,
        'exactly one config_versions row for the action',
      ).toHaveLength(1);
      const live = await readConfig(sys, 'cache.schema_version');
      expect(live.value).toEqual(proposer.value);
      expect(live.version, 'exactly one version advance').toBe(
        before.version + 1,
      );
      expect(
        snapshot.results.filter((r) => r.actionId === actionId),
        'exactly one ResultReceipt',
      ).toHaveLength(1);
      const auth = snapshot.authorizations.filter(
        (a) => a.actionId === actionId,
      );
      expect(auth.filter((a) => a.decision === 'blocked')).toHaveLength(0);
      expect(
        auth.filter(
          (a) => a.stage === 'admission' && a.decision === 'admitted',
        ),
      ).toHaveLength(1);
      expect(
        auth.filter((a) => a.stage === 'commit' && a.decision === 'committed'),
      ).toHaveLength(1);
      expect(ofKind(tail.events, 'action.committed')).toHaveLength(1);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 600_000);
});
