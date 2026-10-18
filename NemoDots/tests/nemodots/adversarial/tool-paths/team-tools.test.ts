// W5.3: the nine team tools (TOOL_COVERAGE section 1) attacked through the
// production executor (team/tools.ts) with recording port doubles. These are
// executor-boundary checks: identity from AttemptContext, model-supplied ids,
// strict payloads, unknown ActionKind, runbook traversal, unknown and
// prototype tool names. The DB-backed composed checks are in composed.test.ts.
// LABEL: the ports here are recording doubles, not product behaviour.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AttemptContext,
  type ContextSnapshot,
  type DependencyEntry,
  type ModelCallId,
  type ObservationReceipt,
  type ReceiptId,
  ROLE_CAPABILITIES,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  createRunbookStore,
  type TeamDeps,
} from '../../../../src/server/nemodots/team/index.js';
import {
  createToolExecutor,
  newLoopState,
} from '../../../../src/server/nemodots/team/tools.js';
import type { ClaimedAttempt } from '../../../../src/server/nemodots/coordinator/types.js';

const MISSION = randomUUID();
const FOREIGN_MISSION = randomUUID();

function context(
  role: 'cache_specialist' | 'investigator' = 'cache_specialist',
) {
  return {
    missionId: MISSION,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fencingToken: 1,
    generation: 0,
    capabilities: [...ROLE_CAPABILITIES[role]],
    role,
  } as unknown as AttemptContext;
}

function receipt(key: string, value: unknown): ObservationReceipt {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    source: {
      key,
      sourceType: key.startsWith('checkout.config/')
        ? 'controlled_config'
        : 'observed_endpoint',
      authority: key.startsWith('checkout.config/') ? 'controlled' : 'observed',
      scope: {
        ownerId: 'owner',
        missionId: MISSION,
        spaceId: null,
        environment: 'dev',
        resource: 'checkout',
      },
    },
    sourceRevision: 4,
    collectionRevision: null,
    observedAt: at,
    lastConfirmedAt: at,
    contentDigest: 'a'.repeat(64),
    normalizedValue: value,
    rawRef: null,
    status: 'supported',
    statusVersion: 1,
    supersedes: null,
    supersededBy: null,
    trust: 'controlled_authority',
  } as unknown as ObservationReceipt;
}

function harness(
  role: 'cache_specialist' | 'investigator' = 'cache_specialist',
) {
  const ctx = context(role);
  const calls = {
    propose: [] as unknown[],
    findings: [] as unknown[],
    taskStatus: [] as { missionId: string; taskId: string }[],
    delegations: [] as unknown[],
    observed: [] as string[],
  };
  const verifierTask = randomUUID();
  const deps = {
    inference: {} as never,
    coordinator: {
      async publishFinding(_c: AttemptContext, input: unknown) {
        calls.findings.push(input);
        return { findingId: randomUUID() };
      },
      async delegate(_c: AttemptContext, input: unknown) {
        calls.delegations.push(input);
        return { taskId: verifierTask, created: true };
      },
      async recordModelCall() {},
      async addReadSet() {},
      async markWaiting() {},
      async resumeFromWaiting() {
        return { allTerminal: true, children: [] };
      },
      async requestReplan() {
        return { scheduled: true };
      },
      async getTaskStatus(missionId: string, taskId: string) {
        calls.taskStatus.push({ missionId, taskId });
        return {
          task: { status: 'succeeded', role: 'verifier', title: 'verify' },
          outputUsable: true,
        };
      },
    },
    observer: {
      async observe(_c: AttemptContext, input: { sourceKey: string }) {
        calls.observed.push(input.sourceKey);
        return receipt(input.sourceKey, {
          key: input.sourceKey.replace('checkout.config/', ''),
          value: 'catalog-a',
          version: 4,
        });
      },
    },
    actions: {
      async propose(input: unknown) {
        calls.propose.push(input);
        return {
          id: randomUUID(),
          status: 'proposed',
          blockReason: null,
          blockDetail: null,
        };
      },
    },
    reads: {
      scope: () => ({}) as never,
      outputsOf: async () => [],
      prerequisiteOutputs: async () => [],
      invalidationSummaries: async () => [],
      missionTasks: async () => [],
    },
    runbooks: createRunbookStore(),
    // The product's incident configuration: pre-change verification ON.
    config: {
      model: 'adversary-model',
      provider: { host: 'adversary.invalid', mode: 'fixture' },
      requireVerifier: true,
    },
    onEvent: () => {},
  } as unknown as TeamDeps;
  const claimed = {
    context: ctx,
    attempt: {
      n: 1,
      kind: 'initial',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      inheritedDependencyVector: [],
      repairOf: null,
    },
    task: {
      title: 't',
      question: 'q',
      parentId: null,
      depth: 0,
      maxIterations: 12,
      maxTokens: 20_000,
      maxChildren: 4,
    },
    mission: { goal: 'g', constraints: [] },
    leaseMs: 30_000,
  } as unknown as ClaimedAttempt;
  const helpers = {
    signal: new AbortController().signal,
    checkpoint: async () => {},
    abortReason: () => null,
  };
  const state = newLoopState();
  const executor = createToolExecutor(deps, claimed, helpers as never, state);
  let vector: DependencyEntry[] = [];
  const call = (toolCallId = `call_${randomUUID().slice(0, 8)}`) => ({
    toolCallId,
    modelCallId: randomUUID() as ModelCallId,
    snapshot: { dependencyVector: vector } as unknown as ContextSnapshot,
  });
  const exec = async (name: string, args: unknown) => {
    const outcome = await executor.execute(name, args, call());
    vector = [...vector, ...outcome.vector];
    return {
      ...outcome,
      body: JSON.parse(outcome.content) as Record<string, unknown>,
    };
  };
  /** Observe the target and obtain a verifier confirmation, as the policy requires. */
  const prepare = async (key = 'checkout.config/cache.namespace') => {
    const observed = await exec('observe_source', { sourceKey: key });
    await exec('delegate_task', {
      title: 'Verify the reading',
      role: 'verifier',
      question: 'Is the namespace reading correct?',
      dependsOn: [],
      justification: 'independent verification before a change',
    });
    return observed.body.receiptId as string;
  };
  return { ctx, calls, exec, prepare, state };
}

describe('unknown and prototype tool names', () => {
  it.each(['delete_everything', 'observe_source ', 'Observe_Source', 'shell'])(
    'TP-20 %j is answered with unknown_tool and touches no port',
    async (name) => {
      const h = harness();
      const out = await h.exec(name, {});
      expect(out.ok).toBe(false);
      expect(out.body.error).toBe('unknown_tool');
      expect(h.calls).toMatchObject({
        propose: [],
        findings: [],
        observed: [],
      });
    },
  );

  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'valueOf',
  ])(
    'TP-21 Object.prototype name %j is answered with unknown_tool (not a crash)',
    async (name) => {
      // tools.ts:397 tests `name in TEAM_TOOL_INPUTS`; `in` walks the
      // prototype chain, the switch matches nothing, and `outcome.ok` throws.
      const h = harness();
      const out = await h.exec(name, {}).catch((error: Error) => ({
        ok: 'threw',
        body: { error: `${error.name}: ${error.message}` },
      }));
      expect(out.body.error).toBe('unknown_tool');
    },
  );
});

describe('read_runbook traversal (I13)', () => {
  it.each([
    '../x',
    '../../../../etc/passwd',
    'acceptance.md',
    '/acceptance',
    'acceptance/../acceptance',
    'ACCEPTANCE',
    'acceptance\u0000',
    '%2e%2e%2fpackage.json',
    'constructor',
    '__proto__',
    'toString',
    'runbooks/acceptance',
  ])('TP-22 %j resolves to nothing', async (id) => {
    const h = harness();
    const out = await h.exec('read_runbook', { id });
    expect(out.ok).toBe(false);
    expect(['invalid_arguments', 'unknown_runbook']).toContain(out.body.error);
  });

  it('TP-22b a catalogue id still reads its file (the check is not vacuous)', async () => {
    const h = harness();
    const out = await h.exec('read_runbook', { id: 'acceptance' });
    expect(out.ok).toBe(true);
    expect(String(out.body.text).length).toBeGreaterThan(20);
  });
});

describe('propose_action payload and identity', () => {
  const flush = {
    action: 'flush_cache_namespace',
    payload: { namespace: 'catalog-a', reason: 'stale schema entries' },
    rationale: 'entries under the wrong schema',
  };

  it('TP-23 baseline: a well-formed proposal after observe + verifier reaches the admission port', async () => {
    const h = harness();
    const cited = await h.prepare();
    const out = await h.exec('propose_action', {
      ...flush,
      supportingReceiptIds: [cited],
    });
    expect(out.ok).toBe(true);
    expect(h.calls.propose).toHaveLength(1);
  });

  it.each([
    [
      'causedByActionId in the payload',
      { payload: { ...flush.payload, causedByActionId: randomUUID() } },
    ],
    ['missionId at the top level', { missionId: FOREIGN_MISSION }],
    ['taskId at the top level', { taskId: randomUUID() }],
    ['attemptId at the top level', { attemptId: randomUUID() }],
    ['ownerId at the top level', { ownerId: 'someone-else' }],
    ['a dependencyVector', { dependencyVector: [] }],
    ['an idempotencyKey', { idempotencyKey: 'k' }],
    ['an expectedTargetVersion', { expectedTargetVersion: 1 }],
    ['a dispatch fence', { dispatch: { fence: 1 } }],
  ])(
    'TP-24 a proposal carrying %s is rejected before the port',
    async (_label, extra) => {
      const h = harness();
      const cited = await h.prepare();
      const out = await h.exec('propose_action', {
        ...flush,
        supportingReceiptIds: [cited],
        ...extra,
      });
      expect(out.ok).toBe(false);
      expect(h.calls.propose).toEqual([]);
    },
  );

  it.each([
    'restart_service',
    'run_sql',
    'set_config ',
    'SET_CONFIG',
    'flush_all',
    '__proto__',
  ])('TP-25 unknown ActionKind %j never reaches the port', async (action) => {
    const h = harness();
    const cited = await h.prepare();
    const out = await h.exec('propose_action', {
      ...flush,
      action,
      supportingReceiptIds: [cited],
    });
    expect(out.ok).toBe(false);
    expect(h.calls.propose).toEqual([]);
  });

  it('TP-25b a set_config payload under flush_cache_namespace (kind/payload mismatch) is rejected', async () => {
    const h = harness();
    const cited = await h.prepare();
    const out = await h.exec('propose_action', {
      action: 'flush_cache_namespace',
      payload: {
        key: 'cache.namespace',
        value: 'x',
        expectedCurrentValueDigest: 'a'.repeat(64),
      },
      supportingReceiptIds: [cited],
      rationale: 'r',
    });
    expect(out.ok).toBe(false);
    expect(h.calls.propose).toEqual([]);
  });

  it('TP-25c a model-supplied expectedCurrentValueDigest is replaced by the server-derived one', async () => {
    const h = harness();
    const cited = await h.prepare('checkout.config/db.pool_max');
    await h.exec('propose_action', {
      action: 'set_config',
      payload: {
        key: 'db.pool_max',
        value: 10,
        expectedCurrentValueDigest: 'f'.repeat(64),
      },
      supportingReceiptIds: [cited],
      rationale: 'raise the pool',
    });
    const sent = h.calls.propose[0] as {
      payload: { expectedCurrentValueDigest: string };
    };
    expect(sent.payload.expectedCurrentValueDigest).not.toBe('f'.repeat(64));
  });

  it('TP-26 an investigator cannot propose at all (capability from context, not from the model)', async () => {
    const h = harness('investigator');
    const out = await h.exec('propose_action', {
      ...flush,
      supportingReceiptIds: [],
      capabilities: ['propose_cache_flush'],
    });
    expect(out.ok).toBe(false);
    expect(out.body.error).toBe('capability_denied');
    expect(h.calls.propose).toEqual([]);
  });
});

describe('citations (I8) at the executor', () => {
  it('TP-27 a receipt id the attempt never saw (e.g. from page prose or another mission) is out of scope', async () => {
    const h = harness();
    await h.prepare();
    const foreign = randomUUID() as ReceiptId;
    const finding = await h.exec('publish_finding', {
      claim: 'the namespace is wrong',
      supportingReceiptIds: [foreign],
      confidence: 'high',
    });
    expect(finding.body.error).toBe('citation_out_of_scope');
    expect(h.calls.findings).toEqual([]);
    const proposal = await h.exec('propose_action', {
      action: 'flush_cache_namespace',
      payload: { namespace: 'catalog-a', reason: 'r' },
      supportingReceiptIds: [foreign],
      rationale: 'r',
    });
    expect(proposal.body.error).toBe('citation_out_of_scope');
    expect(h.calls.propose).toEqual([]);
  });
});

describe('model-supplied task ids', () => {
  it('TP-28 get_task_status always queries the attempt mission, whatever id the model names', async () => {
    const h = harness();
    const someTask = randomUUID();
    await h.exec('get_task_status', { taskId: someTask });
    expect(h.calls.taskStatus).toEqual([
      { missionId: MISSION, taskId: someTask },
    ]);
  });

  it('TP-28b get_task_status with an extra missionId argument is rejected', async () => {
    const h = harness();
    const out = await h.exec('get_task_status', {
      taskId: randomUUID(),
      missionId: FOREIGN_MISSION,
    });
    expect(out.body.error).toBe('invalid_arguments');
    expect(h.calls.taskStatus).toEqual([]);
  });

  it('TP-28c delegate_task cannot name a planner/postcondition role or set capabilities', async () => {
    const h = harness('investigator');
    for (const args of [
      { role: 'planner' },
      { role: 'postcondition' },
      { role: 'verifier', capabilities: ['propose_config_change'] },
    ]) {
      const out = await h.exec('delegate_task', {
        title: 't',
        question: 'q',
        dependsOn: [],
        justification: 'j',
        ...args,
      });
      expect(out.ok).toBe(false);
    }
    expect(h.calls.delegations).toEqual([]);
  });
});
