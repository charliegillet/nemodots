/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAI/AG-UI wire payloads are untyped JSON */
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  affectedTaskIds,
  ofKind,
  preservedTaskIds,
  rolesMentioning,
  scanRequestsForLeaks,
  supersessions,
  treeShape,
} from './analysis.js';
import { waitForMission } from './api.js';
import {
  G4,
  mergedEnv,
  NEUTRAL_CONSTRAINTS,
  NEUTRAL_GOAL,
  requireLive,
} from './config.js';
import {
  alternateValue,
  finish,
  launchMission,
  lazySystem,
  notMet,
} from './flow.js';
import { completionOf } from './provider.js';
import { SPEC_MAX_BREADTH, SPEC_ROLE_CAPABILITIES } from './spec.js';
import {
  committedActionRows,
  injectConfig,
  readConfig,
  type System,
} from './system.js';

interface PlanLike {
  tasks: { title: string; role: string }[];
}
function parsePlan(content: string): PlanLike | null {
  const candidates = [content.trim()];
  const open = content.indexOf('{');
  const close = content.lastIndexOf('}');
  if (open >= 0 && close > open)
    candidates.push(content.slice(open, close + 1));
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as { tasks?: unknown };
      if (Array.isArray(parsed.tasks))
        return {
          tasks: (parsed.tasks as any[])
            .filter((t) => typeof t?.title === 'string')
            .map((t) => ({ title: String(t.title), role: String(t.role) })),
        };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const SETTLED = [
  'awaiting_acceptance',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_provider',
];

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
    await waitForMission(
      sys.api,
      mission.id,
      (s) => SETTLED.includes(s.mission.status),
      15 * 60_000,
      'mission to settle',
    );
  } catch {
    timedOut = true;
  }
  const snapshot = await sys.api.snapshot(mission.id);
  const events = [...tail.events];
  await finish(sys.api, mission.id, tail);
  return {
    sys,
    provider,
    mission,
    snapshot,
    events,
    timedOut,
    parseErrors: tail.parseErrors,
  };
}

describe('LIVE G4.1 goal-only mission on Crusoe Nemotron', () => {
  it('G4.1a the mission is created from a goal and constraints only and resolved to live mode on the configured host', async () => {
    requireLive();
    const run = (runA ??= executeA());
    const a = await run;
    expect(a.mission.goal).toBe(NEUTRAL_GOAL);
    expect(a.mission.constraints).toEqual(NEUTRAL_CONSTRAINTS);
    expect(a.mission.mode).toBe('live');
    expect(a.mission.provider.host, 'provider host the app reports').toBe(
      a.provider.host,
    );
    expect(a.mission.provider.workerModel).toBe(mergedEnv().OPENAI_MODEL);
    expect(
      a.parseErrors,
      'every SSE event satisfies the strict contract',
    ).toEqual([]);
  }, 1_000_000);

  it('G4.1b the Nemotron planner produced the root tasks and workers made tool calls', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const roots = a.snapshot.tasks.filter((t) => t.parentId === null);
    expect(
      roots.length,
      'planner root tasks (plan is 2..6)',
    ).toBeGreaterThanOrEqual(2);
    const plannerCalls = ofKind(a.events, 'model_call.recorded').filter(
      (e) => e.payload.role === 'planner',
    );
    expect(
      plannerCalls.length,
      'at least one planner call recorded',
    ).toBeGreaterThanOrEqual(1);
    const plannerIds = new Set(
      plannerCalls.map((e) => e.payload.modelCallId as string),
    );
    for (const root of roots)
      expect(
        root.createdByModelCallId &&
          plannerIds.has(root.createdByModelCallId as string),
        `root "${root.title}" traces to a recorded planner call`,
      ).toBe(true);
    const tools = ofKind(a.events, 'tool_call.recorded');
    expect(
      tools.filter((t) => t.payload.ok).length,
      'successful worker tool calls',
    ).toBeGreaterThanOrEqual(3);
    expect(
      tools.some((t) => t.payload.receiptId !== null),
      'at least one tool call produced an evidence receipt',
    ).toBe(true);
    // ---- every recorded call is a request the proxy saw, and vice versa (X-Request-Id) ----
    const recordedIds = new Set(
      ofKind(a.events, 'model_call.recorded').map(
        (e) => e.payload.modelCallId as string,
      ),
    );
    const proxySeen = new Set(
      a.provider.calls.map((c) => c.requestId).filter(Boolean) as string[],
    );
    for (const id of recordedIds)
      expect(
        proxySeen.has(id),
        `model_call.recorded ${id} was seen by the proxy under that X-Request-Id`,
      ).toBe(true);
    const completed = new Set(
      a.provider.calls
        .filter((c) => c.status === 200 && c.requestId)
        .map((c) => c.requestId as string),
    );
    const unrecorded = [...completed].filter((id) => !recordedIds.has(id));
    expect(
      unrecorded.length,
      'every completed proxied call is recorded, except orphaned (lease-lost) calls the telemetry counts',
    ).toBeLessThanOrEqual(a.snapshot.telemetry.orphanedCalls);

    // ---- the plan is the model's: every root appears in a proxied planner response ----
    const plans = a.provider.calls
      .filter((c) => c.kind === 'structured' && c.status === 200)
      .map((c) => parsePlan(completionOf(c).content))
      .filter((p): p is PlanLike => p !== null);
    expect(
      plans.length,
      'the proxy saw a parseable planner response',
    ).toBeGreaterThanOrEqual(1);
    for (const root of roots)
      expect(
        plans.some((plan) =>
          plan.tasks.some(
            (t) => t.title.trim() === root.title.trim() && t.role === root.role,
          ),
        ),
        `root "${root.title}" (${root.role}) appears in a proxied planner response`,
      ).toBe(true);

    // ---- every child is a delegate_task tool call the model emitted ----
    const delegations = a.provider.calls
      .filter((c) => c.kind === 'worker' && c.status === 200)
      .flatMap((c) => completionOf(c).toolCalls)
      .filter((t) => t.name === 'delegate_task')
      .map((t) => t.args as { title?: string; role?: string });
    for (const child of a.snapshot.tasks.filter((t) => t.parentId !== null))
      expect(
        delegations.some(
          (d) =>
            typeof d.title === 'string' &&
            d.title.trim() === child.title.trim() &&
            d.role === child.role,
        ),
        `child "${child.title}" matches a delegate_task call in a proxied worker response`,
      ).toBe(true);
    expect(
      a.provider.calls.every((c) => c.body.model === mergedEnv().OPENAI_MODEL),
      'no vendor or model switch',
    ).toBe(true);
  }, 1_000_000);

  it('G4.1c dependencies, handoffs and at least one justified child delegation are recorded', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const withDeps = a.snapshot.tasks.filter(
      (t) => t.prerequisites.length > 0,
    ).length;
    const inherited = a.snapshot.attempts.filter(
      (x) => x.inheritedDependencyVector.length > 0,
    ).length;
    expect(
      withDeps + inherited,
      'NOT_MET if the plan had no dependencies at all',
    ).toBeGreaterThanOrEqual(1);
    expect(
      a.snapshot.outputs.length,
      'published outputs or handoffs',
    ).toBeGreaterThanOrEqual(1);
    const children = a.snapshot.tasks.filter((t) => t.parentId !== null);
    expect(
      children.length,
      'NOT_MET: the model delegated nothing in this run',
    ).toBeGreaterThanOrEqual(1);
    for (const child of children) {
      expect(
        (child.justification ?? '').trim().length,
        `justification of "${child.title}"`,
      ).toBeGreaterThanOrEqual(10);
      expect(
        child.createdByModelCallId,
        `"${child.title}" traces to a recorded model call`,
      ).not.toBeNull();
    }
  }, 1_000_000);

  it('G4.2-live caps and permissions held in the live run', async () => {
    requireLive();
    const a = await (runA ??= executeA());
    const shape = treeShape(a.snapshot);
    expect(shape.maxDepth).toBeLessThanOrEqual(a.mission.budgets.maxDepth);
    expect(a.mission.budgets.maxBreadth, 'spec breadth').toBe(SPEC_MAX_BREADTH);
    expect(shape.maxBreadth).toBeLessThanOrEqual(SPEC_MAX_BREADTH);
    expect(shape.total).toBeLessThanOrEqual(a.mission.budgets.maxTasks);
    const byId = new Map(a.snapshot.tasks.map((t) => [t.id, t]));
    for (const t of a.snapshot.tasks) {
      expect(
        (t.capabilities as string[]).every((c) =>
          (SPEC_ROLE_CAPABILITIES[t.role] as readonly string[]).includes(c),
        ),
      ).toBe(true);
      if (t.parentId)
        expect(
          t.capabilities.every((c) =>
            byId.get(t.parentId!)!.capabilities.includes(c),
          ),
        ).toBe(true);
    }
    expect(
      ofKind(a.events, 'model_call.recorded').length,
      'inference-call budget',
    ).toBeLessThanOrEqual(a.mission.budgets.maxInferenceCalls);
    expect(a.timedOut, 'the mission settled inside the 15 minute window').toBe(
      false,
    );
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
      (r) =>
        r.source.key.startsWith('checkout.config/') &&
        r.provenance.toolCallId !== null &&
        r.supersededBy === null,
    );
    if (hit)
      read = {
        id: hit.id,
        key: hit.source.key.replace('checkout.config/', ''),
      };
    else await new Promise((r) => setTimeout(r, 700));
  }
  if (!read) {
    await finish(sys.api, mission.id, tail);
    throw new Error(
      'NOT_MET: no worker read a checkout.config/* source within 8 minutes, so there is no branch read to invalidate',
    );
  }
  const callsBefore = provider.calls.length;
  const idBefore = tail.last;
  const live = await readConfig(sys, read.key);
  const next = alternateValue(read.key, live.value);
  const editedAt = Date.now();
  // out of band: the injector role, not an app route, so only the watcher can find it
  const change = await injectConfig(sys, read.key, next);
  let discoveredMs: number | null = null;
  try {
    await tail.until(
      (e) =>
        ofKind(e, 'receipt.registered').some(
          (x) =>
            x.id > idBefore &&
            x.payload.sourceKey === `checkout.config/${read!.key}` &&
            x.payload.sourceRevision >= change.version,
        ),
      30_000,
      'watcher registers the change',
    );
    discoveredMs = Date.now() - editedAt;
    await tail.until(
      (e) =>
        e.some(
          (x) => x.payload.kind === 'invalidation.recorded' && x.id > idBefore,
        ),
      30_000,
      'invalidation.recorded',
    );
  } catch {
    /* assertions below report which step is missing */
  }
  let settledTimedOut = false;
  try {
    await waitForMission(
      sys.api,
      mission.id,
      (s) => SETTLED.includes(s.mission.status),
      10 * 60_000,
      'mission to settle after the change',
    );
  } catch {
    settledTimedOut = true;
  }
  const snapshot = await sys.api.snapshot(mission.id);
  const events = [...tail.events];
  const committed = await committedActionRows(sys);
  const callsAfter = provider.calls.slice(callsBefore);
  await finish(sys.api, mission.id, tail);
  return {
    sys,
    provider,
    mission,
    read,
    idBefore,
    discoveredMs,
    snapshot,
    events,
    committed,
    callsAfter,
    settledTimedOut,
    next,
    change,
  };
}

describe('LIVE G4.3 / G4.4 changed evidence after a live branch read', () => {
  it('G4.3-live the watcher discovers an out-of-band change and the team receives no diagnosis', async () => {
    requireLive();
    const b = await (runB ??= executeB());
    expect(
      b.discoveredMs,
      'receipt registered after the injector write',
    ).not.toBeNull();
    expect(b.discoveredMs!).toBeLessThan(15_000);
    const pairs = supersessions(b.snapshot).filter(
      (p) => p.old.id === b.read.id,
    );
    expect(pairs, 'the read receipt was superseded').toHaveLength(1);
    expect(pairs[0].next, 'successor receipt exists').not.toBeNull();
    const successor = b.snapshot.receipts.find(
      (r) => r.id === pairs[0].next!.id,
    )!;
    if (successor.provenance.kind !== 'watcher')
      notMet(
        `the successor receipt was registered with provenance ${successor.provenance.kind}: a worker read the source before the watcher polled, so watcher discovery was not demonstrated in this run`,
      );
    expect(successor.provenance.kind).toBe('watcher');
    const registered = ofKind(b.events, 'receipt.registered').find(
      (e) => e.payload.receiptId === successor.id,
    );
    expect(registered?.payload.provenanceKind).toBe('watcher');
    expect(
      scanRequestsForLeaks(b.callsAfter.map((c) => c.body)),
      'every role of every request after the change',
    ).toEqual([]);
  }, 1_200_000);

  it('G4.4-live stale intents are blocked, repairs use fresh context, and finished independent branches are not repeated', async () => {
    requireLive();
    const b = await (runB ??= executeB());
    const invalidation = ofKind(b.events, 'invalidation.recorded').find(
      (e) => e.id > b.idBefore && e.payload.oldReceiptId === b.read.id,
    );
    expect(
      invalidation,
      'invalidation event for the read receipt',
    ).toBeDefined();
    const derivedAffected = affectedTaskIds(b.snapshot, b.read.id);
    const recorded = new Set(
      invalidation!.payload.affected.taskIds as string[],
    );
    for (const id of derivedAffected)
      expect(
        recorded.has(id),
        `derived affected task ${id} is in the recorded closure`,
      ).toBe(true);

    // ---- stale intents: the case needs at least one, else it is NOT_MET ----
    const staleIntents = b.snapshot.actions.filter((a) =>
      a.dependencyVector.some((d) => d.receiptId === b.read.id),
    );
    if (staleIntents.length === 0)
      notMet(
        'no intent depended on the changed receipt in this live run, so a stale-intent block cannot be shown',
      );
    const blocked = staleIntents.filter((a) => a.status === 'blocked');
    const committedBefore = ofKind(b.events, 'action.committed').filter(
      (e) =>
        e.id < invalidation!.id &&
        staleIntents.some((a) => a.id === e.payload.actionId),
    );
    const committedAfter = ofKind(b.events, 'action.committed').filter(
      (e) =>
        e.id > invalidation!.id &&
        staleIntents.some((a) => a.id === e.payload.actionId),
    );
    expect(
      committedAfter,
      'no stale commit after the invalidation',
    ).toHaveLength(0);
    expect(
      blocked.length + committedBefore.length,
      'every stale-evidence intent has a recorded fate (blocked, or committed before the change)',
    ).toBe(staleIntents.length);
    for (const a of blocked)
      expect([
        'stale_version',
        'stale_pending_observation',
        'target_version_mismatch',
        'citation_out_of_scope',
      ]).toContain(a.blockReason);
    // honest disjunction (ARCHITECTURE 11): record which branch happened
    const branch =
      blocked.length > 0
        ? 'blocked_stale_before_commit'
        : 'committed_then_invalidated_and_repaired';
    mkdirSync(G4.scratch, { recursive: true });
    writeFileSync(
      resolve(G4.scratch, 'g44-live-branch.json'),
      JSON.stringify(
        {
          branch,
          staleIntents: staleIntents.length,
          blocked: blocked.length,
          committedBefore: committedBefore.length,
        },
        null,
        2,
      ),
    );

    // ---- repairs: the case needs at least one, else it is NOT_MET ----
    const repairs = b.snapshot.attempts.filter(
      (a) =>
        ['repair', 'replan'].includes(a.kind) && derivedAffected.has(a.taskId),
    );
    if (repairs.length === 0)
      notMet(
        'no repair or replan attempt exists for an affected task in this live run, so fresh-context repair cannot be shown',
      );
    for (const repair of repairs) {
      expect(
        repair.readSetReceiptIds as string[],
        'repair does not read the superseded receipt',
      ).not.toContain(b.read.id);
      expect(repair.repairOf?.invalidationEventId).toBe(
        invalidation!.payload.invalidationEventId,
      );
      expect(
        repair.inheritedDependencyVector.map((d) => d.receiptId),
        'repair does not inherit the superseded receipt',
      ).not.toContain(b.read.id);
    }
    // the old receipt id and digest appear in NO message of ANY role of a repair's requests
    const oldReceipt = b.snapshot.receipts.find((r) => r.id === b.read.id)!;
    const needles = [b.read.id, oldReceipt.contentDigest];
    const repairAttemptIds = new Set(repairs.map((r) => r.id as string));
    const repairCallIds = new Set(
      ofKind(b.events, 'model_call.recorded')
        .filter((e) => repairAttemptIds.has(e.payload.attemptId as string))
        .map((e) => e.payload.modelCallId as string),
    );
    const repairRequests = b.provider.calls.filter(
      (c) => c.requestId && repairCallIds.has(c.requestId),
    );
    expect(
      repairRequests.length,
      'the repair attempts made proxied model calls',
    ).toBeGreaterThanOrEqual(1);
    for (const call of repairRequests)
      expect(
        rolesMentioning(call.body, needles),
        `roles of repair request #${call.n} that replay the superseded receipt or digest`,
      ).toEqual([]);

    // ---- independent branch: finished before the invalidation, outside the closure ----
    const preserved = preservedTaskIds(b.snapshot, b.read.id);
    const finishedBefore = new Set(
      ofKind(b.events, 'task.status')
        .filter((e) => e.id < invalidation!.id && e.payload.to === 'succeeded')
        .map((e) => e.payload.taskId as string),
    );
    const preservedDone = [...preserved].filter((id) => finishedBefore.has(id));
    if (preservedDone.length === 0)
      notMet(
        'no independent branch had finished before the change, so non-repetition cannot be shown',
      );
    for (const id of preservedDone) {
      const newCalls = ofKind(b.events, 'model_call.recorded').filter(
        (e) => e.id > invalidation!.id && e.payload.taskId === id,
      );
      expect(
        newCalls,
        `no new model calls for preserved task ${id}`,
      ).toHaveLength(0);
      expect(
        b.snapshot.attempts.filter((a) => a.taskId === id),
        `preserved task ${id} ran once`,
      ).toHaveLength(1);
    }
    expect(b.settledTimedOut, 'the mission settled after the change').toBe(
      false,
    );
  }, 1_200_000);
});
