import { describe, expect, it } from 'vitest';
import {
  runPlanner,
  planResponseSchema,
  type PlannerDeps,
} from '../../../src/server/nemodots/team/planner.js';
import { PlanShapeSchema } from '../../../src/server/nemodots/contracts/index.js';
import {
  HEALTH_VALUE,
  ScriptedInference,
  StubCoordinator,
  StubObserver,
  StubReader,
  clock,
  failed,
  makeClaimed,
  makeHelpers,
  newIdFactory,
  result,
  runbooks,
} from './harness.js';

// Planner unit tests: scripted inference + labelled stubs. The prompt, the
// schema, the compiler and the validation are the real code.

const task = (over: object = {}) => ({
  title: 'Inspect health',
  question: 'Establish what the health receipt shows.',
  role: 'investigator',
  capabilities: [],
  dependsOn: [],
  ...over,
});
const plan = (...tasks: object[]) => JSON.stringify({ tasks });
const good = plan(
  task(),
  task({ title: 'Check the cache', role: 'cache_specialist' }),
  task({ title: 'Verify', role: 'verifier', dependsOn: [0, 1] }),
);

function build(
  script: ConstructorParameters<typeof ScriptedInference>[0],
  values: Record<string, unknown> = {
    'checkout.health': HEALTH_VALUE,
    'checkout.config': {
      keys: ['cache.namespace', 'db.pool_max'],
      collectionVersion: 2,
    },
  },
) {
  const coordinator = new StubCoordinator();
  const observer = new StubObserver(values);
  const reader = new StubReader();
  const inference = new ScriptedInference(script);
  const deps: PlannerDeps = {
    inference,
    coordinator,
    reader,
    observer,
    runbooks,
    clock,
    plannerModel: 'p',
    newId: newIdFactory(),
  };
  return { deps, coordinator, observer, inference, reader };
}

describe('planner', () => {
  it('asks for a strict json_schema plan from goal + health + membership only, and returns it for persistence', async () => {
    const { deps, inference, observer, coordinator } = build([
      result({ content: good }),
    ]);
    const outcome = await runPlanner(
      makeClaimed('planner'),
      makeHelpers(),
      deps,
    );
    expect(outcome.type).toBe('plan');
    const planned = outcome as {
      plan: { tasks: unknown[] };
      createdByModelCallId: string;
    };
    expect(planned.plan.tasks).toHaveLength(3);
    expect(planned.createdByModelCallId).toBe(coordinator.records[0].record.id);

    // inputs: exactly the health receipt and the membership receipt
    expect(observer.calls.map((c) => c.sourceKey)).toEqual([
      'checkout.health',
      'checkout.config',
    ]);
    const request = inference.requests[0];
    expect(request.tools).toEqual([]);
    expect(request.reasoningEffort).toBe('none');
    expect(request.responseFormat?.name).toBe('nemodots_plan');
    expect(request.responseFormat?.schema).toEqual(planResponseSchema());
    const system = (request.messages[0] as { content: string }).content;
    expect(system).toContain('Restore checkout.');
    expect(system).toContain('cache.namespace'); // membership: the key list
    expect(system).not.toContain('"key":'); // no member entries or values
    expect(coordinator.records[0].record.role).toBe('planner');
    expect(coordinator.readSets[0]).toHaveLength(2);
  });

  it('the response schema is the contracts PlanShape (2..6 root tasks), nothing extra', () => {
    const schema = planResponseSchema() as {
      properties: { tasks: { minItems: number; maxItems: number } };
    };
    expect(schema.properties.tasks.minItems).toBe(2);
    expect(schema.properties.tasks.maxItems).toBe(6);
    expect(PlanShapeSchema.safeParse(JSON.parse(good)).success).toBe(true);
  });

  it('one bounded correction turn: the issues are shown, the second plan is accepted', async () => {
    const cyclic = plan(
      task({ dependsOn: [1] }),
      task({ title: 'b', dependsOn: [0] }),
    );
    const { deps, inference, coordinator } = build([
      result({ content: cyclic }),
      result({ content: good }),
    ]);
    const outcome = await runPlanner(
      makeClaimed('planner'),
      makeHelpers(),
      deps,
    );
    expect(outcome.type).toBe('plan');
    expect(inference.requests).toHaveLength(2);
    expect(JSON.stringify(inference.requests[1].messages)).toContain('cycle');
    expect(coordinator.records).toHaveLength(2);
  });

  it('two invalid plans fail with invalid_plan; no third call', async () => {
    const escalated = plan(
      task({ capabilities: ['propose_config_change'] }),
      task({ title: 'b' }),
    );
    const { deps, inference } = build([
      result({ content: escalated }),
      result({ content: 'not json' }),
      result({ content: good }),
    ]);
    const outcome = await runPlanner(
      makeClaimed('planner'),
      makeHelpers(),
      deps,
    );
    expect(outcome).toMatchObject({ type: 'failed' });
    expect((outcome as { reason: string }).reason).toMatch(/^invalid_plan/);
    expect(inference.requests).toHaveLength(2);
    expect(JSON.stringify(inference.requests[1].messages)).toContain(
      'exceed ROLE_CAPABILITIES',
    );
  });

  it('a single-task plan violates the 2..6 rule', async () => {
    const { deps } = build([
      result({ content: plan(task()) }),
      result({ content: plan(task()) }),
    ]);
    const outcome = await runPlanner(
      makeClaimed('planner'),
      makeHelpers(),
      deps,
    );
    expect(outcome).toMatchObject({ type: 'failed' });
  });

  it('plans even when a source cannot be read, and says so', async () => {
    const { deps, inference } = build([result({ content: good })], {
      'checkout.config': { keys: [], collectionVersion: 0 },
    });
    const outcome = await runPlanner(
      makeClaimed('planner'),
      makeHelpers(),
      deps,
    );
    expect(outcome.type).toBe('plan');
    expect(JSON.stringify(inference.requests[0].messages[0])).toContain(
      'could not be read right now: checkout.health',
    );
  });

  it('a replan sees the existing task states and is recorded with the replan role', async () => {
    const { deps, inference, coordinator, reader } = build([
      result({ content: good }),
    ]);
    reader.options.overview = [
      {
        id: '44444444-4444-4444-8444-444444444444' as never,
        parentId: null,
        depth: 0,
        title: 'Finished branch',
        role: 'investigator',
        status: 'succeeded',
        outputUsable: true,
        attemptCount: 1,
      },
    ];
    const outcome = await runPlanner(
      makeClaimed('planner', { kind: 'replan' }),
      makeHelpers(),
      deps,
    );
    expect(outcome.type).toBe('plan');
    expect(JSON.stringify(inference.requests[0].messages[0])).toContain(
      'Finished branch',
    );
    expect(coordinator.records[0].record.role).toBe('replan');
  });

  it('provider failures are explicit, not silent', async () => {
    const limited = build([failed('rate_limited')]);
    expect(
      await runPlanner(makeClaimed('planner'), makeHelpers(), limited.deps),
    ).toEqual({
      type: 'failed',
      reason: 'inference_rate_limited',
    });
    const down = build([failed('provider_unavailable')]);
    expect(
      await runPlanner(makeClaimed('planner'), makeHelpers(), down.deps),
    ).toEqual({
      type: 'abort',
      reason: 'provider_unreachable',
    });
  });
});
