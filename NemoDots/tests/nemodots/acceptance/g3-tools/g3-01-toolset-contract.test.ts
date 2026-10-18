// Gate 3, TOOL_COVERAGE section 1: the NemoDots incident toolset contract.
// Public contract types only (src/server/nemodots/contracts). Expected values come from
// TOOL_COVERAGE.md section 1 and TEST_PROMPT gate 3, not from the production schema bodies.
import { describe, expect, it } from 'vitest';
import * as C from '../../../../src/server/nemodots/contracts/index.js';

// TOOL_COVERAGE section 1, transcribed by hand.
const DOCUMENTED_TOOLS = [
  'observe_source',
  'list_runbooks',
  'read_runbook',
  'delegate_task',
  'get_task_status',
  'wait_for_children',
  'publish_finding',
  'propose_action',
  'request_replan',
] as const;

const UUID = '3f2b8c1e-5d4a-4e6b-9a7c-1d2e3f4a5b6c';
const HEX64 = 'a'.repeat(64);

const VALID: Record<(typeof DOCUMENTED_TOOLS)[number], unknown> = {
  observe_source: { sourceKey: 'checkout.health' },
  list_runbooks: {},
  read_runbook: { id: 'cache-recovery' },
  delegate_task: {
    title: 'Verify the repair',
    role: 'verifier',
    question: 'Does a fresh order succeed?',
    dependsOn: [],
    justification: 'Needs an independent read of the checkout.',
  },
  get_task_status: { taskId: UUID },
  wait_for_children: {},
  publish_finding: {
    claim: 'The cache namespace is stale.',
    supportingReceiptIds: [UUID],
    confidence: 'medium',
  },
  propose_action: {
    action: 'set_config',
    payload: {
      key: 'cache.namespace',
      value: 'b',
      expectedCurrentValueDigest: HEX64,
    },
    supportingReceiptIds: [UUID],
    rationale: 'The namespace points at a retired schema.',
  },
  request_replan: { reason: 'The plan no longer fits the evidence.' },
};

// Identity, authority, version and credential fields the model must never be able to supply.
const FORBIDDEN_KEYS = [
  'missionId',
  'taskId_override',
  'attemptId',
  'workspaceId',
  'ownerId',
  'userId',
  'dotId',
  'spaceId',
  'environment',
  'resource',
  'role_override',
  'capabilities',
  'capability',
  'leaseToken',
  'fencingToken',
  'dispatchFence',
  'generation',
  'dependencyVector',
  'expectedTargetVersion',
  'causedByActionId',
  'idempotencyKey',
  'payloadHash',
  'policyVersion',
  'connectionString',
  'databaseUrl',
  'redisUrl',
  'apiKey',
  'authorization',
  'command',
  'sql',
  'url',
  'path',
];

describe('[TP3.4][TP3.3] the incident toolset is closed and contains no shell, browser, file, SQL, Redis or HTTP tool', () => {
  it('[TP3.3] exposes exactly the nine documented tools, in the documented order', () => {
    expect(C.TEAM_TOOL_ORDER).toEqual(DOCUMENTED_TOOLS);
    expect(C.toolSchemas().map((tool) => tool.name)).toEqual(DOCUMENTED_TOOLS);
    expect(Object.keys(C.TEAM_TOOL_INPUTS).sort()).toEqual(
      [...DOCUMENTED_TOOLS].sort(),
    );
  });

  it('[TP3.4] no tool name or description offers shell, browser, file system, HTTP fetch, SQL, Redis, Docker or credentials', () => {
    const banned =
      /\b(shell|bash|sh|exec|execute_command|terminal|browser|navigate|click|screenshot|filesystem|file_write|write_file|read_file|fetch_url|http_request|curl|sql|query_db|psql|redis|docker|container|kubectl|ssh|credential|password|api_key)\b/i;
    for (const tool of C.toolSchemas()) {
      expect(tool.name, tool.name).not.toMatch(banned);
      // descriptions may say "read" but must not advertise banned capabilities
      expect(tool.description, tool.name).not.toMatch(
        /\b(shell|bash|terminal|browser|filesystem|curl|psql|docker|ssh)\b/i,
      );
    }
  });

  it('[TP3.4] no tool parameter (at any depth) is a free-form command, URL, path, connection string or credential field', () => {
    const names: string[] = [];
    const walk = (node: unknown, trail: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${trail}[${i}]`));
        return;
      }
      const record = node as Record<string, unknown>;
      const props = record.properties as Record<string, unknown> | undefined;
      if (props)
        for (const [key, value] of Object.entries(props)) {
          names.push(`${trail}.${key}`);
          walk(value, `${trail}.${key}`);
        }
      for (const [key, value] of Object.entries(record))
        if (key !== 'properties') walk(value, trail);
    };
    for (const tool of C.toolSchemas()) walk(tool.parameters, tool.name);
    const offending = names.filter((name) =>
      /\.(command|cmd|script|sql|query|url|uri|host|port|path|file|filename|connection|connectionString|dsn|password|secret|token|apiKey|credential|env)$/i.test(
        name,
      ),
    );
    expect(offending).toEqual([]);
  });

  it('[TP3.3] lookups outside the closed set resolve to nothing, including names containing "read", "list" or "get" and prototype keys', () => {
    const candidates = [
      'read_file',
      'read_secrets',
      'list_directory',
      'get_env',
      'read_everything',
      'run_shell',
      'exec',
      'computer_exec',
      'search_web',
      'read_public_page',
      'read_space_page',
      'edit_space_page',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'observe_source ',
      'OBSERVE_SOURCE',
      '',
    ];
    for (const name of candidates) {
      expect(
        Object.hasOwn(C.TEAM_TOOL_INPUTS, name),
        JSON.stringify(name),
      ).toBe(false);
      expect(
        (C.TEAM_TOOL_ORDER as readonly string[]).includes(name),
        JSON.stringify(name),
      ).toBe(false);
    }
  });
});

describe('[TP3.2] model-supplied identity and authority grant nothing: every tool input is strict', () => {
  it.each(DOCUMENTED_TOOLS.map((name) => [name] as const))(
    '[TP3.2] %s accepts its documented input and rejects every identity/authority/credential key added to it',
    (name) => {
      const schema = C.TEAM_TOOL_INPUTS[name] as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(schema.safeParse(VALID[name]).success, `${name} baseline`).toBe(
        true,
      );
      for (const key of FORBIDDEN_KEYS) {
        const polluted = { ...(VALID[name] as object), [key]: 'x' };
        expect(
          schema.safeParse(polluted).success,
          `${name} must reject extra key ${key}`,
        ).toBe(false);
      }
    },
  );

  it('[TP3.2] the JSON schema of every tool is closed at the top level (additionalProperties false)', () => {
    for (const tool of C.toolSchemas()) {
      expect(tool.parameters.type, tool.name).toBe('object');
      expect(tool.parameters.additionalProperties, tool.name).toBe(false);
    }
  });

  it('[TP3.2] propose_action rejects unknown ActionKinds, cross-kind payloads and extra payload keys', () => {
    const schema = C.TEAM_TOOL_INPUTS.propose_action as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const base = VALID.propose_action as Record<string, unknown>;
    const payload = base.payload as Record<string, unknown>;
    for (const action of [
      'exec_shell',
      'write_file',
      'set_config ',
      'SET_CONFIG',
      'delete_namespace',
      '',
    ])
      expect(schema.safeParse({ ...base, action }).success, action).toBe(false);
    // flush action carrying a set_config payload, and the reverse
    expect(
      schema.safeParse({ ...base, action: 'flush_cache_namespace' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        action: 'set_config',
        payload: { namespace: 'checkout', reason: 'x' },
      }).success,
    ).toBe(false);
    // extra payload keys (target override, raw SQL, redis command)
    for (const key of ['target', 'sql', 'redisCommand', 'environment'])
      expect(
        schema.safeParse({ ...base, payload: { ...payload, [key]: 'x' } })
          .success,
        key,
      ).toBe(false);
    // config key outside the documented controlled keys
    expect(
      schema.safeParse({
        ...base,
        payload: { ...payload, key: 'redis.password' },
      }).success,
    ).toBe(false);
  });

  it('[TP3.3] observe_source accepts only registered source key shapes, never URLs, paths or SQL', () => {
    const schema = C.TEAM_TOOL_INPUTS.observe_source as {
      safeParse: (v: unknown) => { success: boolean };
    };
    for (const sourceKey of [
      'checkout.health',
      'checkout.config',
      'checkout.config/cache.namespace',
      'redis.stats',
    ])
      expect(schema.safeParse({ sourceKey }).success, sourceKey).toBe(true);
    for (const sourceKey of [
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      '../../.env',
      '/etc/passwd',
      "checkout.health'; DROP TABLE x;--",
      'checkout.config/',
      'checkout.config/../../x',
      'CHECKOUT.HEALTH',
      'postgres://admin@127.0.0.1/db',
      '',
    ])
      expect(schema.safeParse({ sourceKey }).success, sourceKey).toBe(false);
  });
});

describe('[TP3.3] read_runbook resolves catalogue ids only (finding I13)', () => {
  it('[TP3.3] traversal, absolute, encoded, NUL, Windows and oversize ids are rejected by the tool schema', () => {
    const schema = C.TEAM_TOOL_INPUTS.read_runbook as {
      safeParse: (v: unknown) => { success: boolean };
    };
    for (const id of [
      '../secrets',
      '../../.env',
      '..',
      '.',
      '.env',
      'a/b',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '..\\..\\x',
      '%2e%2e%2fsecrets',
      'cache\u0000.md',
      'cache-recovery.md/../../x',
      'CACHE',
      'cache recovery',
      'a'.repeat(65),
      '',
    ])
      expect(schema.safeParse({ id }).success, JSON.stringify(id)).toBe(false);
    expect(schema.safeParse({ id: 'cache-recovery' }).success).toBe(true);
  });
});
