// Planner: strict plan via the InferencePort, one correction turn, nothing
// scripted by the product. The scripted adapter is a deterministic policy
// double (labelled in harness.ts), not a recorded model answer.
import { describe, expect, it } from 'vitest';
import {
  PLAN_RESPONSE_FORMAT,
  REPLAN_RESPONSE_FORMAT,
} from '../../../src/server/nemodots/team/index.js';
import {
  claimed,
  digestToUuid,
  rig,
  runHandler,
  text,
  uuid,
} from './harness.js';

const validPlan = {
  tasks: [
    {
      title: 'Check cache path',
      question: 'Is the product cache returning usable entries?',
      role: 'investigator',
      capabilities: ['observe', 'delegate', 'publish_finding'],
      dependsOn: [],
    },
    {
      title: 'Check inventory path',
      question: 'Do stock readings agree with the authority?',
      role: 'investigator',
      capabilities: ['observe', 'delegate', 'publish_finding'],
      dependsOn: [],
    },
  ],
};

function seeded(steps: Parameters<typeof rig>[0]) {
  const r = rig(steps);
  r.observer.values.set('checkout.health', { status: 'degraded' });
  r.observer.values.set('checkout.config', {
    keys: ['a'],
    collectionVersion: 1,
  });
  return r;
}

describe('planner', () => {
  it('returns the model plan, compiled and recorded, with the two readings as evidence and no tools', async () => {
    const r = seeded([text(JSON.stringify(validPlan))]);
    const outcome = await runHandler(r, claimed('planner'));
    expect(outcome).toMatchObject({ type: 'plan' });
    if (outcome.type !== 'plan') throw new Error('unreachable');
    expect(outcome.plan).toEqual(validPlan);
    // the plan carries the id of the call that produced it
    expect(outcome.createdByModelCallId).toBe(
      r.coordinator.modelCalls[0].record.id,
    );

    // inputs: goal + health + membership, read through the observer
    expect(r.observer.calls.map((c) => c.sourceKey)).toEqual([
      'checkout.health',
      'checkout.config',
    ]);
    const request = r.inference.requests[0];
    expect(request.tools).toEqual([]);
    expect(request.toolSchemaHash).toBeNull();
    expect(request.reasoningEffort).toBe('none');
    expect(request.responseFormat).toEqual(PLAN_RESPONSE_FORMAT);
    expect(request.stream).toBe(false);
    const system = request.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Restore checkout availability');
    expect(system.content).toContain('checkout.health');
    expect(system.content).toContain('checkout.config');

    // compiled and recorded
    const [{ record, snapshot }] = r.coordinator.modelCalls;
    expect(record.role).toBe('planner');
    expect(record.model.requested).toBe('nvidia/test-model');
    expect(record.provider).toEqual({
      host: 'inference.test',
      mode: 'fixture',
    });
    expect(record.contextSnapshotId).toBe(snapshot.id);
    expect(snapshot.injected.receipts).toHaveLength(2);
    expect(snapshot.injected.runbooks.length).toBeGreaterThan(0);
  });

  it('the strict schema offered to the model is the shared plan shape', () => {
    expect(PLAN_RESPONSE_FORMAT.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(JSON.stringify(PLAN_RESPONSE_FORMAT.schema)).toContain('dependsOn');
    expect(REPLAN_RESPONSE_FORMAT.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(JSON.stringify(REPLAN_RESPONSE_FORMAT.schema)).toContain(
      'cancelTaskIds',
    );
  });

  it('one correction turn: a cyclic plan is rejected with the reason shown to the model, the second answer is used', async () => {
    const cyclic = {
      tasks: [
        { ...validPlan.tasks[0], dependsOn: [1] },
        { ...validPlan.tasks[1], dependsOn: [0] },
      ],
    };
    const r = seeded([
      text(JSON.stringify(cyclic)),
      text(JSON.stringify(validPlan)),
    ]);
    const outcome = await runHandler(r, claimed('planner'));
    expect(outcome.type).toBe('plan');
    expect(r.inference.requests).toHaveLength(2);
    const correction = r.inference.requests[1].messages.at(-1)!;
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('cycle');
    // both calls are recorded; the plan references the second
    expect(r.coordinator.modelCalls).toHaveLength(2);
    if (outcome.type === 'plan')
      expect(outcome.createdByModelCallId).toBe(
        r.coordinator.modelCalls[1].record.id,
      );
    // the correction turn is still compiled: same prefix, new context digest
    const [first, second] = r.coordinator.modelCalls.map((c) => c.snapshot);
    expect(second.prefixDigest).toBe(first.prefixDigest);
    expect(second.contextDigest).not.toBe(first.contextDigest);
  });

  it.each([
    [
      'capability escalation',
      {
        tasks: [
          {
            ...validPlan.tasks[0],
            capabilities: ['observe', 'propose_config_change'],
          },
          validPlan.tasks[1],
        ],
      },
    ],
    ['too few tasks', { tasks: [validPlan.tasks[0]] }],
    ['not JSON', 'not json at all'],
    ['unknown key', { tasks: validPlan.tasks, extra: 1 }],
  ])(
    'two rejected plans (%s) fail the attempt with invalid_output',
    async (_label, bad) => {
      const body = typeof bad === 'string' ? bad : JSON.stringify(bad);
      const r = seeded([text(body), text(body)]);
      expect(await runHandler(r, claimed('planner'))).toEqual({
        type: 'failed',
        reason: 'invalid_output',
      });
      expect(r.inference.requests).toHaveLength(2);
    },
  );

  it('an investigator plan task asking for propose_config_change is rejected (D5)', async () => {
    const escalated = {
      tasks: [
        {
          ...validPlan.tasks[0],
          capabilities: ['observe', 'propose_config_change'],
        },
        validPlan.tasks[1],
      ],
    };
    const r = seeded([
      text(JSON.stringify(escalated)),
      text(JSON.stringify(validPlan)),
    ]);
    const outcome = await runHandler(r, claimed('planner'));
    expect(outcome.type).toBe('plan');
    expect(r.inference.requests[1].messages.at(-1)!.content).toContain(
      'capabilities exceed',
    );
  });

  it('a plan whose task cannot observe is corrected once (capability semantics)', async () => {
    const blind = {
      tasks: [
        { ...validPlan.tasks[0], capabilities: ['delegate'] },
        validPlan.tasks[1],
      ],
    };
    const r = seeded([
      text(JSON.stringify(blind)),
      text(JSON.stringify(validPlan)),
    ]);
    const outcome = await runHandler(r, claimed('planner'));
    expect(outcome.type).toBe('plan');
    expect(r.inference.requests[1].messages.at(-1)!.content).toContain(
      'must include observe',
    );
  });

  it('an investigator task without delegate is corrected once', async () => {
    const noDelegate = {
      tasks: [
        { ...validPlan.tasks[0], capabilities: ['observe', 'publish_finding'] },
        validPlan.tasks[1],
      ],
    };
    const r = seeded([
      text(JSON.stringify(noDelegate)),
      text(JSON.stringify(validPlan)),
    ]);
    expect((await runHandler(r, claimed('planner'))).type).toBe('plan');
    expect(r.inference.requests[1].messages.at(-1)!.content).toContain(
      'must include delegate',
    );
  });

  it('replan: cancel ids must name unfinished tasks; the invalidation summary is shown', async () => {
    const live = uuid();
    const done = uuid();
    const r = seeded([
      text(
        JSON.stringify({
          ...validPlan,
          cancelTaskIds: [digestToUuid('x'), done],
        }),
      ),
      text(JSON.stringify({ ...validPlan, cancelTaskIds: [live] })),
    ]);
    r.reads.tasks = [
      {
        id: live as never,
        title: 'old branch',
        role: 'investigator',
        status: 'running',
        parentId: null,
      },
      {
        id: done as never,
        title: 'finished',
        role: 'investigator',
        status: 'succeeded',
        parentId: null,
      },
    ];
    r.reads.summaries = [
      { id: 'e'.repeat(64), summary: 'config key changed to a newer version' },
    ];
    const outcome = await runHandler(
      r,
      claimed('planner', {
        kind: 'replan',
        repairOf: { attemptId: uuid(), invalidationEventId: 'e'.repeat(64) },
      }),
    );
    expect(outcome).toMatchObject({ type: 'plan', cancelTaskIds: [live] });
    expect(r.inference.requests[0].responseFormat).toEqual(
      REPLAN_RESPONSE_FORMAT,
    );
    expect(r.inference.requests[0].messages[0].content).toContain(
      'config key changed to a newer version',
    );
    expect(r.inference.requests[0].messages[0].content).toContain(live);
    expect(r.coordinator.modelCalls.map((c) => c.record.role)).toEqual([
      'replan',
      'replan',
    ]);
    expect(r.inference.requests[1].messages.at(-1)!.content).toContain(
      'cannot be cancelled',
    );
  });
});
