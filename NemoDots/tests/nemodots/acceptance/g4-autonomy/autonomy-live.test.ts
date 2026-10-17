// LIVE block. TEST_PROMPT gate 4 cases 1, 3, 4 (and the live evidence for 2 and
// 7) against real Crusoe Nemotron through the app's adapter. The provider URL
// the app sees is a verifier-owned pass-through proxy (ACCEPTANCE_CONTRACT
// section 6): it forwards to OPENAI_BASE_URL with the verifier's key and
// records every request, so counts and leak checks do not rely on production
// telemetry. Without OPENAI_API_KEY/BASE_URL/MODEL every test here fails with
// "BLOCKED:" (never skipped, never PASS).
//
// Honest limits: the model is nondeterministic. A structural precondition the
// run did not produce (for example no preserved finished branch) is reported
// as NOT_MET and fails the case rather than being forced.
import { describe, expect, it } from 'vitest';
import {
  affectedTaskIds,
  findLeaks,
  nonSystemTexts,
  ofKind,
  preservedTaskIds,
  supersessions,
  treeShape,
} from './analysis.js';
import { waitForMission } from './api.js';
import { G4, mergedEnv, NEUTRAL_CONSTRAINTS, NEUTRAL_GOAL, requireLive } from './config.js';
import { alternateValue, finish, launchMission, lazySystem } from './flow.js';
import { committedActionRows, readConfig, type System } from './system.js';
import { ROLE_CAPABILITIES } from '../../../../src/server/nemodots/contracts/index.js';

const SETTLED = ['awaiting_acceptance', 'succeeded', 'failed', 'cancelled', 'blocked_provider'];

// options are resolved on first use, so missing credentials fail each test with BLOCKED
const getSystem = lazySystem(() => {
  const status = requireLive();
  const env = mergedEnv();
  return {
    providerPort: G4.providerPort,
    model: status.model!,
    upstream: { baseUrl: status.baseUrl!, apiKey: env.OPENAI_API_KEY! },
    system: { env: { NEMODOTS_WATCH_INTERVAL_MS: '1000' } },
  };
});

/** Verifier-side pre_start fault, applied through the documented owner route; the goal never names it. */
async function preStartFault(sys: System) {
  const key = 'orders.write_enabled';
  const current = await readConfig(sys, key);
  await sys.api.editSource(key, false, current.version);
}

let runA: ReturnType<typeof executeA> | null = null;
async function executeA() {
  const { system: sys, provider } = await getSystem();
  await preStartFault(sys);
  const { mission, tail } = await launchMission(sys.api);
  let timedOut = false;
  try {
    await waitForMission(sys.api, mission.id, (s) => SETTLED.includes(s.mission.status), 15 * 60_000, 'mission to settle');
  } catch {
    timedOut = true;
  }
  const snapshot = await sys.api.snapshot(mission.id);
  const events = [...tail.events];
  await finish(sys.api, mission.id, tail);
  return { sys, provider, mission, snapshot, events, timedOut, parseErrors: tail.parseErrors };
}

describe('LIVE G4.1 goal-only mission on Crusoe Nemotron', () => {
  it('G4.1a the mission is created from a goal and constraints only and resolved to live mode on the configured host', async () => {
    requireLive();
    const run = (runA ??= executeA());
    const a = await run;
    expect(a.mission.goal).toBe(NEUTRAL_GOAL);
    expect(a.mission.constraints).toEqual(NEUTRAL_CONSTRAINTS);
    expect(a.mission.mode).toBe('live');
    expect(a.mission.provider.host, 'provider host the app reports').toBe(a.provider.host);
    expect(a.mission.provider.workerModel).toBe(mergedEnv().OPENAI_MODEL);
    expect(a.parseErrors, 'every SSE event satisfies the strict contract').toEqual([]);
  }, 1_000_000);

  it('G4.1b the Nemotron planner produced the root tasks and workers made tool calls', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const roots = a.snapshot.tasks.filter((t) => t.parentId === null);
    expect(roots.length, 'planner root tasks (plan is 2..6)').toBeGreaterThanOrEqual(2);
    const plannerCalls = ofKind(a.events, 'model_call.recorded').filter((e) => e.payload.role === 'planner');
    expect(plannerCalls.length, 'at least one planner call recorded').toBeGreaterThanOrEqual(1);
    const plannerIds = new Set(plannerCalls.map((e) => e.payload.modelCallId as string));
    for (const root of roots)
      expect(root.createdByModelCallId && plannerIds.has(root.createdByModelCallId as string), `root "${root.title}" traces to a recorded planner call`).toBe(true);
    const tools = ofKind(a.events, 'tool_call.recorded');
    expect(tools.filter((t) => t.payload.ok).length, 'successful worker tool calls').toBeGreaterThanOrEqual(3);
    expect(tools.some((t) => t.payload.receiptId !== null), 'at least one tool call produced an evidence receipt').toBe(true);
    const proxied = a.provider.calls.filter((c) => c.status === 200).length;
    const recorded = ofKind(a.events, 'model_call.recorded').length;
    expect(recorded, 'every recorded model call is backed by a request the proxy saw').toBeLessThanOrEqual(proxied);
    expect(a.provider.calls.every((c) => c.body.model === mergedEnv().OPENAI_MODEL), 'no vendor or model switch').toBe(true);
  }, 1_000_000);

  it('G4.1c dependencies, handoffs and at least one justified child delegation are recorded', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const withDeps = a.snapshot.tasks.filter((t) => t.prerequisites.length > 0).length;
    const inherited = a.snapshot.attempts.filter((x) => x.inheritedDependencyVector.length > 0).length;
    expect(withDeps + inherited, 'NOT_MET if the plan had no dependencies at all').toBeGreaterThanOrEqual(1);
    expect(a.snapshot.outputs.length, 'published outputs or handoffs').toBeGreaterThanOrEqual(1);
    const children = a.snapshot.tasks.filter((t) => t.parentId !== null);
    expect(children.length, 'NOT_MET: the model delegated nothing in this run').toBeGreaterThanOrEqual(1);
    for (const child of children) {
      expect((child.justification ?? '').trim().length, `justification of "${child.title}"`).toBeGreaterThanOrEqual(10);
      expect(child.createdByModelCallId, `"${child.title}" traces to a recorded model call`).not.toBeNull();
    }
  }, 1_000_000);

  it('G4.2-live caps and permissions held in the live run', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const shape = treeShape(a.snapshot);
    expect(shape.maxDepth).toBeLessThanOrEqual(a.mission.budgets.maxDepth);
    expect(shape.maxBreadth).toBeLessThanOrEqual(a.mission.budgets.maxBreadth);
    expect(shape.total).toBeLessThanOrEqual(a.mission.budgets.maxTasks);
    const byId = new Map(a.snapshot.tasks.map((t) => [t.id, t]));
    for (const t of a.snapshot.tasks) {
      expect((t.capabilities as string[]).every((c) => (ROLE_CAPABILITIES[t.role] as readonly string[]).includes(c))).toBe(true);
      if (t.parentId) expect(t.capabilities.every((c) => byId.get(t.parentId!)!.capabilities.includes(c))).toBe(true);
    }
    expect(ofKind(a.events, 'model_call.recorded').length, 'inference-call budget').toBeLessThanOrEqual(a.mission.budgets.maxInferenceCalls);
    expect(a.timedOut, 'the mission settled inside the 15 minute window').toBe(false);
  }, 1_000_000);
});

let runB: ReturnType<typeof executeB> | null = null;
async function executeB() {
  const { system: sys, provider } = await getSystem();
  await preStartFault(sys).catch(() => undefined); // already false after run A: version conflict is fine
  const { mission, tail } = await launchMission(sys.api);
  const deadline = Date.now() + 8 * 60_000;
  let read: { id: string; key: string } | null = null;
  while (!read && Date.now() < deadline) {
    const snap = await sys.api.snapshot(mission.id);
    const hit = snap.receipts.find(
      (r) => r.source.key.startsWith('checkout.config/') && r.provenance.toolCallId !== null && r.supersededBy === null,
    );
    if (hit) read = { id: hit.id, key: hit.source.key.replace('checkout.config/', '') };
    else await new Promise((r) => setTimeout(r, 700));
  }
  if (!read) {
    await finish(sys.api, mission.id, tail);
    throw new Error('NOT_MET: no worker read a checkout.config/* source within 8 minutes, so there is no branch read to invalidate');
  }
  const callsBefore = provider.calls.length;
  const idBefore = tail.last;
  const live = await readConfig(sys, read.key);
  const next = alternateValue(read.key, live.value);
  const editedAt = Date.now();
  await sys.api.editSource(read.key, next, live.version);
  let discoveredMs: number | null = null;
  try {
    await tail.until(
      (e) => ofKind(e, 'receipt.registered').some((x) => x.id > idBefore && x.payload.sourceKey === `checkout.config/${read!.key}`),
      30_000,
      'watcher registers the change',
    );
    discoveredMs = Date.now() - editedAt;
    await tail.until((e) => e.some((x) => x.payload.kind === 'invalidation.recorded' && x.id > idBefore), 30_000, 'invalidation.recorded');
  } catch {
    /* assertions below report which step is missing */
  }
  let settledTimedOut = false;
  try {
    await waitForMission(sys.api, mission.id, (s) => SETTLED.includes(s.mission.status), 10 * 60_000, 'mission to settle after the change');
  } catch {
    settledTimedOut = true;
  }
  const snapshot = await sys.api.snapshot(mission.id);
  const events = [...tail.events];
  const committed = await committedActionRows(sys);
  const callsAfter = provider.calls.slice(callsBefore);
  await finish(sys.api, mission.id, tail);
  return { sys, provider, mission, read, idBefore, discoveredMs, snapshot, events, committed, callsAfter, settledTimedOut, next };
}

describe('LIVE G4.3 / G4.4 changed evidence after a live branch read', () => {
  it('G4.3-live the watcher discovers the change and the team receives no diagnosis', async () => {
    requireLive();
    const b = await (runB ??= executeB());
    expect(b.discoveredMs, 'receipt registered by the watcher').not.toBeNull();
    expect(b.discoveredMs!).toBeLessThan(15_000);
    const pairs = supersessions(b.snapshot).filter((p) => p.old.id === b.read.id);
    expect(pairs, 'the read receipt was superseded').toHaveLength(1);
    expect(pairs[0].next, 'successor receipt exists').not.toBeNull();
    const texts = b.callsAfter.flatMap((c) => nonSystemTexts(c.body));
    expect(findLeaks(texts), 'model-visible text after the change').toEqual([]);
  }, 1_200_000);

  it('G4.4-live stale intents are blocked, the repair uses fresh context, and finished independent branches are not repeated', async () => {
    requireLive();
    const b = await (runB ??= executeB());
    const invalidation = ofKind(b.events, 'invalidation.recorded').find((e) => e.id > b.idBefore && e.payload.oldReceiptId === b.read.id);
    expect(invalidation, 'invalidation event for the read receipt').toBeDefined();
    const derivedAffected = affectedTaskIds(b.snapshot, b.read.id);
    const recorded = new Set(invalidation!.payload.affected.taskIds as string[]);
    for (const id of derivedAffected) expect(recorded.has(id), `derived affected task ${id} is in the recorded closure`).toBe(true);

    // stale intents: none may commit after the change with the old receipt in its vector
    const staleIntents = b.snapshot.actions.filter((a) => a.dependencyVector.some((d) => d.receiptId === b.read.id));
    const committedAfter = ofKind(b.events, 'action.committed').filter((e) => e.id > b.idBefore && staleIntents.some((a) => a.id === e.payload.actionId));
    const blocked = staleIntents.filter((a) => a.status === 'blocked');
    const committedBefore = ofKind(b.events, 'action.committed').filter((e) => e.id <= b.idBefore && staleIntents.some((a) => a.id === e.payload.actionId));
    expect(committedAfter.filter((e) => e.id > invalidation!.id), 'no stale commit after the invalidation').toHaveLength(0);
    // honest disjunction (ARCHITECTURE 11): blocked(stale) at admission/commit, or committed first and then re-verified
    if (staleIntents.length > 0)
      expect(blocked.length + committedBefore.length + committedAfter.length, 'every stale-evidence intent has a recorded fate').toBe(staleIntents.length);
    for (const a of blocked) expect(['stale_version', 'stale_pending_observation', 'target_version_mismatch', 'citation_out_of_scope']).toContain(a.blockReason);

    // fresh context for repairs
    const repairs = b.snapshot.attempts.filter((a) => a.kind === 'repair' && derivedAffected.has(a.taskId));
    for (const repair of repairs) {
      expect(repair.readSetReceiptIds as string[], 'repair does not read the superseded receipt').not.toContain(b.read.id);
      expect(repair.repairOf?.invalidationEventId).toBe(invalidation!.payload.invalidationEventId);
    }
    for (const call of b.callsAfter.filter((c) => c.kind === 'worker')) {
      const toolText = (call.body.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join('\n');
      expect(toolText.includes(b.read.id), 'no replay of the old receipt as a tool result').toBe(false);
    }

    // independent branch: tasks finished before the invalidation and outside the closure
    const preserved = preservedTaskIds(b.snapshot, b.read.id);
    const finishedBefore = new Set(
      ofKind(b.events, 'task.status').filter((e) => e.id < invalidation!.id && e.payload.to === 'succeeded').map((e) => e.payload.taskId as string),
    );
    const preservedDone = [...preserved].filter((id) => finishedBefore.has(id));
    expect(preservedDone.length, 'NOT_MET: no independent branch had finished before the change, so non-repetition cannot be shown').toBeGreaterThanOrEqual(1);
    for (const id of preservedDone) {
      const newCalls = ofKind(b.events, 'model_call.recorded').filter((e) => e.id > invalidation!.id && e.payload.taskId === id);
      expect(newCalls, `no new model calls for preserved task ${id}`).toHaveLength(0);
      expect(b.snapshot.attempts.filter((a) => a.taskId === id), `preserved task ${id} ran once`).toHaveLength(1);
    }
    expect(b.settledTimedOut, 'the mission settled after the change').toBe(false);
  }, 1_200_000);
});
