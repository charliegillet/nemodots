// TEST_PROMPT gate 5 case 6: "Stable prefix/tool-schema digests within
// compatible groups; changing evidence in dynamic context; missing cached
// tokens = unavailable."
//
// Expected values are derived from the contract rules, not from production
// logic: the prefix digest must be the SHA-256 of the leading prefixLength
// characters of the system string actually sent; evidence and the clock must
// sit after that boundary; cachedTokens is null unless the provider returned a
// number, and 0 only if the provider returned 0.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  digest,
  toolSchemaHash,
  toolSchemas,
  type ChatMessage,
  type ChatRequest,
  type ContextSnapshotId,
  type ReceiptId,
  type SourceKey,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  chat,
  completeThroughSaturation,
  createAdapter,
  ctx,
  loadModule,
  requireLive,
  startProxy,
  type Adapter,
  type LiveEnv,
} from './support.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const NOW_A = '2026-10-17T18:00:00.000Z';
const NOW_B = '2026-10-17T18:07:30.000Z';

type Compile = (input: Record<string, unknown>) => {
  system: string;
  messages: {
    role: string;
    content: string;
    toolCalls?: { id: string; name: string; arguments: string }[];
    toolCallId?: string;
  }[];
  tools: unknown[];
  snapshot: {
    prefixDigest: string;
    prefixLength: number;
    contextDigest: string;
    toolSchemaHash: string;
    layout: string;
    volatile: { nowIso: string };
  };
};

let compileContext: Compile;
let live: LiveEnv;
let adapter: Adapter;

beforeAll(async () => {
  live = requireLive();
  adapter = await createAdapter();
  const mod = await loadModule<{ compileContext?: Compile }>(
    'src/server/nemodots/context/index.ts',
  );
  if (!mod.compileContext)
    throw new Error('ENTRY POINT MISSING: context/index.ts#compileContext');
  compileContext = mod.compileContext;
});

const receipt = (n: number, key: string, revision: number, value: unknown) => ({
  id: `a5c0de00-0000-4000-8000-0000000000${String(n).padStart(2, '0')}` as ReceiptId,
  source: { key: key as SourceKey },
  sourceRevision: revision,
  collectionRevision: null,
  observedAt: NOW_A,
  lastConfirmedAt: NOW_A,
  contentDigest: digest(value),
  normalizedValue: value,
  status: 'supported',
  trust: 'controlled_authority',
  negative: null,
});

function input(over: Record<string, unknown> = {}) {
  return {
    snapshotId: randomUUID() as ContextSnapshotId,
    layout: 'cache_aware',
    nowIso: NOW_A,
    commonInstructions:
      'You are a member of an incident response team. Answer from the evidence only. Do NOT call any tool for this task: the evidence below is complete, answer in plain text.',
    roleInstructions:
      'Role: investigator. Report exactly what the evidence says.',
    task: {
      title: 'Read the cache namespace',
      question:
        'State the value of cache.namespace from the Evidence section, in the form NS=<value>. Reply with that only, in plain text, without calling any tool.',
    },
    runbooks: [
      { id: 'cache', title: 'Cache semantics', text: 'Namespaces scope keys.' },
    ],
    receipts: [
      receipt(1, 'checkout.config/cache.namespace', 3, {
        key: 'cache.namespace',
        value: 'zebra',
        version: 3,
      }),
    ],
    inheritedArtifacts: [],
    pageSnapshots: [],
    memories: [],
    invalidations: [],
    history: [],
    ...over,
  };
}

function toRequest(
  compiled: ReturnType<Compile>,
  over: Partial<ChatRequest> = {},
): ChatRequest {
  const messages: ChatMessage[] = [
    { role: 'system', content: compiled.system },
  ];
  for (const m of compiled.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant')
      messages.push({
        role: 'assistant',
        content: m.content,
        toolCalls: (m.toolCalls ?? []).map((c) => ({
          toolCallId: c.id,
          name: c.name,
          arguments: c.arguments,
        })),
      });
    else
      messages.push({
        role: 'tool',
        toolCallId: m.toolCallId!,
        content: m.content,
      });
  }
  return {
    model: live.model,
    messages,
    tools: compiled.tools as ChatRequest['tools'],
    toolSchemaHash: compiled.snapshot.toolSchemaHash,
    maxTokens: 64,
    reasoningEffort: 'none',
    responseFormat: null,
    stream: false,
    ...over,
  };
}

describe('G5.6a prefix and tool-schema digests (deterministic compile)', () => {
  it('prefixDigest == sha256 of the leading prefixLength chars of the system string; toolSchemaHash == digest of the contract tool schemas', () => {
    const c = compileContext(input());
    const prefix = c.system.slice(0, c.snapshot.prefixLength);
    expect(sha(prefix)).toBe(c.snapshot.prefixDigest);
    expect(c.snapshot.toolSchemaHash).toBe(toolSchemaHash());
    expect(c.snapshot.toolSchemaHash).toBe(digest(toolSchemas()));
    expect(c.tools).toEqual(toolSchemas());
  });

  it('compatible calls (same role/tools/runbooks) with CHANGED evidence and a later clock keep prefixDigest and toolSchemaHash; contextDigest changes', () => {
    const a = compileContext(input());
    const b = compileContext(
      input({
        nowIso: NOW_B,
        receipts: [
          receipt(1, 'checkout.config/cache.namespace', 4, {
            key: 'cache.namespace',
            value: 'walrus',
            version: 4,
          }),
        ],
      }),
    );
    expect(b.snapshot.prefixDigest).toBe(a.snapshot.prefixDigest);
    expect(b.snapshot.prefixLength).toBe(a.snapshot.prefixLength);
    expect(b.snapshot.toolSchemaHash).toBe(a.snapshot.toolSchemaHash);
    expect(b.snapshot.contextDigest).not.toBe(a.snapshot.contextDigest);
    expect(b.system.slice(0, b.snapshot.prefixLength)).toBe(
      a.system.slice(0, a.snapshot.prefixLength),
    );
  });

  it('changing evidence and the clock land AFTER the prefix boundary, never inside it', () => {
    const a = compileContext(input());
    const prefix = a.system.slice(0, a.snapshot.prefixLength);
    for (const needle of [
      'zebra',
      'checkout.config/cache.namespace',
      NOW_A,
      'Read the cache namespace',
    ]) {
      expect(
        prefix.includes(needle),
        `prefix must not contain "${needle}"`,
      ).toBe(false);
      expect(
        a.system.includes(needle),
        `context must contain "${needle}"`,
      ).toBe(true);
      expect(a.system.indexOf(needle)).toBeGreaterThanOrEqual(
        a.snapshot.prefixLength,
      );
    }
  });

  it('the digest is not a constant: a different tool set, role text or runbook changes prefixDigest (and a different tool set changes toolSchemaHash)', () => {
    const base = compileContext(input());
    const roleChanged = compileContext(
      input({ roleInstructions: 'Role: auditor. Challenge the evidence.' }),
    );
    const runbookChanged = compileContext(
      input({
        runbooks: [
          { id: 'cache', title: 'Cache semantics', text: 'Different text.' },
        ],
      }),
    );
    const fewerTools = compileContext(
      input({ toolNames: ['observe_source', 'publish_finding'] }),
    );
    expect(roleChanged.snapshot.prefixDigest).not.toBe(
      base.snapshot.prefixDigest,
    );
    expect(runbookChanged.snapshot.prefixDigest).not.toBe(
      base.snapshot.prefixDigest,
    );
    expect(fewerTools.snapshot.prefixDigest).not.toBe(
      base.snapshot.prefixDigest,
    );
    expect(fewerTools.snapshot.toolSchemaHash).not.toBe(
      base.snapshot.toolSchemaHash,
    );
    expect(roleChanged.snapshot.toolSchemaHash).toBe(
      base.snapshot.toolSchemaHash,
    );
  });

  it('tool-schema hash is stable across layouts and repeated compiles (deterministic order)', () => {
    const h = new Set(
      [1, 2, 3].flatMap(() => [
        compileContext(input({ layout: 'cache_aware' })).snapshot
          .toolSchemaHash,
        compileContext(input({ layout: 'ordinary' })).snapshot.toolSchemaHash,
      ]),
    );
    expect(h.size).toBe(1);
  });
});

describe('G5.6b the wire carries what the snapshot claims (live, through the adapter)', () => {
  it('two compatible live calls send byte-identical tool schemas and an identical prefix; the changed evidence is what the model answers from', async () => {
    const proxy = await startProxy(live.baseUrl);
    try {
      const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
      const a = compileContext(input());
      const b = compileContext(
        input({
          nowIso: NOW_B,
          receipts: [
            receipt(1, 'checkout.config/cache.namespace', 4, {
              key: 'cache.namespace',
              value: 'walrus',
              version: 4,
            }),
          ],
        }),
      );
      // Wire identity is checked with the full tool set. The model may
      // answer or reach for a tool; either is a real completion here.
      const ra = await completeThroughSaturation(viaProxy, toRequest(a));
      const rb = await completeThroughSaturation(viaProxy, toRequest(b));
      expect(['completed', 'tool_calls']).toContain(ra.outcome);
      expect(['completed', 'tool_calls']).toContain(rb.outcome);
      // Evidence use is checked with the same system text and no tools, so the
      // model must answer in text: the changed evidence is what it quotes.
      const ta = await completeThroughSaturation(
        viaProxy,
        toRequest(a, { tools: [], toolSchemaHash: null }),
      );
      const tb = await completeThroughSaturation(
        viaProxy,
        toRequest(b, { tools: [], toolSchemaHash: null }),
      );
      expect(ta.outcome).toBe('completed');
      expect(tb.outcome).toBe('completed');
      expect(ta.content).toContain('zebra');
      expect(tb.content).toContain('walrus');
      expect(tb.content).not.toContain('zebra');

      const wires = proxy.seen.filter((x) =>
        x.url.endsWith('/chat/completions'),
      );
      const idxB = wires.findIndex((x) =>
        JSON.stringify(x.body).includes('walrus'),
      );
      const [wa, wb] = [wires[0], wires[idxB]].map(
        (s) =>
          s.body as {
            tools: unknown[];
            messages: { role: string; content: string }[];
          },
      );
      expect(JSON.stringify(wb.tools)).toBe(JSON.stringify(wa.tools));
      const sysA = wa.messages[0].content;
      const sysB = wb.messages[0].content;
      expect(sysA.slice(0, a.snapshot.prefixLength)).toBe(
        sysB.slice(0, b.snapshot.prefixLength),
      );
      expect(sha(sysA.slice(0, a.snapshot.prefixLength))).toBe(
        a.snapshot.prefixDigest,
      );
      expect(sha(sysB.slice(0, b.snapshot.prefixLength))).toBe(
        a.snapshot.prefixDigest,
      );
      expect(sysA).not.toBe(sysB);
    } finally {
      await proxy.close();
    }
  }, 120_000);
});

describe('G5.6c cached-token honesty: null = unavailable, 0 only if the provider said 0', () => {
  it('live Super: adapter cachedTokens equals what the provider returned (null when absent), never coerced', async () => {
    let raw: Record<string, unknown> | undefined;
    const proxy = await startProxy(live.baseUrl, () => ({
      kind: 'forward',
      transform: (j) => {
        raw = JSON.parse(JSON.stringify(j.usage ?? null));
        return j;
      },
    }));
    try {
      const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
      const c = compileContext(input());
      const observed: (number | null)[] = [];
      for (let i = 0; i < 2; i++) {
        raw = undefined;
        const r = await completeThroughSaturation(viaProxy, toRequest(c));
        expect(['completed', 'tool_calls']).toContain(r.outcome);
        const details = (
          raw as
            | { prompt_tokens_details?: { cached_tokens?: unknown } | null }
            | undefined
        )?.prompt_tokens_details;
        const expected =
          typeof details?.cached_tokens === 'number'
            ? details.cached_tokens
            : null;
        expect(r.usage.cachedTokens).toBe(expected);
        expect(r.attempts[r.attempts.length - 1].usage.cachedTokens).toBe(
          expected,
        );
        if (r.usage.cachedTokens !== null) {
          expect(Number.isInteger(r.usage.cachedTokens)).toBe(true);
          expect(r.usage.cachedTokens).toBeGreaterThanOrEqual(0);
          expect(r.usage.cachedTokens).toBeLessThanOrEqual(
            r.usage.promptTokens!,
          );
        }
        observed.push(r.usage.cachedTokens);
      }
      // Recorded for the report: the suite does NOT assert a cache hit (no unsupported cache claim).
      console.log(
        `G5.6c observed cachedTokens across a repeated identical prefix: ${JSON.stringify(observed)}`,
      );
    } finally {
      await proxy.close();
    }
  }, 120_000);

  const variants: [
    string,
    (u: Record<string, unknown>) => Record<string, unknown>,
    number | null,
  ][] = [
    [
      'prompt_tokens_details absent',
      (u) => {
        const { prompt_tokens_details: _d, ...rest } = u;
        return rest;
      },
      null,
    ],
    [
      'prompt_tokens_details null',
      (u) => ({ ...u, prompt_tokens_details: null }),
      null,
    ],
    [
      'prompt_tokens_details without cached_tokens',
      (u) => ({ ...u, prompt_tokens_details: {} }),
      null,
    ],
    [
      'cached_tokens null',
      (u) => ({ ...u, prompt_tokens_details: { cached_tokens: null } }),
      null,
    ],
    [
      'cached_tokens 0',
      (u) => ({ ...u, prompt_tokens_details: { cached_tokens: 0 } }),
      0,
    ],
    [
      'cached_tokens 7',
      (u) => ({ ...u, prompt_tokens_details: { cached_tokens: 7 } }),
      7,
    ],
  ];

  for (const stream of [false, true]) {
    for (const [name, mutate, expected] of variants) {
      it(`${stream ? 'streaming' : 'non-stream'}, provider usage with ${name} -> cachedTokens ${expected === null ? 'null (unavailable)' : expected}`, async () => {
        const proxy = await startProxy(live.baseUrl, () => ({
          kind: 'forward',
          transform: (j) =>
            j.usage && typeof j.usage === 'object'
              ? { ...j, usage: mutate(j.usage as Record<string, unknown>) }
              : j,
        }));
        try {
          const viaProxy = await createAdapter({
            OPENAI_BASE_URL: proxy.baseUrl,
          });
          const r = await completeThroughSaturation(
            viaProxy,
            chat(live.model, 'Reply with exactly: OK', {
              stream,
              maxTokens: 32,
            }),
          );
          expect(r.outcome).toBe('completed');
          expect(r.usage.cachedTokens).toBe(expected);
          expect(r.attempts[r.attempts.length - 1].usage.cachedTokens).toBe(
            expected,
          );
          // the other counters are unaffected and still numeric
          expect(Number.isInteger(r.usage.promptTokens)).toBe(true);
        } finally {
          await proxy.close();
        }
      }, 60_000);
    }
  }

  it('a failed or cancelled attempt never reports 0 cached tokens: its usage is null, not zero', async () => {
    const proxy = await startProxy(live.baseUrl, () => ({
      kind: 'respond',
      status: 400,
      body: JSON.stringify({ code: 'bad', message: 'no', error_id: 'acc5' }),
    }));
    try {
      const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
      const r = await completeThroughSaturation(
        viaProxy,
        chat(live.model, 'x'),
      );
      expect(r.attempts[0].usage.cachedTokens).toBeNull();
      expect(r.usage.cachedTokens).toBeNull();
    } finally {
      await proxy.close();
    }
    expect(adapter.mode).toBe('live');
  }, 60_000);
});
