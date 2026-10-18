// Tool policy: capability checks, scope checks, identity and provenance of
// propose_action, runbook catalogue. Scripted model policies (labelled doubles).
import { describe, expect, it } from 'vitest';
import { digest } from '../../../src/server/nemodots/contracts/index.js';
import { precheckDelegation } from '../../../src/server/nemodots/team/index.js';
import {
  calls,
  claimed,
  digestToUuid,
  rig,
  runHandler,
  text,
  toolResultsOf,
  uuid,
} from './harness.js';

const KEY = 'cache.schema_version';
const SOURCE = `checkout.config/${KEY}`;
const config = { key: KEY, value: 4, version: 3 };

function configRig(steps: Parameters<typeof rig>[0]) {
  const r = rig(steps);
  r.observer.values.set(SOURCE, config);
  r.observer.values.set('checkout.health', { status: 'degraded' });
  return r;
}

const propose = (extra: object = {}, id = 'p1') =>
  calls({
    id,
    name: 'propose_action',
    args: {
      action: 'set_config',
      payload: {
        key: KEY,
        value: 1,
        expectedCurrentValueDigest: '0'.repeat(64),
      },
      supportingReceiptIds: [],
      rationale: 'restore the schema the stored entries carry',
      ...extra,
    },
  });

describe('D5: an investigator cannot propose; the transcript shows the delegation path', () => {
  it('propose_action is refused with capability_denied, then the investigator delegates and waits', async () => {
    const r = configRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      propose(),
      calls({
        id: 'd',
        name: 'delegate_task',
        args: {
          title: 'Repair cache schema',
          role: 'cache_specialist',
          question: 'Restore the cache schema the entries carry.',
          dependsOn: [],
          justification: 'metrics show a schema mismatch (receipt cited)',
        },
      }),
      calls({ id: 'w', name: 'wait_for_children', args: {} }),
      text('The cache specialist handled the repair.'),
    ]);
    const outcome = await runHandler(r, claimed('investigator'));
    expect(outcome.type).toBe('output');
    // never reached the action boundary
    expect(r.actions.proposals).toHaveLength(0);
    // the transcript, as the model saw it on its last call
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results.map((x) => [x.id, x.body.ok, x.body.error])).toEqual([
      ['o', true, undefined],
      ['p1', false, 'capability_denied'],
      ['d', true, undefined],
      ['w', true, undefined],
    ]);
    expect(String(results[1].body.message)).toContain('delegate');
    expect(r.coordinator.delegations).toHaveLength(1);
    expect(r.coordinator.delegations[0]).toMatchObject({
      role: 'cache_specialist',
      toolCallId: 'd',
      justification: expect.stringContaining('mismatch'),
    });
  });

  it('delegation pre-checks: role table, justification, capability', () => {
    const investigator = {
      role: 'investigator' as const,
      capabilities: ['observe', 'delegate'] as never,
    };
    const specialist = {
      role: 'cache_specialist' as const,
      capabilities: ['observe', 'delegate'] as never,
    };
    const verifier = {
      role: 'verifier' as const,
      capabilities: ['observe'] as never,
    };
    expect(
      precheckDelegation(investigator, 'cache_specialist', 'because'),
    ).toMatchObject({ ok: true });
    expect(precheckDelegation(specialist, 'verifier', 'because')).toMatchObject(
      { ok: true },
    );
    expect(
      precheckDelegation(specialist, 'investigator', 'because'),
    ).toMatchObject({ ok: false, error: 'role_not_delegable' });
    expect(
      precheckDelegation(specialist, 'database_specialist', 'because'),
    ).toMatchObject({ ok: false, error: 'role_not_delegable' });
    expect(precheckDelegation(verifier, 'verifier', 'because')).toMatchObject({
      ok: false,
      error: 'capability_denied',
    });
    expect(precheckDelegation(investigator, 'verifier', '  ')).toMatchObject({
      ok: false,
      error: 'justification_required',
    });
    // child capabilities are the role defaults intersected with the parent's
    const narrow = precheckDelegation(
      { role: 'investigator', capabilities: ['delegate', 'observe'] as never },
      'cache_specialist',
      'because',
    );
    expect(narrow).toMatchObject({
      ok: true,
      childCapabilities: ['observe', 'delegate'],
    });
  });

  it('a specialist may delegate only a verifier; the coordinator rejection reaches the model as a tool error', async () => {
    const r = configRig([
      calls({
        id: 'bad',
        name: 'delegate_task',
        args: {
          title: 't',
          role: 'investigator',
          question: 'q',
          dependsOn: [],
          justification: 'j',
        },
      }),
      calls({
        id: 'good',
        name: 'delegate_task',
        args: {
          title: 't',
          role: 'verifier',
          question: 'q',
          dependsOn: [],
          justification: 'j',
        },
      }),
      text('ok'),
    ]);
    r.coordinator.delegateError = Object.assign(
      new Error('delegation rejected: depth'),
      {
        name: 'DelegationRejectedError',
        issues: ['depth 4 exceeds 3'],
      },
    );
    await runHandler(r, claimed('cache_specialist'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results[0].body).toMatchObject({
      ok: false,
      error: 'role_not_delegable',
    });
    expect(results[1].body).toMatchObject({
      ok: false,
      error: 'delegation_rejected',
      issues: ['depth 4 exceeds 3'],
    });
  });
});

describe('scope: identity and citations never come from the model', () => {
  it('a model-supplied missionId or taskId is rejected by the strict tool schemas', async () => {
    const r = configRig([
      calls({
        id: 'a',
        name: 'observe_source',
        args: { sourceKey: SOURCE, missionId: uuid() },
      }),
      calls({
        id: 'b',
        name: 'delegate_task',
        args: {
          title: 't',
          role: 'verifier',
          question: 'q',
          dependsOn: [],
          justification: 'j',
          taskId: uuid(),
        },
      }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results.map((x) => x.body.error)).toEqual([
      'invalid_arguments',
      'invalid_arguments',
    ]);
    expect(r.observer.calls).toHaveLength(0);
    expect(r.coordinator.delegations).toHaveLength(0);
  });

  it('a finding citing a receipt outside the scope is refused and never published', async () => {
    const r = configRig([
      calls({
        id: 'o',
        name: 'observe_source',
        args: { sourceKey: 'checkout.health' },
      }),
      calls({
        id: 'f',
        name: 'publish_finding',
        args: {
          claim: 'cache is broken',
          supportingReceiptIds: [digestToUuid('foreign')],
          confidence: 'high',
        },
      }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results[1].body).toMatchObject({
      ok: false,
      error: 'citation_out_of_scope',
    });
    expect(r.coordinator.findings).toHaveLength(0);
  });

  it('a finding citing its own reading is published with the snapshot-derived vector', async () => {
    const r = configRig([
      calls({
        id: 'o',
        name: 'observe_source',
        args: { sourceKey: 'checkout.health' },
      }),
      text('placeholder'),
    ]);
    // the model reads, then cites the receipt id it was given
    const receiptId = digestToUuid(
      `checkout.health:1:${JSON.stringify({ status: 'degraded' })}`,
    );
    r.inference['steps'] = [
      calls({
        id: 'o',
        name: 'observe_source',
        args: { sourceKey: 'checkout.health' },
      }),
      calls({
        id: 'f',
        name: 'publish_finding',
        args: {
          claim: 'health is degraded',
          supportingReceiptIds: [receiptId],
          confidence: 'high',
        },
      }),
      text('done'),
    ];
    await runHandler(r, claimed('investigator'));
    expect(r.coordinator.findings).toHaveLength(1);
    expect(r.coordinator.findings[0]).toMatchObject({
      supportingReceiptIds: [receiptId],
      claim: 'health is degraded',
    });
    expect(
      (
        r.coordinator.findings[0].dependencyVector as { receiptId: string }[]
      ).map((e) => e.receiptId),
    ).toContain(receiptId);
  });

  it('get_task_status for a task outside the mission is a tool error', async () => {
    const r = configRig([
      calls({ id: 's', name: 'get_task_status', args: { taskId: uuid() } }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body).toMatchObject({
      ok: false,
      error: 'task_not_found',
    });
  });
});

describe('propose_action (specialists)', () => {
  it('passes the emitting call and tool call ids, uses a server-derived digest and the snapshot that covers the reading (C5/C10)', async () => {
    const r = configRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      propose({ supportingReceiptIds: [] }, 'prop'),
      text('proposal submitted'),
    ]);
    const claim = claimed('cache_specialist');
    // cite the reading the model received
    const receiptId = digestToUuid(`${SOURCE}:1:${JSON.stringify(config)}`);
    r.inference['steps'][1] = propose(
      { supportingReceiptIds: [receiptId] },
      'prop',
    );
    const outcome = await runHandler(r, claim);
    expect(outcome.type).toBe('output');
    expect(r.actions.proposals).toHaveLength(1);
    const { input, ctx } = r.actions.proposals[0];
    const emitting = r.coordinator.modelCalls[1];
    expect(ctx).toMatchObject({
      modelCallId: emitting.record.id,
      toolCallId: 'prop',
      missionId: claim.context.missionId,
      attemptId: claim.context.attemptId,
      role: 'cache_specialist',
    });
    // the digest comes from the reading, not from the model's placeholder
    expect(input).toMatchObject({
      action: 'set_config',
      payload: { key: KEY, value: 1, expectedCurrentValueDigest: digest(4) },
      supportingReceiptIds: [receiptId],
    });
    // the emitting call was recorded before its tool ran, and its snapshot covers the reading
    expect(
      r.coordinator.order.indexOf(`model_call:${emitting.record.id}`),
    ).toBeLessThan(r.coordinator.order.lastIndexOf('read_set') + 99);
    expect(
      emitting.snapshot.dependencyVector.map((e) => e.receiptId),
    ).toContain(receiptId);
    expect(emitting.record.toolCalls[0]).toMatchObject({ toolCallId: 'prop' });
  });

  it('refuses a proposal for a key that was not observed first', async () => {
    const r = configRig([propose(), text('done')]);
    await runHandler(r, claimed('cache_specialist'));
    expect(r.actions.proposals).toHaveLength(0);
    expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body).toMatchObject({
      ok: false,
      error: 'observe_first',
    });
  });

  it('refuses citations outside the scope of the attempt', async () => {
    const r = configRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      propose({ supportingReceiptIds: [digestToUuid('foreign')] }, 'prop'),
      text('done'),
    ]);
    await runHandler(r, claimed('cache_specialist'));
    expect(r.actions.proposals).toHaveLength(0);
    expect(toolResultsOf(r.inference.requests.at(-1)!)[1].body).toMatchObject({
      error: 'citation_out_of_scope',
    });
  });

  it('a specialist without the cache-flush capability cannot flush', async () => {
    const r = configRig([
      calls({
        id: 'fl',
        name: 'propose_action',
        args: {
          action: 'flush_cache_namespace',
          payload: { namespace: 'ns', reason: 'x' },
          supportingReceiptIds: [],
          rationale: 'r',
        },
      }),
      text('done'),
    ]);
    await runHandler(r, claimed('database_specialist'));
    expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body).toMatchObject({
      ok: false,
      error: 'capability_denied',
      capability: 'propose_cache_flush',
    });
    expect(r.actions.proposals).toHaveLength(0);
  });

  it('request_replan needs the capability', async () => {
    const r = configRig([
      calls({
        id: 'rr',
        name: 'request_replan',
        args: { reason: 'plan no longer fits' },
      }),
      calls({ id: 'rr2', name: 'request_replan', args: { reason: 'again' } }),
      text('done'),
    ]);
    await runHandler(r, claimed('verifier'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results[0].body.error).toBe('capability_denied');
    expect(r.coordinator.replans).toEqual([]);

    const ok = configRig([
      calls({
        id: 'rr',
        name: 'request_replan',
        args: { reason: 'plan no longer fits' },
      }),
      text('done'),
    ]);
    await runHandler(ok, claimed('investigator'));
    expect(ok.coordinator.replans).toEqual(['plan no longer fits']);
  });
});

describe('runbooks (I13)', () => {
  it('lists the catalogue and reads by id only', async () => {
    const r = configRig([
      calls({ id: 'l', name: 'list_runbooks', args: {} }),
      calls({ id: 'r', name: 'read_runbook', args: { id: 'acceptance' } }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(
      (results[0].body.runbooks as { id: string }[]).map((x) => x.id),
    ).toContain('cache-semantics');
    expect(String(results[1].body.text)).toContain('Acceptance statement');
  });

  it.each([
    '../x',
    '../../.env',
    '/etc/passwd',
    'acceptance.md',
    'unknown-id',
    'a/b',
  ])('read_runbook(%s) is rejected', async (id) => {
    const r = configRig([
      calls({ id: 'r', name: 'read_runbook', args: { id } }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    const body = toolResultsOf(r.inference.requests.at(-1)!)[0].body;
    expect(body.ok).toBe(false);
    expect(['invalid_arguments', 'unknown_runbook']).toContain(body.error);
  });

  it('unknown tools are refused', async () => {
    const r = configRig([
      calls({ id: 'u', name: 'run_sql', args: { q: 'select 1' } }),
      text('done'),
    ]);
    await runHandler(r, claimed('investigator'));
    expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body.error).toBe(
      'unknown_tool',
    );
  });
});
