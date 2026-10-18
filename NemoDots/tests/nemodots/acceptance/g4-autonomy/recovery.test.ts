// TEST_PROMPT gate 4 cases 5 and 6: kill and restart the coordinator and the
// worker process, rebuild from PostgreSQL, fencing and outbox, and source
// changes landing while the worker is down. Real processes, real PostgreSQL,
// SIGKILL and SIGSTOP/SIGCONT. The scripted provider only supplies model
// replies; the Redis-loss case is in redis-loss.test.ts. Resume bound: 60 s
// after restart (ACCEPTANCE_CONTRACT 4.1).
//
// A killed process cannot publish, so killing alone says nothing about
// fencing. G4.5d therefore freezes the worker (SIGSTOP) while its model reply
// is held, lets a successor take the task with a newer fence, then wakes the
// zombie and releases a reply that tries to publish. It is the case that
// catches NEMODOTS_MUTATION=ignore_fencing.
import { describe, expect, it } from 'vitest';
import {
  attemptsPerTask,
  fencingMonotonic,
  ofKind,
  repairsByInvalidation,
} from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import {
  changeSource,
  finish,
  launchMission,
  lazySystem,
  prepareProposer,
  sleep,
  waitRegistered,
  within,
} from './flow.js';
import type { Provider, ProviderCall, ProviderReply } from './provider.js';
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
  receiptIdAt,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import {
  committedActionRows,
  pendingOutbox,
  processedOutbox,
  readConfig,
  type System,
} from './system.js';

const LEASE_MS = 6_000;
const proposer = newProposerState();
const mode = { propose: false };
type ZombieVariant =
  'publish_finding' | 'delegate_task' | 'propose_action' | 'all';
const zombie = { variant: 'all' as ZombieVariant, n: -1 };

function zombieReply(call: ProviderCall): ProviderReply | null {
  if (call.n !== zombie.n) return null;
  const receipt = receiptIdAt(call, 0);
  const calls = {
    publish_finding: {
      name: 'publish_finding',
      args: {
        claim: 'ZOMBIE-finding published after the lease was lost',
        supportingReceiptIds: receipt ? [receipt] : [],
        confidence: 'low',
      },
    },
    delegate_task: {
      name: 'delegate_task',
      args: {
        title: 'ZOMBIE-child',
        role: 'verifier',
        question: 'ZOMBIE-child: verify the cache branch.',
        dependsOn: [],
        justification: 'a zombie writer delegates after losing its lease',
      },
    },
    propose_action: {
      name: 'propose_action',
      args: {
        action: 'set_config',
        payload: {
          key: 'cache.schema_version',
          value: proposer.value,
          expectedCurrentValueDigest: proposer.currentDigest,
        },
        supportingReceiptIds: receipt ? [receipt] : [],
        rationale: 'ZOMBIE-proposal made after the lease was lost',
      },
    },
  };
  return {
    type: 'tool_calls',
    calls:
      zombie.variant === 'all'
        ? [calls.publish_finding, calls.delegate_task, calls.propose_action]
        : [calls[zombie.variant]],
  };
}

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    zombieReply,
    (call) => (mode.propose ? alphaProposer(proposer)(call) : null),
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
    observeThenReport(ALPHA, ALPHA_SOURCE),
  ),
  system: {
    separateWorker: true,
    env: {
      NEMODOTS_LEASE_MS: String(LEASE_MS),
      NEMODOTS_DISPATCH_LEASE_MS: String(LEASE_MS),
    },
  },
});

const alphaCall = (c: ProviderCall) =>
  c.kind === 'worker' && c.text.includes(ALPHA) && !c.text.includes(CHARLIE);
const alphaFirstThink = (c: ProviderCall) =>
  alphaCall(c) && c.toolResults === 1;

const taskId = (
  tail: { events: Parameters<typeof ofKind>[0] },
  title: string,
) =>
  ofKind(tail.events, 'task.created').find(
    (e) => e.payload.task.title === title,
  )?.payload.task.id as string | undefined;

async function freshRun(sys: System) {
  mode.propose = false;
  zombie.n = -1;
  await sys.resetWorkers();
}

async function holdAlphaMidAttempt(sys: System, provider: Provider) {
  const gate = provider.gate(alphaFirstThink);
  const { mission, tail } = await launchMission(sys.api);
  await within(gate.arrived, 120_000, 'ALPHA mid-attempt model call');
  await tail.until(
    (e) => {
      const id = taskId({ events: e }, BRAVO);
      return (
        Boolean(id) &&
        ofKind(e, 'task.status').some(
          (x) => x.payload.taskId === id && x.payload.to === 'succeeded',
        )
      );
    },
    120_000,
    'BRAVO succeeded before the crash',
  );
  return { mission, tail, gate };
}

describe('G4.5 kill and restart, rebuild from PostgreSQL, fencing and outbox', () => {
  it('G4.5a SIGKILL of worker-main mid-attempt: state survives, a fenced successor attempt finishes, no re-execution of finished work', async () => {
    const { system: sys, provider } = await system();
    await freshRun(sys);
    const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
    try {
      const before = await sys.api.snapshot(mission.id);
      const alphaId = taskId(tail, ALPHA)!;
      const bravoId = taskId(tail, BRAVO)!;
      const a1 = before.attempts.find((a) => a.taskId === alphaId)!;
      expect(a1.status, 'ALPHA attempt 1 is mid-flight').toBe('running');
      const bravoCallsBefore = ofKind(
        tail.events,
        'model_call.recorded',
      ).filter((e) => e.payload.taskId === bravoId).length;
      const bravoOutput = before.outputs.find((o) => o.taskId === bravoId)!;
      expect(bravoOutput, 'BRAVO published before the crash').toBeDefined();

      await sys.worker!.kill('SIGKILL');
      // the coordinator API still serves the authoritative state while the worker is down
      const mid = await sys.api.snapshot(mission.id);
      expect(mid.tasks.map((t) => t.id).sort()).toEqual(
        before.tasks.map((t) => t.id).sort(),
      );
      expect(mid.outputs.find((o) => o.taskId === bravoId)?.digest).toBe(
        bravoOutput.digest,
      );
      gate.release();

      const restartedAt = Date.now();
      await sys.startWorker();
      const after = await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.attempts.some(
            (a) => a.taskId === alphaId && a.n >= 2 && a.status === 'published',
          ),
        90_000,
        'ALPHA successor attempt published after the worker restart',
      );
      expect(
        Date.now() - restartedAt,
        'resume bound after restart',
      ).toBeLessThan(60_000 + LEASE_MS);
      const old = after.attempts.find((a) => a.id === a1.id)!;
      expect(
        ['expired', 'aborted', 'failed', 'invalidated'],
        'the killed attempt is closed, never published',
      ).toContain(old.status);
      if (old.status === 'aborted') expect(old.abortReason).toBe('lease_lost');
      expect(
        after.outputs.filter((o) => o.attemptId === a1.id),
        'the killed attempt published nothing (fencing itself is G4.5d)',
      ).toHaveLength(0);
      const successor = after.attempts.find(
        (a) => a.taskId === alphaId && a.n >= 2,
      )!;
      expect(
        successor.lease.fencingToken,
        'strictly newer fence',
      ).toBeGreaterThan(a1.lease.fencingToken);
      expect(fencingMonotonic(after)).toBe(true);
      expect(
        after.attempts.filter((a) => a.taskId === bravoId),
        'finished branch not re-executed',
      ).toHaveLength(1);
      const bravoCallsAfter = ofKind(tail.events, 'model_call.recorded').filter(
        (e) => e.payload.taskId === bravoId,
      ).length;
      expect(bravoCallsAfter).toBe(bravoCallsBefore);
      for (const [id, count] of attemptsPerTask(after))
        expect(count, `attempts of ${id}`).toBeLessThanOrEqual(4);
      for (const task of after.tasks)
        expect(
          after.attempts.filter(
            (a) =>
              a.taskId === task.id && a.status === 'published' && !a.repairOf,
          ).length,
        ).toBeLessThanOrEqual(1);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);

  it('G4.5b SIGKILL of the whole app and worker: mission, tasks and durable events are rebuilt from PostgreSQL', async () => {
    const { system: sys, provider } = await system();
    await freshRun(sys);
    const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
    try {
      const before = await sys.api.snapshot(mission.id);
      const lastId = tail.last;
      const idsBefore = tail.events.map((e) => e.id);
      await sys.worker!.kill('SIGKILL');
      gate.release();
      await tail.stop();
      await sys.restartApp();
      const reopened = await sys.api.snapshot(mission.id);
      expect(reopened.mission.id).toBe(mission.id);
      expect(reopened.tasks.map((t) => t.id).sort(), 'tasks rebuilt').toEqual(
        before.tasks.map((t) => t.id).sort(),
      );
      expect(
        reopened.outputs.map((o) => o.id).sort(),
        'published outputs rebuilt',
      ).toEqual(before.outputs.map((o) => o.id).sort());
      expect(
        reopened.receipts.length,
        'receipts rebuilt',
      ).toBeGreaterThanOrEqual(before.receipts.length);
      // Last-Event-ID replay: exactly the events after the cursor, no duplicates of earlier ids
      const resumed = sys.api.tail(mission.id, lastId).start();
      await sys.startWorker();
      try {
        await resumed.until(
          (e) => e.length > 0,
          30_000,
          'events after the cursor',
        );
        expect(
          resumed.events.every((e) => e.id > lastId),
          'resume returns only newer events',
        ).toBe(true);
        const full = sys.api.tail(mission.id, 0).start();
        await full.until(
          (e) => e.length >= idsBefore.length,
          30_000,
          'full durable replay',
        );
        expect(
          idsBefore.every((id) => full.events.some((e) => e.id === id)),
          'durable events survived the restart',
        ).toBe(true);
        expect(full.parseErrors).toEqual([]);
        await full.stop();
      } finally {
        await resumed.stop();
      }
      await waitForMission(
        sys.api,
        mission.id,
        (s) =>
          s.tasks.some(
            (t) =>
              t.title === ALPHA && ['succeeded', 'failed'].includes(t.status),
          ),
        120_000,
        'ALPHA resolves after full restart',
      );
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 360_000);

  // ---- G4.5c: kill inside the admission window, effects counted not proposals ----
  const windowCases = ['author_unpublished', 'author_published'] as const;
  for (const branch of windowCases)
    it(`G4.5c [${branch}] worker killed inside the admission window: the valid proposal commits and verifies exactly once`, async () => {
      const { system: sys, provider } = await system();
      await freshRun(sys);
      const before = await prepareProposer(sys, proposer);
      mode.propose = true;
      // author_unpublished: hold ALPHA's model call that follows its own propose_action, so the
      // kill lands with the proposal published and the author attempt not.
      // author_published: hold CHARLIE's first call; CHARLIE starts only after ALPHA published.
      const gate = provider.gate(
        branch === 'author_unpublished'
          ? (c) =>
              alphaCall(c) &&
              c.toolResults === 3 &&
              c.toolCallNames[2] === 'propose_action'
          : (c) =>
              c.kind === 'worker' &&
              c.text.includes(CHARLIE) &&
              c.toolResults === 0,
      );
      const { mission, tail } = await launchMission(sys.api, {
        admissionMinAgeMs: 8_000,
      });
      try {
        await within(gate.arrived, 120_000, `the ${branch} gate`);
        await tail.until(
          (e) => e.some((x) => x.payload.kind === 'action.proposed'),
          30_000,
          'action.proposed before the kill',
        );
        const alphaId = taskId(tail, ALPHA)!;
        const atKill = await sys.api.snapshot(mission.id);
        const authorPublished = atKill.attempts.some(
          (a) => a.taskId === alphaId && a.status === 'published',
        );
        expect(
          authorPublished,
          `the kill lands with the author attempt ${branch === 'author_published' ? 'published' : 'unpublished'}`,
        ).toBe(branch === 'author_published');
        const intentAtKill = atKill.actions[0];
        expect(
          ['proposed', 'admitted'],
          'the intent is still inside the admission window',
        ).toContain(intentAtKill.status);
        await sys.worker!.kill('SIGKILL');
        gate.release();
        await sys.startWorker();

        const actionId = intentAtKill.id;
        const settled = await waitForMission(
          sys.api,
          mission.id,
          (s) =>
            ['verified', 'blocked', 'failed', 'cancelled'].includes(
              s.actions.find((a) => a.id === actionId)?.status ?? '',
            ),
          150_000,
          'the intent reaches a terminal status',
        );
        // quiescence: the outbox has delivered the action's events and holds nothing for it
        const quiet = Date.now() + 60_000;
        while ((await pendingOutbox(sys, actionId)) > 0 && Date.now() < quiet)
          await sleep(300);
        expect(
          await pendingOutbox(sys, actionId),
          'no outbox row for the action is still pending',
        ).toBe(0);
        expect(
          await processedOutbox(sys, actionId),
          'the outbox delivered the action',
        ).toBeGreaterThanOrEqual(1);

        const final = await sys.api.snapshot(mission.id);
        const intent = final.actions.find((a) => a.id === actionId)!;
        expect(
          intent.status,
          `a valid proposal must commit and verify (blockReason ${intent.blockReason}); no source changed and the author's fence was valid when it proposed`,
        ).toBe('verified');
        const rows = await committedActionRows(sys);
        expect(
          rows.filter((r) => r.caused_by_action_id === actionId),
          'exactly one config_versions row caused by the action',
        ).toHaveLength(1);
        expect(rows, 'and no other action effect at all').toHaveLength(1);
        expect(
          final.results.filter((r) => r.actionId === actionId),
          'exactly one ResultReceipt',
        ).toHaveLength(1);
        expect(final.results, 'no other result receipt').toHaveLength(1);
        const auth = final.authorizations.filter(
          (a) => a.actionId === actionId,
        );
        expect(
          auth.filter(
            (a) => a.stage === 'admission' && a.decision === 'admitted',
          ),
          'one admission',
        ).toHaveLength(1);
        expect(
          auth.filter(
            (a) => a.stage === 'commit' && a.decision === 'committed',
          ),
          'one commit',
        ).toHaveLength(1);
        expect(auth.filter((a) => a.decision === 'blocked')).toHaveLength(0);
        expect(
          ofKind(tail.events, 'action.committed').filter(
            (e) => e.payload.actionId === actionId,
          ),
        ).toHaveLength(1);
        const live = await readConfig(sys, 'cache.schema_version');
        expect(live.value).toEqual(proposer.value);
        expect(live.version, 'exactly one version advance').toBe(
          before.version + 1,
        );
        if (branch === 'author_unpublished') {
          const author = final.attempts.find(
            (a) => a.taskId === alphaId && a.n === 1,
          )!;
          expect(
            ['expired', 'aborted'],
            'the author attempt that was killed never published',
          ).toContain(author.status);
        }
        expect(settled.mission.id).toBe(mission.id);
      } finally {
        mode.propose = false;
        await finish(sys.api, mission.id, tail);
      }
    }, 420_000);

  // ---- G4.5d: the zombie writer ----
  const variants: ZombieVariant[] = [
    'publish_finding',
    'delegate_task',
    'propose_action',
    'all',
  ];
  for (const variant of variants)
    it(`G4.5d [${variant}] a frozen worker wakes after its lease was taken over: its reply publishes nothing`, async () => {
      const { system: sys, provider } = await system();
      await freshRun(sys);
      await prepareProposer(sys, proposer);
      zombie.variant = variant;
      const zombieGate = provider.gate(alphaFirstThink);
      const successorGate = provider.gate(alphaFirstThink);
      const { mission, tail } = await launchMission(sys.api);
      const first = sys.worker!;
      try {
        const held = await within(
          zombieGate.arrived,
          120_000,
          "the first worker's ALPHA model call",
        );
        zombie.n = held.n;
        const alphaId = taskId(tail, ALPHA)!;
        const before = await sys.api.snapshot(mission.id);
        const a1 = before.attempts.find(
          (a) => a.taskId === alphaId && a.status === 'running',
        )!;
        expect(a1, 'ALPHA attempt 1 is running').toBeDefined();

        first.pause(); // SIGSTOP: the worker keeps its sockets and its idea of the lease
        await sleep(LEASE_MS + 3_000);
        const second = await sys.startWorker();
        expect(second.pid).not.toBe(first.pid);
        await waitForMission(
          sys.api,
          mission.id,
          (s) =>
            s.attempts.some(
              (a) =>
                a.taskId === alphaId &&
                a.id !== a1.id &&
                a.lease.fencingToken > a1.lease.fencingToken &&
                a.status === 'running',
            ),
          90_000,
          'a successor attempt with a newer fence',
        );
        await within(
          successorGate.arrived,
          60_000,
          "the successor's ALPHA model call",
        );

        // wake the zombie and let its scripted reply arrive while the successor still owns the task
        first.resume();
        zombieGate.release();
        await tail.until(
          () => provider.calls.some((c) => c.n === held.n),
          30_000,
          'the zombie reply was delivered',
        );
        await sleep(6_000); // the worker acts on the reply; the lease heartbeat also notices
        const mid = await sys.api.snapshot(mission.id);
        const oldMid = mid.attempts.find((a) => a.id === a1.id)!;
        expect(
          ['aborted', 'expired', 'failed', 'invalidated'],
          'the zombie attempt is closed, not running or published',
        ).toContain(oldMid.status);

        successorGate.release();
        const after = await waitForMission(
          sys.api,
          mission.id,
          (s) =>
            s.attempts.some(
              (a) =>
                a.taskId === alphaId &&
                a.id !== a1.id &&
                a.status === 'published',
            ),
          120_000,
          'the successor publishes ALPHA',
        );

        const old = after.attempts.find((a) => a.id === a1.id)!;
        expect(
          ['aborted', 'expired'],
          'old attempt ends aborted or expired',
        ).toContain(old.status);
        if (old.status === 'aborted')
          expect(['lease_lost', 'publication_rejected']).toContain(
            old.abortReason,
          );
        const successor = after.attempts.find(
          (a) =>
            a.taskId === alphaId && a.id !== a1.id && a.status === 'published',
        )!;
        expect(successor.lease.fencingToken).toBeGreaterThan(
          a1.lease.fencingToken,
        );
        expect(fencingMonotonic(after)).toBe(true);

        // nothing the zombie tried carries its attempt id or fence
        expect(
          after.outputs.filter((o) => o.attemptId === a1.id),
          'no output from the old attempt',
        ).toHaveLength(0);
        expect(
          after.findings.filter(
            (f) => f.attemptId === a1.id || /ZOMBIE/.test(f.claim),
          ),
          'no finding from the old attempt',
        ).toHaveLength(0);
        expect(
          after.tasks.filter(
            (t) => /ZOMBIE/.test(t.title) || t.parentId === alphaId,
          ),
          'no child task delegated by the old attempt',
        ).toHaveLength(0);
        expect(
          after.actions.filter(
            (a) =>
              a.attemptId === a1.id ||
              (a.taskId === alphaId &&
                a.authorFencingToken === a1.lease.fencingToken) ||
              /ZOMBIE/.test(a.rationale),
          ),
          'no intent (not even a blocked one) carries the old attempt id or fence',
        ).toHaveLength(0);
        expect(await committedActionRows(sys), 'no effect').toHaveLength(0);
        const zombieRequest = provider.calls.find((c) => c.n === held.n)!;
        expect(zombieRequest.reply, 'the zombie reply was really served').toBe(
          'tool_calls',
        );
        const recordedIds = ofKind(tail.events, 'model_call.recorded').map(
          (e) => e.payload.modelCallId as string,
        );
        if (zombieRequest.requestId)
          expect(
            recordedIds,
            'the zombie model call is not a recorded ModelCallRecord',
          ).not.toContain(zombieRequest.requestId);
        // the rejection is visible: an abort event, a failed tool call, or the worker's own fence error
        const rejectedToolCalls = ofKind(
          tail.events,
          'tool_call.recorded',
        ).filter(
          (e) =>
            e.payload.attemptId === a1.id &&
            !e.payload.ok &&
            /^call_/.test(e.payload.toolCallId),
        );
        const abortEvent = ofKind(tail.events, 'attempt.aborted').some(
          (e) =>
            e.payload.attemptId === a1.id &&
            ['lease_lost', 'publication_rejected'].includes(
              e.payload.abortReason,
            ),
        );
        const logged =
          /FenceError|fenc(e|ing)[^\n]*(lost|rejected|invalid|stale)|lease[_ ]lost/i.test(
            sys.logs(),
          );
        expect(
          rejectedToolCalls.length > 0 || abortEvent || logged,
          'a FenceError or rejection is visible (failed tool call, attempt.aborted, or worker log)',
        ).toBe(true);
      } finally {
        first.resume();
        zombieGate.release();
        successorGate.release();
        await finish(sys.api, mission.id, tail);
        await sys.resetWorkers();
      }
    }, 420_000);
});

async function doubleChange(kind: 'sequential' | 'coalesced') {
  const { system: sys, provider } = await system();
  await freshRun(sys);
  const { mission, tail, gate } = await holdAlphaMidAttempt(sys, provider);
  try {
    const alphaId = taskId(tail, ALPHA)!;
    const bravoId = taskId(tail, BRAVO)!;
    const before = await sys.api.snapshot(mission.id);
    const a1 = before.attempts.find((a) => a.taskId === alphaId)!;
    const r0 = before.receipts.find(
      (r) =>
        r.source.key === ALPHA_SOURCE && a1.readSetReceiptIds.includes(r.id),
    );
    expect(r0, 'the stranded attempt read the source').toBeDefined();
    await sys.worker!.kill('SIGKILL');
    const mark = tail.last;
    // two changes of the evidence the stranded attempt read, plus an unrelated owner banner edit,
    // all out of band while the worker is down
    const first = await changeSource(sys, 'cache.schema_version');
    if (kind === 'sequential')
      await waitRegistered(
        tail,
        ALPHA_SOURCE,
        first.result.version,
        mark,
        30_000,
      );
    const second = await changeSource(sys, 'cache.schema_version');
    const benign = await changeSource(sys, 'ui.banner_text');
    expect(second.result.version).toBeGreaterThan(first.result.version);
    expect(benign.result.version).toBeGreaterThan(benign.before.version);
    // the watcher walks config_versions and registers at least the head revision
    const head = await waitRegistered(
      tail,
      ALPHA_SOURCE,
      second.result.version,
      mark,
      30_000,
      'the app registers the head revision while the worker is down',
    );
    gate.release();
    await sys.startWorker();
    const snapshotAfter = await waitForMission(
      sys.api,
      mission.id,
      (s) =>
        s.attempts.some(
          (a) => a.taskId === alphaId && a.status === 'published' && a.n >= 2,
        ),
      120_000,
      'ALPHA recovered',
    );
    await sleep(10_000); // a repair storm would show itself here
    const snapshot = await sys.api.snapshot(mission.id);
    expect(snapshotAfter.mission.id).toBe(snapshot.mission.id);

    const registered = ofKind(tail.events, 'receipt.registered').filter(
      (e) => e.id > mark && e.payload.sourceKey === ALPHA_SOURCE,
    );
    if (kind === 'sequential')
      expect(
        registered.length,
        'each edit was registered because the first was awaited',
      ).toBeGreaterThanOrEqual(2);
    expect(
      registered.at(-1)!.payload.sourceRevision,
      'the newest registration is the head revision',
    ).toBeGreaterThanOrEqual(second.result.version);

    // exactly one invalidation per superseded revision
    const events = ofKind(tail.events, 'invalidation.recorded');
    const perRevision = new Map<string, number>();
    for (const e of events) {
      const key = `${e.payload.sourceKey}|${e.payload.oldReceiptId}`;
      perRevision.set(key, (perRevision.get(key) ?? 0) + 1);
    }
    for (const [key, count] of perRevision)
      expect(count, `invalidation events for ${key}`).toBe(1);
    // the benign change may be recorded, but only with empty affected sets
    for (const e of events.filter(
      (x) => x.payload.sourceKey === 'checkout.config/ui.banner_text',
    ))
      for (const field of [
        'attemptIds',
        'outputIds',
        'actionIds',
        'taskIds',
      ] as const)
        expect(
          e.payload.affected[field],
          `benign banner invalidation affects no ${field}`,
        ).toEqual([]);
    expect(
      events.every(
        (e) => !(e.payload.affected.taskIds as string[]).includes(bravoId),
      ),
      'independent branch untouched',
    ).toBe(true);
    for (const [key, count] of repairsByInvalidation(snapshot))
      expect(count, `repairs for ${key}`).toBeLessThanOrEqual(1);
    for (const [id, count] of attemptsPerTask(snapshot))
      expect(count, `attempts of task ${id}`).toBeLessThanOrEqual(4);
    expect(
      provider.calls.length,
      'total model calls in the trial',
    ).toBeLessThanOrEqual(120);

    // the successor reads only the head receipt of the source: no resurrection of R0 or of an intermediate
    const successor = snapshot.attempts
      .filter(
        (a) => a.taskId === alphaId && a.status === 'published' && a.n >= 2,
      )
      .at(-1)!;
    const sourceReceiptIds = snapshot.receipts
      .filter((r) => r.source.key === ALPHA_SOURCE)
      .map((r) => r.id as string);
    expect(
      successor.readSetReceiptIds.filter((id) => sourceReceiptIds.includes(id)),
      "the successor's readset contains only the head receipt of the source",
    ).toEqual([head.payload.receiptId]);

    const bySource = new Map<string, typeof snapshot.receipts>();
    for (const r of snapshot.receipts)
      bySource.set(r.source.key, [...(bySource.get(r.source.key) ?? []), r]);
    for (const [key, receipts] of bySource) {
      const current = receipts.filter(
        (r) => r.supersededBy === null && r.status === 'supported',
      );
      expect(
        current.length,
        `at most one current receipt for ${key}`,
      ).toBeLessThanOrEqual(1);
      const top = Math.max(...receipts.map((r) => r.sourceRevision));
      for (const r of current)
        expect(
          r.sourceRevision,
          `current receipt for ${key} is the newest revision`,
        ).toBe(top);
    }
    const superseded = new Set(
      snapshot.receipts
        .filter((r) => r.supersededBy !== null)
        .map((r) => r.id as string),
    );
    for (const f of snapshot.findings.filter((x) => x.usable))
      expect(
        (f.supportingReceiptIds as string[]).filter((id) => superseded.has(id)),
        'no usable finding on a superseded receipt',
      ).toEqual([]);
    for (const o of snapshot.outputs.filter((x) => x.usable))
      expect(
        o.dependencyVector.filter((d) => superseded.has(d.receiptId)),
        'no usable output on a superseded receipt',
      ).toEqual([]);
  } finally {
    await finish(sys.api, mission.id, tail);
  }
}

describe('G4.6 two source changes while recovery is pending', () => {
  it('G4.6a each change registered in turn: recovery stays bounded, never resurrects an old revision, and the benign change invalidates nothing', async () => {
    await doubleChange('sequential');
  }, 420_000);

  it('G4.6b back-to-back changes: the head revision is registered, intermediate ones may coalesce, recovery stays bounded', async () => {
    await doubleChange('coalesced');
  }, 420_000);
});
