// W5.3: the typed team tools attacked at the dispatcher, with every port a
// labelled stub that throws if it is touched. Whatever the model sends, a
// rejected call must be rejected BEFORE any port (ledger, coordinator, action
// service) is reached. The DB-backed counterpart, which checks what the real
// ledger and coordinator did, is db/team-tools.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ROLE_CAPABILITIES,
  type AttemptContext,
  type Capability,
  type TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRunbookLibrary } from '../../../../src/server/nemodots/team/catalogue.js';
import { createTeamTools } from '../../../../src/server/nemodots/team/tools.js';
import { ToolError } from '../../../../src/server/nemodots/team/errors.js';
import { UnknownRunbookError } from '../../../../src/server/nemodots/context/runbooks.js';

function untouched<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return (..._args: unknown[]) => {
        throw new Error(`${label}.${String(property)} must not be reached`);
      };
    },
  });
}

function toolsWithStubs() {
  const reader = untouched<never>('reader');
  const coordinator = untouched<never>('coordinator');
  const actions = untouched<never>('actions');
  const observer = untouched<never>('observer');
  return createTeamTools({ reader, coordinator, actions, observer });
}

const context = (
  role: TaskRole,
  capabilities?: Capability[],
): AttemptContext => ({
  missionId: randomUUID() as never,
  taskId: randomUUID() as never,
  attemptId: randomUUID() as never,
  fencingToken: 1,
  generation: 0,
  capabilities: (capabilities ?? [...ROLE_CAPABILITIES[role]]) as never,
  role,
});

const call = (
  name: string,
  args: unknown,
  ctx: AttemptContext = context('investigator'),
) =>
  toolsWithStubs().execute(name, args, {
    context: ctx,
    toolCallId: 'tc-1',
    modelCallId: randomUUID(),
  });

describe('unregistered tool names', () => {
  it.each([
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'prototype',
    'run_sql',
    'shell',
    'OBSERVE_SOURCE',
    'observe_source ',
    ' observe_source',
    'observe_source\u0000',
    'observe-source',
    'composio',
    'copilotkit_load_skill',
    'edit_space_page',
    '',
  ])('%j is unknown_tool and reaches no port', async (name) => {
    await expect(call(name, {})).rejects.toMatchObject({
      code: 'unknown_tool',
    });
  });
});

describe('argument shapes', () => {
  it('invalid JSON text, arrays, null and primitives are invalid_json or invalid_arguments, never executed', async () => {
    await expect(call('observe_source', '{not json')).rejects.toMatchObject({
      code: 'invalid_json',
    });
    for (const args of [null, [], 'x', 7, true, undefined])
      await expect(call('observe_source', args)).rejects.toBeInstanceOf(
        ToolError,
      );
    await expect(
      call('observe_source', '{"sourceKey":"checkout.health","__proto__":{"a":1}}'),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('model-supplied identity, fence and provenance fields are rejected for every tool', async () => {
    const forged = {
      missionId: randomUUID(),
      attemptId: randomUUID(),
      fencingToken: 99,
      capabilities: ['propose_config_change'],
      causedByActionId: randomUUID(),
      dependencyVector: [],
    };
    const base: Record<string, unknown> = {
      observe_source: { sourceKey: 'checkout.health' },
      list_runbooks: {},
      read_runbook: { id: 'acceptance' },
      get_task_status: { taskId: randomUUID() },
      wait_for_children: {},
      publish_finding: {
        claim: 'x',
        supportingReceiptIds: [],
        confidence: 'low',
      },
      request_replan: { reason: 'r' },
    };
    for (const [name, args] of Object.entries(base))
      for (const [key, value] of Object.entries(forged))
        await expect(
          call(name, { ...(args as object), [key]: value }),
          `${name} + ${key}`,
        ).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('a source key outside the registry is rejected at the schema', async () => {
    for (const sourceKey of [
      'checkout.secrets',
      'control.fault_schedules',
      'control.scenario_runs',
      'checkout.config/../../etc/passwd',
      'checkout.config/',
      'checkout.config/UPPER',
      'checkout.config/a b',
      'checkout.config/db.pool_max/extra',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'postgres://admin@127.0.0.1/nemodots',
      'redis://127.0.0.1:6379',
      'redis.keys *',
      "checkout.health'; DROP TABLE ledger.sources; --",
      '',
    ])
      await expect(
        call('observe_source', { sourceKey }),
        JSON.stringify(sourceKey),
      ).rejects.toMatchObject({ code: 'invalid_arguments' });
  });
});

describe('capabilities come from the attempt context, not from the call', () => {
  it('an investigator cannot propose, whatever it sends (D5); the action service is not reached', async () => {
    await expect(
      call('propose_action', {
        action: 'set_config',
        payload: {
          key: 'db.pool_max',
          value: 8,
          expectedCurrentValueDigest: '0'.repeat(64),
        },
        supportingReceiptIds: [],
        rationale: 'raise it',
      }),
    ).rejects.toMatchObject({ code: 'capability_denied' });
  });

  it('a forged context (investigator holding a propose capability) is rejected before any tool runs', async () => {
    const forged = context('investigator', [
      'observe',
      'propose_config_change',
    ]);
    await expect(
      call('list_runbooks', {}, forged),
    ).rejects.toThrow();
    await expect(
      call(
        'propose_action',
        {
          action: 'set_config',
          payload: {
            key: 'db.pool_max',
            value: 8,
            expectedCurrentValueDigest: '0'.repeat(64),
          },
          supportingReceiptIds: [],
          rationale: 'raise it',
        },
        forged,
      ),
    ).rejects.toThrow();
  });

  it('a database specialist cannot propose a cache flush, nor a cache-less role a flush through set_config', async () => {
    await expect(
      call(
        'propose_action',
        {
          action: 'flush_cache_namespace',
          payload: { namespace: 'catalog-a', reason: 'stale' },
          supportingReceiptIds: [],
          rationale: 'flush',
        },
        context('database_specialist'),
      ),
    ).rejects.toMatchObject({ code: 'capability_denied' });
  });

  it('a verifier and a planner hold no mutating tool', async () => {
    for (const role of ['verifier', 'planner'] as const) {
      for (const [name, args] of [
        [
          'publish_finding',
          { claim: 'x', supportingReceiptIds: [], confidence: 'low' },
        ],
        ['request_replan', { reason: 'r' }],
        [
          'delegate_task',
          {
            title: 't',
            role: 'verifier',
            question: 'q',
            dependsOn: [],
            justification: 'because',
          },
        ],
      ] as const) {
        const caps = ROLE_CAPABILITIES[role] as readonly string[];
        const needs =
          name === 'publish_finding'
            ? 'publish_finding'
            : name === 'request_replan'
              ? 'request_replan'
              : 'delegate';
        if (caps.includes(needs)) continue;
        await expect(
          call(name, args, context(role)),
          `${role} ${name}`,
        ).rejects.toMatchObject({ code: 'capability_denied' });
      }
    }
  });
});

describe('read_runbook resolves through the catalogue map only (I13)', () => {
  const library = createRunbookLibrary();

  it('the catalogue lists exactly its entries and reads each one', () => {
    const ids = library.list().map((entry) => entry.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(library.read(id).text.length).toBeGreaterThan(20);
  });

  it('traversal, aliases, prototype keys and encodings are UnknownRunbookError at the library, not just at the schema', () => {
    for (const id of [
      '../x',
      '..',
      '../../package.json',
      '/etc/passwd',
      'checkout-architecture/../acceptance',
      './acceptance',
      'acceptance.md',
      'acceptance/',
      'acceptance\u0000',
      'acceptance\n',
      ' acceptance',
      'ACCEPTANCE',
      '%2e%2e%2facceptance',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '',
      7,
      null,
      undefined,
      { toString: () => 'acceptance' },
      ['acceptance'],
    ])
      expect(() => library.read(id), JSON.stringify(id)).toThrow(
        UnknownRunbookError,
      );
  });

  it('through the tool, an id matching the schema but not the catalogue is unknown_runbook; one failing the schema is invalid_arguments', async () => {
    const tools = createTeamTools({
      reader: untouched<never>('reader'),
      coordinator: untouched<never>('coordinator'),
      actions: untouched<never>('actions'),
      observer: untouched<never>('observer'),
    });
    const options = { context: context('investigator'), toolCallId: 'tc' };
    await expect(
      tools.execute('read_runbook', { id: 'constructor' }, options),
    ).rejects.toMatchObject({ code: 'unknown_runbook' });
    await expect(
      tools.execute('read_runbook', { id: 'no-such-runbook' }, options),
    ).rejects.toMatchObject({ code: 'unknown_runbook' });
    await expect(
      tools.execute('read_runbook', { id: '../acceptance' }, options),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
    const ok = (await tools.execute(
      'read_runbook',
      { id: 'acceptance' },
      options,
    )) as { id: string; text: string };
    expect(ok.id).toBe('acceptance');
    // The runbook text is served as data; the texts do not contain secrets.
    const all = library.all().map((r) => r.text).join('\n');
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres:\/\/|redis:\/\//);
    void vi;
  });
});
