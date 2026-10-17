import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import { D, ids } from './fixtures.js';

const NINE = [
  'observe_source',
  'list_runbooks',
  'read_runbook',
  'delegate_task',
  'get_task_status',
  'wait_for_children',
  'publish_finding',
  'propose_action',
  'request_replan',
];

describe('toolSchemas()', () => {
  it('lists the nine team tools in a fixed order', () => {
    expect(C.toolSchemas().map((tool) => tool.name)).toEqual(NINE);
  });

  it('digest is stable across calls and independent instances', () => {
    const a = C.digest(C.toolSchemas());
    const b = C.digest(C.toolSchemas());
    expect(a).toBe(b);
    expect(C.toolSchemaHash()).toBe(a);
    expect(C.toolSchemaHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(C.canonicalJson(C.toolSchemas())).toBe(
      C.canonicalJson(C.toolSchemas()),
    );
  });

  it('mutating a returned schema does not affect later calls', () => {
    const first = C.toolSchemas();
    (first[0].parameters as Record<string, unknown>).injected = true;
    expect(C.toolSchemaHash()).toBe(C.digest(C.toolSchemas()));
    expect(C.toolSchemas()[0].parameters).not.toHaveProperty('injected');
  });

  it('every tool takes a closed top-level object schema without $schema', () => {
    for (const tool of C.toolSchemas()) {
      expect(tool.parameters.type, tool.name).toBe('object');
      expect(tool.parameters.additionalProperties, tool.name).toBe(false);
      expect(tool.parameters).not.toHaveProperty('$schema');
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('no tool accepts identity or authority fields from the model', () => {
    const text = C.canonicalJson(C.toolSchemas());
    for (const field of [
      'missionId',
      'attemptId',
      'fencingToken',
      'causedByActionId',
      'dependencyVector',
      'expectedTargetVersion',
      'capabilities',
    ])
      expect(text).not.toContain(`"${field}"`);
  });
});

describe('team tool inputs', () => {
  const T = C.TEAM_TOOL_INPUTS;

  it('observe_source accepts registered keys only', () => {
    expect(
      T.observe_source.safeParse({ sourceKey: 'redis.stats' }).success,
    ).toBe(true);
    expect(
      T.observe_source.safeParse({ sourceKey: '/etc/passwd' }).success,
    ).toBe(false);
  });

  it('read_runbook ids cannot traverse paths', () => {
    expect(T.read_runbook.safeParse({ id: 'cache-recovery' }).success).toBe(
      true,
    );
    for (const id of ['../secrets', 'a/b', '.env', 'A'])
      expect(T.read_runbook.safeParse({ id }).success).toBe(false);
  });

  it('delegate_task cannot create planner or postcondition tasks', () => {
    const base = {
      title: 'Check cache',
      role: 'cache_specialist',
      question: 'Is the namespace stale?',
      dependsOn: [],
      justification: 'investigator cannot propose',
    };
    expect(T.delegate_task.safeParse(base).success).toBe(true);
    expect(
      T.delegate_task.safeParse({ ...base, role: 'planner' }).success,
    ).toBe(false);
    expect(
      T.delegate_task.safeParse({ ...base, role: 'postcondition' }).success,
    ).toBe(false);
    expect(
      T.delegate_task.safeParse({ ...base, justification: undefined }).success,
    ).toBe(false);
    expect(
      T.delegate_task.safeParse({ ...base, capabilities: ['observe'] }).success,
    ).toBe(false);
  });

  it('propose_action parses into the discriminated ProposeInput', () => {
    const ok = {
      action: 'set_config',
      payload: { key: 'db.pool_max', value: 10, expectedCurrentValueDigest: D },
      supportingReceiptIds: [ids.receipt],
      rationale: 'pool starvation',
    };
    const parsed = T.propose_action.parse(ok);
    expect(C.ProposeInputSchema.safeParse(parsed).success).toBe(true);
    expect(
      T.propose_action.safeParse({ ...ok, action: 'flush_cache_namespace' })
        .success,
    ).toBe(false);
    expect(
      T.propose_action.safeParse({ ...ok, idempotencyKey: D }).success,
    ).toBe(false);
    expect(
      T.propose_action.safeParse({
        ...ok,
        supportingReceiptIds: ['not-a-uuid'],
      }).success,
    ).toBe(false);
  });

  it('publish_finding requires a bounded claim and confidence', () => {
    const ok = {
      claim: 'stale namespace',
      supportingReceiptIds: [ids.receipt],
      confidence: 'low',
    };
    expect(T.publish_finding.safeParse(ok).success).toBe(true);
    expect(
      T.publish_finding.safeParse({ ...ok, claim: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(T.publish_finding.safeParse({ ...ok, trust: 'probe' }).success).toBe(
      false,
    );
  });

  it('no-argument tools accept only {}', () => {
    expect(T.list_runbooks.safeParse({}).success).toBe(true);
    expect(T.wait_for_children.safeParse({ taskId: ids.task }).success).toBe(
      false,
    );
  });
});
