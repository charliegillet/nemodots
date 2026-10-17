// Reusable assertions for the gate-2 suites. Everything is stated in terms of
// authoritative state (versions, values, authorization rows, invalidation
// events, Redis effects), never in terms of production helpers.
import { expect } from 'vitest';
import {
  authSummary,
  errText,
  isDispatchFenceError,
  type Rec,
  type World,
} from './harness.js';

/**
 * Reasons a stale vector entry may carry at COMMIT time. A change that nobody
 * registered yet is a "pending observation" (G3: fail closed, never permission);
 * one that was registered is stale_version. The frozen oracle names stale_version
 * for the unregistered cases ADM-03b/ADM-02 and stale_pending_observation for
 * ADM-01b; both are accepted at commit (reported to the lead, see README).
 */
export const STALE = ['stale_version', 'stale_pending_observation'];

export async function expectNoMutation(
  w: World,
  base: Record<string, { value: unknown; version: number }>,
  except: string[] = [],
) {
  for (const [k, b] of Object.entries(base)) {
    if (except.includes(k)) continue;
    const now = await w.cfg(k);
    expect(now.version, `${k} version`).toBe(b.version);
    expect(now.value, `${k} value`).toEqual(b.value);
  }
  expect(await w.actionRows(), 'no action-caused config row').toBe(0);
}

/**
 * The intent ended blocked because a cited source moved. `path: 'commit'`
 * requires the COMMIT-stage Authorization row (admission admitted, commit
 * blocked, with the live revision of `changedKey` above the recorded one in
 * the checked vector), which is what proves the final re-validation ran.
 * `path: 'either'` also accepts the invalidation-closure path (ARCH 5.2
 * step 4): the registration already moved the intent proposed|admitted ->
 * blocked(stale_version) through the actions CAS, so no commit-stage row
 * exists; that path must then be backed by an invalidation event naming the
 * intent. Returns which path decided.
 */
export async function expectStaleBlocked(
  w: World,
  id: string,
  o: { changedKey: string; path: 'commit' | 'either'; reasons?: string[] },
): Promise<'commit' | 'closure'> {
  const reasons = o.reasons ?? STALE;
  const row = await w.intent(id);
  expect(row.status, 'intent status').toBe('blocked');
  expect(reasons, `block reason ${row.block_reason}`).toContain(
    row.block_reason,
  );
  const sum = await authSummary(w, id);
  expect(sum[0]).toEqual({
    stage: 'admission',
    decision: 'admitted',
    blockReason: null,
  });
  const auths = await w.auths(id);
  const commitBlock = auths.find(
    (a) => a.stage === 'commit' && a.decision === 'blocked',
  );
  expect((await w.resultReceipts(id)).length, 'no result receipt').toBe(0);
  if (commitBlock) {
    expect(sum).toHaveLength(2);
    expect(commitBlock.block_reason).toBe(row.block_reason);
    const entry = (commitBlock.checked_vector as Rec[]).find(
      (e) => e.sourceKey === `checkout.config/${o.changedKey}`,
    );
    expect(
      entry,
      `the commit-stage vector must contain checkout.config/${o.changedKey}`,
    ).toBeTruthy();
    expect(entry!.liveRevision).toBeGreaterThan(entry!.recordedRevision);
    return 'commit';
  }
  expect(
    o.path,
    'this case requires the commit-stage block (the change was not registered, so the closure cannot have fired)',
  ).toBe('either');
  expect(sum, 'closure path writes no further authorization').toHaveLength(1);
  expect(row.block_reason).toBe('stale_version');
  const events = await w.invalidationsFor(`checkout.config/${o.changedKey}`);
  expect(
    events.some((e) =>
      ((e.affected?.actionIds ?? []) as string[]).includes(id),
    ),
    `an invalidation event for checkout.config/${o.changedKey} must name intent ${id}`,
  ).toBe(true);
  return 'closure';
}

/** A commit call on a closure-blocked or commit-blocked intent: DispatchFenceError, or a returned blocked intent. */
export function expectRefusedCommit(
  out: { returned: Rec } | { threw: unknown },
) {
  if ('threw' in out)
    expect(
      isDispatchFenceError(out.threw) ||
        /dispatch_?fence|DispatchFence/i.test(errText(out.threw)),
      `commit threw ${errText(out.threw)}`,
    ).toBe(true);
  else expect(out.returned.status).toBe('blocked');
}

/** Either the intent is committed against a fully current vector, or it is blocked as stale; never a stale commit. */
export async function expectSerializable(
  w: World,
  id: string,
  changedKey: string,
): Promise<'commit_first' | 'change_first'> {
  const row = await w.intent(id);
  if (row.status === 'committed') {
    const c = (await w.auths(id)).find(
      (a) => a.stage === 'commit' && a.decision === 'committed',
    );
    expect(c, 'a committed intent has a commit authorization').toBeTruthy();
    for (const e of c!.checked_vector as Rec[]) {
      expect(e.recordedRevision, `${e.sourceKey} recorded`).toBe(
        e.liveRevision,
      );
      expect(e.freshnessOk).toBe(true);
    }
    return 'commit_first';
  }
  await expectStaleBlocked(w, id, { changedKey, path: 'either' });
  return 'change_first';
}
