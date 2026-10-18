// Worker host behaviour with a scripted coordinator (the real coordinator is
// exercised in integration/coordinator/worker-host).
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AttemptAbortedError,
  classifyDrift,
  createWorkerHost,
  type HandlerOutcome,
  type WorkerHostCoordinator,
} from '../../../src/server/nemodots/coordinator/worker-host.js';
import {
  FenceError,
  SupportError,
} from '../../../src/server/nemodots/coordinator/errors.js';
import type { AttemptState } from '../../../src/server/nemodots/coordinator/leases.js';
import type { ClaimedAttempt } from '../../../src/server/nemodots/coordinator/types.js';
import type { AttemptContext } from '../../../src/server/nemodots/contracts/index.js';

const context = (): AttemptContext =>
  ({
    missionId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fencingToken: 3,
    generation: 0,
    capabilities: ['observe'],
    role: 'investigator',
  }) as AttemptContext;

const claimed = (ctx = context()): ClaimedAttempt => ({
  context: ctx,
  attempt: {
    n: 1,
    kind: 'initial',
    leaseExpiresAt: new Date().toISOString(),
    inheritedDependencyVector: [],
    repairOf: null,
  },
  task: {
    title: 't',
    question: 'q',
    parentId: null,
    depth: 0,
    maxIterations: 3,
    maxTokens: 100,
    maxChildren: 0,
  },
  mission: { goal: 'g', constraints: [] },
  leaseMs: 300,
});

const healthy = (ctx: AttemptContext): AttemptState => ({
  attemptStatus: 'running',
  abortReason: null,
  attemptToken: ctx.fencingToken,
  attemptGeneration: ctx.generation,
  taskFence: ctx.fencingToken,
  leaseExpired: false,
  missionStatus: 'running',
  missionGeneration: ctx.generation,
});

describe('classifyDrift', () => {
  const ctx = context();
  const cases: [string, Partial<AttemptState> | null, string | null][] = [
    ['healthy', {}, null],
    ['row vanished', null, 'lease_lost'],
    [
      'ledger invalidated the attempt',
      { attemptStatus: 'invalidated' },
      'readset_invalidated',
    ],
    [
      'aborted with a recorded reason',
      { attemptStatus: 'aborted', abortReason: 'mission_paused' },
      'mission_paused',
    ],
    [
      'publication rejected',
      { attemptStatus: 'invalidated', abortReason: 'publication_rejected' },
      'publication_rejected',
    ],
    ['expired by the reaper', { attemptStatus: 'expired' }, 'lease_lost'],
    [
      'aborted without a reason',
      { attemptStatus: 'aborted', abortReason: null },
      'lease_lost',
    ],
    ['published elsewhere', { attemptStatus: 'published' }, 'lease_lost'],
    ['mission paused', { missionStatus: 'paused' }, 'mission_paused'],
    ['mission cancelled', { missionStatus: 'cancelled' }, 'mission_cancelled'],
    ['mission failed', { missionStatus: 'failed' }, 'mission_cancelled'],
    [
      'mission awaiting acceptance',
      { missionStatus: 'awaiting_acceptance' },
      'mission_cancelled',
    ],
    ['generation moved', { missionGeneration: 1 }, 'mission_cancelled'],
    ['token taken over (attempt row)', { attemptToken: 9 }, 'lease_lost'],
    ['token taken over (task fence)', { taskFence: 9 }, 'lease_lost'],
    ['lease expired', { leaseExpired: true }, 'lease_lost'],
  ];
  it.each(cases)('%s', (_label, patch, expected) => {
    const state = patch === null ? null : { ...healthy(ctx), ...patch };
    expect(classifyDrift(state, ctx)).toBe(expected);
  });
});

interface Script {
  state: AttemptState | null | ((ctx: AttemptContext) => AttemptState | null);
  heartbeat?: () => Promise<unknown>;
  publishOutput?: () => Promise<unknown>;
  publishPlan?: () => Promise<unknown>;
  failAttempt?: () => Promise<unknown>;
}

function scripted(ctx: AttemptContext, script: Script) {
  const calls: string[] = [];
  const coordinator: WorkerHostCoordinator = {
    async claimAttempt() {
      calls.push('claim');
      return claimed(ctx);
    },
    async startAttempt() {
      calls.push('start');
    },
    async heartbeat() {
      calls.push('heartbeat');
      return script.heartbeat ? script.heartbeat() : undefined;
    },
    async readAttemptState() {
      calls.push('state');
      return typeof script.state === 'function'
        ? script.state(ctx)
        : script.state;
    },
    async publishOutput() {
      calls.push('publishOutput');
      return script.publishOutput?.();
    },
    async publishPlan() {
      calls.push('publishPlan');
      return script.publishPlan?.();
    },
    async failAttempt(_c, f) {
      calls.push(`failAttempt:${f.reason}`);
      return script.failAttempt?.();
    },
    async abortAttempt(_c, r) {
      calls.push(`abortAttempt:${r}`);
    },
  };
  return { coordinator, calls };
}

const out: HandlerOutcome = {
  type: 'output',
  output: { kind: 'handoff', content: {}, dependencyVector: [] },
};
const host = (
  coordinator: WorkerHostCoordinator,
  handler: Parameters<typeof createWorkerHost>[0]['handler'],
  over: Record<string, unknown> = {},
) =>
  createWorkerHost({
    coordinator,
    workerId: 'w',
    handler,
    leaseMs: 300,
    abortCheckMs: 20,
    pollMs: 10,
    ...over,
  });

describe('worker host', () => {
  it('claims, starts, runs the handler and publishes its output', async () => {
    const ctx = context();
    const { coordinator, calls } = scripted(ctx, { state: healthy(ctx) });
    const run = await host(coordinator, async () => out).runOnce();
    expect(run?.result).toBe('published');
    expect(calls.slice(0, 2)).toEqual(['claim', 'start']);
    expect(calls).toContain('publishOutput');
    expect(calls.indexOf('publishOutput')).toBeGreaterThan(
      calls.indexOf('start'),
    );
  });

  it('returns null when nothing is claimable', async () => {
    const coordinator = {
      ...scripted(context(), { state: null }).coordinator,
      claimAttempt: async () => null,
    };
    expect(await host(coordinator, async () => out).runOnce()).toBeNull();
  });

  it('aborts the handler on drift within the check interval and never publishes', async () => {
    const ctx = context();
    let drifted = false;
    const { coordinator, calls } = scripted(ctx, {
      state: () =>
        drifted
          ? { ...healthy(ctx), attemptStatus: 'invalidated' }
          : healthy(ctx),
    });
    let sawSignal = false;
    const h = host(coordinator, async (_c, helpers) => {
      setTimeout(() => {
        drifted = true;
      }, 40);
      await new Promise<void>((resolve) =>
        helpers.signal.addEventListener('abort', () => resolve()),
      );
      sawSignal = helpers.signal.aborted;
      return out; // returns an output after the abort: must not be published
    });
    const started = Date.now();
    const run = await h.runOnce();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sawSignal).toBe(true);
    expect(run).toMatchObject({
      result: 'aborted',
      abortReason: 'readset_invalidated',
    });
    expect(calls).not.toContain('publishOutput');
    expect(calls.some((call) => call.startsWith('failAttempt'))).toBe(false);
  });

  it('checkpoint() throws AttemptAbortedError at a tool boundary', async () => {
    const ctx = context();
    const { coordinator } = scripted(ctx, {
      state: { ...healthy(ctx), missionStatus: 'paused' },
    });
    let caught: unknown;
    const run = await host(
      coordinator,
      async (_c, helpers) => {
        try {
          await helpers.checkpoint();
        } catch (error) {
          caught = error;
          throw error;
        }
        return out;
      },
      { abortCheckMs: 60_000 },
    ).runOnce();
    expect(caught).toBeInstanceOf(AttemptAbortedError);
    expect((caught as AttemptAbortedError).reason).toBe('mission_paused');
    expect(run).toMatchObject({
      result: 'aborted',
      abortReason: 'mission_paused',
    });
  });

  it('a heartbeat FenceError aborts with lease_lost; other heartbeat errors are reported, not fatal', async () => {
    const ctx = context();
    let n = 0;
    const errors: unknown[] = [];
    const { coordinator } = scripted(ctx, {
      state: healthy(ctx),
      heartbeat: async () => {
        n += 1;
        if (n === 1) throw new Error('connection reset');
        throw new FenceError(ctx.attemptId, 'token_mismatch');
      },
    });
    const run = await host(
      coordinator,
      async (_c, helpers) => {
        await new Promise<void>((resolve) =>
          helpers.signal.addEventListener('abort', () => resolve()),
        );
        return out;
      },
      { leaseMs: 60, onError: (e: unknown) => errors.push(e) },
    ).runOnce();
    expect(run).toMatchObject({ result: 'aborted', abortReason: 'lease_lost' });
    expect(errors.map((e) => (e as Error).message)).toContain(
      'connection reset',
    );
  });

  it('a handler error fails the attempt with the error message', async () => {
    const ctx = context();
    const { coordinator, calls } = scripted(ctx, { state: healthy(ctx) });
    const run = await host(coordinator, async () => {
      throw new Error('model returned garbage');
    }).runOnce();
    expect(run?.result).toBe('failed');
    expect(calls).toContain('failAttempt:model returned garbage');
  });

  it('maps handler outcomes to coordinator calls', async () => {
    const ctx = context();
    for (const [outcome, expected] of [
      [
        { type: 'failed', reason: 'invalid_output' },
        'failAttempt:invalid_output',
      ],
      [
        { type: 'abort', reason: 'provider_unreachable' },
        'abortAttempt:provider_unreachable',
      ],
      [{ type: 'plan', plan: {}, createdByModelCallId: null }, 'publishPlan'],
      [{ type: 'published' }, null],
    ] as [HandlerOutcome, string | null][]) {
      const { coordinator, calls } = scripted(ctx, { state: healthy(ctx) });
      await host(coordinator, async () => outcome).runOnce();
      if (expected) expect(calls).toContain(expected);
      else
        expect(
          calls.filter(
            (c) =>
              c.startsWith('publish') ||
              c.startsWith('fail') ||
              c.startsWith('abort'),
          ),
        ).toEqual([]);
    }
  });

  it('publication outcomes: FenceError -> fenced, SupportError -> support_rejected, other errors fail the attempt', async () => {
    const ctx = context();
    const run = async (publishOutput: () => Promise<unknown>) => {
      const { coordinator, calls } = scripted(ctx, {
        state: healthy(ctx),
        publishOutput,
      });
      return { run: await host(coordinator, async () => out).runOnce(), calls };
    };
    expect(
      (
        await run(async () => {
          throw new FenceError(ctx.attemptId, 'attempt_not_running');
        })
      ).run?.result,
    ).toBe('fenced');
    const rejected = await run(async () => {
      throw new SupportError('stale_version');
    });
    expect(rejected.run?.result).toBe('support_rejected');
    expect(rejected.calls.some((c) => c.startsWith('failAttempt'))).toBe(false); // the repair is already scheduled
    const broken = await run(async () => {
      throw new RangeError('output too large');
    });
    expect(broken.run?.result).toBe('failed');
    expect(broken.calls).toContain('failAttempt:output too large');
  });

  it('if the start is fenced the run is skipped without invoking the handler', async () => {
    const ctx = context();
    const { coordinator } = scripted(ctx, { state: healthy(ctx) });
    coordinator.startAttempt = async () => {
      throw new FenceError(ctx.attemptId, 'lease_expired');
    };
    let invoked = false;
    const run = await host(coordinator, async () => {
      invoked = true;
      return out;
    }).runOnce();
    expect(run?.result).toBe('fenced');
    expect(invoked).toBe(false);
  });

  it('stop() aborts in-flight attempts with host_stopped and publishes nothing', async () => {
    const ctx = context();
    const { coordinator, calls } = scripted(ctx, { state: healthy(ctx) });
    const runs: string[] = [];
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = host(
      coordinator,
      async (_c, helpers) => {
        started();
        await new Promise<void>((resolve) =>
          helpers.signal.addEventListener('abort', () => resolve()),
        );
        return out;
      },
      {
        onRun: (r: { result: string; abortReason: string | null }) =>
          runs.push(`${r.result}:${r.abortReason}`),
      },
    );
    h.start();
    await handlerStarted;
    await h.stop();
    expect(runs[0]).toBe('aborted:host_stopped');
    expect(calls).not.toContain('publishOutput');
  });
});
