// Tool policy: capability checks, scope checks, identity and provenance of
// propose_action, runbook catalogue. Scripted model policies (labelled doubles).
import { describe, expect, it } from 'vitest';
import {
  allowedCapabilities,
  digest,
} from '../../../src/server/nemodots/contracts/index.js';
import { precheckDelegation } from '../../../src/server/nemodots/team/index.js';
import {
  calls,
  claimed,
  digestToUuid,
  noDefect,
  rig,
  runHandler,
  StubObserver,
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
    // child capabilities: role defaults within the parent's, plus the rev3 D5
    // grant of propose_* to a specialist delegated by a parent holding delegate
    const granted = precheckDelegation(
      { role: 'investigator', capabilities: ['delegate', 'observe'] as never },
      'cache_specialist',
      'because',
    );
    expect(granted).toMatchObject({
      ok: true,
      childCapabilities: [
        'observe',
        'delegate',
        'propose_config_change',
        'propose_cache_flush',
      ],
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
    await runHandler(r, claimed('cache_specialist'));
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
    await runHandler(r, claimed('cache_specialist'));
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
    await runHandler(r, claimed('cache_specialist'));
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
    await runHandler(r, claimed('cache_specialist'));
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
      noDefect(),
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
    await runHandler(r, claimed('cache_specialist'));
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
    await runHandler(r, claimed('cache_specialist'));
    const body = toolResultsOf(r.inference.requests.at(-1)!)[0].body;
    expect(body.ok).toBe(false);
    expect(['invalid_arguments', 'unknown_runbook']).toContain(body.error);
  });

  it('unknown tools are refused', async () => {
    const r = configRig([
      calls({ id: 'u', name: 'run_sql', args: { q: 'select 1' } }),
      text('done'),
    ]);
    await runHandler(r, claimed('cache_specialist'));
    expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body.error).toBe(
      'unknown_tool',
    );
  });
});

describe('rev3 D5: the investigator → specialist → propose path', () => {
  const investigatorCaps = [
    'observe',
    'delegate',
    'publish_finding',
    'request_replan',
  ] as const;

  it('capability grants: only a specialist delegated by a parent holding delegate gets propose_*', () => {
    const propose = ['propose_config_change', 'propose_cache_flush'];
    const grants = (
      role: Parameters<typeof allowedCapabilities>[0],
      parent: Parameters<typeof allowedCapabilities>[1],
    ) => allowedCapabilities(role, parent).filter((c) => propose.includes(c));
    expect(grants('cache_specialist', [...investigatorCaps])).toEqual(propose);
    expect(grants('database_specialist', [...investigatorCaps])).toEqual([
      'propose_config_change',
    ]);
    // a parent without delegate grants nothing
    expect(grants('cache_specialist', ['observe', 'publish_finding'])).toEqual(
      [],
    );
    // verifiers and investigators never get propose caps, whoever the parent is
    expect(grants('verifier', [...investigatorCaps])).toEqual([]);
    expect(grants('investigator', [...investigatorCaps])).toEqual([]);
    // an investigator cannot propose itself
    expect(allowedCapabilities('investigator', null)).not.toContain(
      'propose_config_change',
    );
  });

  it('a specialist delegated by an investigator proposes through the action port; the investigator itself is refused', async () => {
    const receiptId = digestToUuid(`${SOURCE}:1:${JSON.stringify(config)}`);
    const delegated = configRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      propose({ supportingReceiptIds: [receiptId] }, 'p'),
      text('proposed'),
    ]);
    // capabilities exactly as the coordinator computes them for the child
    const childCaps = allowedCapabilities('cache_specialist', [
      ...([
        'observe',
        'delegate',
        'publish_finding',
        'request_replan',
      ] as const),
    ]);
    const outcome = await runHandler(
      delegated,
      claimed('cache_specialist', { capabilities: childCaps }),
    );
    expect(outcome.type).toBe('output');
    expect(delegated.actions.proposals).toHaveLength(1);
    expect(delegated.actions.proposals[0].ctx).toMatchObject({
      role: 'cache_specialist',
      toolCallId: 'p',
    });

    const parent = configRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      propose({ supportingReceiptIds: [receiptId] }, 'p'),
      text('cannot'),
      noDefect(),
    ]);
    await runHandler(parent, claimed('investigator'));
    expect(parent.actions.proposals).toHaveLength(0);
  });
});

describe('name-keyed lookups are own-property only (TP-21)', () => {
  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'valueOf',
    'isPrototypeOf',
  ])(
    'the tool name %s is answered with unknown_tool and the attempt continues',
    async (name) => {
      const r = configRig([calls({ id: 'x', name, args: {} }), text('done')]);
      const outcome = await runHandler(r, claimed('cache_specialist'));
      expect(outcome.type).toBe('output');
      expect(toolResultsOf(r.inference.requests.at(-1)!)[0].body).toMatchObject(
        {
          ok: false,
          error: 'unknown_tool',
        },
      );
    },
  );

  it('read_runbook and get_task_status with prototype-key ids are refused, not crashed on', async () => {
    const r = configRig([
      calls({ id: 'a', name: 'read_runbook', args: { id: 'constructor' } }),
      calls({
        id: 'b',
        name: 'get_task_status',
        args: { taskId: '__proto__' },
      }),
      text('done'),
    ]);
    await runHandler(r, claimed('cache_specialist'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    expect(results[0].body.ok).toBe(false);
    expect(results[1].body.ok).toBe(false);
  });
});

describe('observe_source on a family with no reader (TP-68)', () => {
  const unsupported = (family: string) =>
    Object.assign(new Error(`source ${family} is not served`), {
      name: 'UnsupportedSourceError',
    });

  it.each([
    ['opendots.page/abc', 'opendots.page/{pageId}'],
    ['opendots.memory/m1', 'opendots.memory/{memoryId}'],
    ['runbook/acceptance', 'runbook/{id}'],
    ['checkout.acceptance', 'checkout.acceptance'],
  ])(
    '%s returns source_unavailable naming the family and the attempt continues',
    async (sourceKey, family) => {
      const r = configRig([
        calls({ id: 'u', name: 'observe_source', args: { sourceKey } }),
        calls({
          id: 'ok',
          name: 'observe_source',
          args: { sourceKey: 'checkout.health' },
        }),
        text('carried on'),
      ]);
      r.observer.observe = async (_context, input) => {
        if (input.sourceKey === sourceKey) throw unsupported(sourceKey);
        return StubObserver.prototype.observe.call(r.observer, _context, input);
      };
      const outcome = await runHandler(r, claimed('cache_specialist'));
      expect(outcome).toMatchObject({
        type: 'output',
        output: { content: { summary: 'carried on' } },
      });
      const results = toolResultsOf(r.inference.requests.at(-1)!);
      expect(results[0].body).toMatchObject({
        ok: false,
        error: 'source_unavailable',
        family,
      });
      expect(String(results[0].body.message)).toContain(family);
      expect(results[1].body.ok).toBe(true);
      // nothing was added to the read set for the refused key
      expect(r.coordinator.readSets).toHaveLength(1);
    },
  );

  it('other observer failures still propagate to the host (fence, support, database)', async () => {
    const r = configRig([
      calls({
        id: 'u',
        name: 'observe_source',
        args: { sourceKey: 'checkout.health' },
      }),
      text('never'),
    ]);
    r.observer.observe = async () => {
      throw Object.assign(new Error('boom'), { name: 'FenceError' });
    };
    await expect(
      runHandler(r, claimed('cache_specialist')),
    ).rejects.toMatchObject({ name: 'FenceError' });
  });
});
