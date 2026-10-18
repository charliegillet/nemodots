// W5.3: the composed NemoDots runtime (bootstrap.ts buildRuntime) on a fresh
// migrated database and Redis prefix, with the provider replaced by a local
// Chat Completions stub whose replies the test scripts. Everything between the
// stub and PostgreSQL is production code: the team handler and its nine tools,
// the bootstrap observer and reads, the coordinator, the ledger and the action
// boundary. The planner attempt is published through the real coordinator from
// a hand-written plan so a test can drive one worker attempt directly.
// LABEL: the provider is a scripted stub (wiring proof), never live evidence.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import {
  buildRuntime,
  type Runtime,
} from '../../../../src/server/nemodots/bootstrap.js';
import type {
  AttemptContext,
  MissionId,
  ObservationReceipt,
  SourceRef,
  TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import type { HostRun } from '../../../../src/server/nemodots/coordinator/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';

export const STUB_MODEL = 'adversary/stub-model';

export interface StubRequest {
  host: string;
  path: string;
  body: Record<string, unknown>;
}

export type Reply =
  | { content: string }
  | { toolCalls: { id: string; name: string; args: unknown }[] };

/**
 * Scripted provider. `next` decides each chat completion from the parsed
 * request; it may run side effects (e.g. supersede a receipt) before it
 * answers. GET /models lists STUB_MODEL so the provider health check passes.
 */
export async function stubProvider(
  next: (request: StubRequest) => Promise<Reply> | Reply,
) {
  const requests: StubRequest[] = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', async () => {
      if (request.url?.endsWith('/models')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: STUB_MODEL }] }));
        return;
      }
      const body = (() => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const entry: StubRequest = {
        host: String(request.headers.host),
        path: String(request.url),
        body,
      };
      requests.push(entry);
      let reply: Reply;
      try {
        reply = await next(entry);
      } catch {
        reply = { content: 'stub error' };
      }
      const message =
        'toolCalls' in reply
          ? {
              role: 'assistant',
              content: null,
              tool_calls: reply.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              })),
            }
          : { role: 'assistant', content: reply.content };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'stub',
          model: STUB_MODEL,
          choices: [
            {
              index: 0,
              message,
              finish_reason: 'toolCalls' in reply ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Composed {
  db: TestDatabase;
  rt: Runtime;
  admin: pg.Pool;
  app: pg.Pool;
  injector: pg.Pool;
  provider: Awaited<ReturnType<typeof stubProvider>>;
  /** Creates and starts a mission; publishes `roles` as its root tasks. */
  mission(roles: TaskRole[]): Promise<MissionId>;
  /** Claims one attempt of `role` in `missionId` and runs it through the composed team handler. */
  runWorker(missionId: MissionId, role: TaskRole): Promise<HostRun | null>;
  /** Claims and starts an attempt without running a handler (for port-level checks). */
  claim(missionId: MissionId, role: TaskRole): Promise<AttemptContext>;
  /** The watcher's job: register the live authority row of a config member. */
  registerMember(
    missionId: MissionId,
    key: string,
  ): Promise<ObservationReceipt>;
  /** Another writer changes a controlled config value (injector role). */
  injectorWrite(key: string, value: unknown): Promise<void>;
  /** Replaces the provider script. */
  setReply(reply: (request: StubRequest) => Promise<Reply> | Reply): void;
}

export async function withComposed<T>(
  fn: (c: Composed) => Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  return withTestDatabase((db) =>
    withTestRedis(async (redis) => {
      let reply: (request: StubRequest) => Promise<Reply> | Reply = () => ({
        content: 'Final answer: nothing more to do.',
      });
      const provider = await stubProvider((request) => reply(request));
      const admin = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
      const app = new pg.Pool({ connectionString: db.urls.app, max: 4 });
      const injector = new pg.Pool({
        connectionString: db.urls.injector,
        max: 2,
      });
      for (const pool of [admin, app, injector])
        pool.on('error', () => undefined);
      const env: Record<string, string | undefined> = {
        NEMODOTS_INSTANCE: 'dev',
        NEMODOTS_PG_URL_APP: db.urls.app,
        NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
        NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
        NEMODOTS_PROBE_SECRET: 'probe-secret-for-adversary-tests-0123',
        NEMODOTS_REDIS_URL: redis.url,
        NEMODOTS_REDIS_PREFIX: redis.prefix,
        NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:9',
        NEMODOTS_WATCH_INTERVAL_MS: '60000',
        NEMODOTS_WORKERS: '0',
        NEMODOTS_INFERENCE_MODE: 'live',
        OPENAI_API_KEY: 'adversary-stub-key-0123456789',
        OPENAI_MODEL: STUB_MODEL,
        OPENAI_BASE_URL: provider.baseUrl,
        ...extraEnv,
      };
      const rt = buildRuntime(env, { workspace: { ownerId: 'owner' } });
      try {
        if (rt.redis && !rt.redis.isOpen)
          await rt.redis.connect().catch(() => undefined);
        await seedCheckout(admin);
        const composed: Composed = {
          db,
          rt,
          admin,
          app,
          injector,
          provider,
          setReply(next) {
            reply = next;
          },
          async mission(roles) {
            const created = await rt.coordinator.control.create({
              goal: 'restore checkout availability',
              mode: 'live',
            } as never);
            await rt.coordinator.control.start(created.id);
            const planner = rt.coordinator.createWorkerHost({
              workerId: 'adversary-planner',
              missionId: created.id,
              roles: ['planner'],
              handler: async () => ({
                type: 'plan',
                createdByModelCallId: null,
                plan: {
                  tasks: roles.map((role, i) => ({
                    title: `${role} task ${i}`,
                    question: `Investigate as ${role}.`,
                    role,
                    capabilities: [],
                    dependsOn: [],
                  })),
                },
              }),
            });
            const run = await planner.runOnce();
            if (run?.result !== 'published')
              throw new Error(`plan not published: ${run?.result}`);
            return created.id;
          },
          async runWorker(missionId, role) {
            const host = rt.coordinator.createWorkerHost({
              workerId: `adversary-${role}`,
              missionId,
              roles: [role],
              handler: rt.handler!,
            });
            return host.runOnce();
          },
          async claim(missionId, role) {
            const claimed = await rt.coordinator.claimAttempt({
              workerId: `adversary-claim-${role}`,
              missionId,
              roles: [role],
              leaseMs: 120_000,
            });
            if (!claimed) throw new Error(`no ${role} attempt to claim`);
            await rt.coordinator.startAttempt(claimed.context);
            return claimed.context;
          },
          async registerMember(missionId, key) {
            const { rows } = await admin.query<{
              value: unknown;
              version: string;
            }>(
              'SELECT value, version FROM checkout.config_entries WHERE key = $1',
              [key],
            );
            const scope = {
              ownerId: 'owner',
              missionId,
              spaceId: null,
              environment: 'dev',
              resource: 'checkout',
            };
            const result = await withTransaction(rt.pools.app, (client) =>
              registerObservation(
                client,
                {
                  source: {
                    key: `checkout.config/${key}`,
                    sourceType: 'controlled_config',
                    authority: 'controlled',
                    scope,
                  } as unknown as SourceRef,
                  normalizedValue: {
                    key,
                    value: rows[0].value,
                    version: Number(rows[0].version),
                  },
                  provenance: { kind: 'watcher' },
                },
                { ledger: rt.ledgerOptions },
              ),
            );
            return result.receipt;
          },
          async injectorWrite(key, value) {
            const { advanceConfigUnconditionallyTx } =
              await import('../../../../src/server/nemodots/sandbox/version-authority.js');
            await advanceConfigUnconditionallyTx(injector, {
              key,
              value: value as never,
              causedBy: { actor: 'injector' },
            });
          },
        };
        return await fn(composed);
      } finally {
        await rt.close().catch(() => undefined);
        await Promise.all([admin.end(), app.end(), injector.end()]);
        await provider.close();
      }
    }),
  );
}

/** The role named in a worker request's system prompt, if any. */
export function roleOf(request: StubRequest): string | null {
  const messages = (request.body.messages ?? []) as {
    role: string;
    content?: unknown;
  }[];
  const system = String(messages[0]?.content ?? '');
  if (system.includes('Role: investigator.')) return 'investigator';
  if (system.includes('Role: specialist for the cache'))
    return 'cache_specialist';
  if (system.includes('Role: specialist for the database'))
    return 'database_specialist';
  if (system.includes('Role: specialist for the inventory'))
    return 'routing_specialist';
  if (system.includes('Role: verifier.')) return 'verifier';
  if (system.includes('Role: postcondition')) return 'postcondition';
  return null;
}

/** A provider script: per-role queues of replies; a final answer when a queue runs dry. */
export function scripted(
  queues: Partial<
    Record<string, Array<Reply | ((r: StubRequest) => Promise<Reply> | Reply)>>
  >,
) {
  return async (request: StubRequest): Promise<Reply> => {
    const role = roleOf(request) ?? 'unknown';
    const next = queues[role]?.shift();
    if (!next) return { content: 'Final answer: nothing more to do.' };
    return typeof next === 'function' ? next(request) : next;
  };
}

/** The tool result contents (parsed) the provider received in a request. */
export function toolResultsOf(request: StubRequest): Record<string, unknown>[] {
  const messages = (request.body.messages ?? []) as {
    role: string;
    content?: unknown;
  }[];
  return messages
    .filter((m) => m.role === 'tool')
    .map((m) => {
      // The context compiler wraps each tool result as untrusted data:
      //   <data kind="tool_result" ...>\n| {json}\n</data>
      const text = String(m.content);
      const json = /^\|\s(\{.*\})\s*$/m.exec(text)?.[1] ?? text;
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch {
        return { raw: m.content };
      }
    });
}

/**
 * Records, through the fenced coordinator port, a model call of `ctx` whose
 * snapshot vector is `receipts` and which emitted one `toolName` call. Returns
 * the ids the action port binds a proposal to.
 */
export async function emitCall(
  c: Composed,
  ctx: AttemptContext,
  receipts: readonly ObservationReceipt[],
  toolName = 'propose_action',
) {
  const { randomUUID } = await import('node:crypto');
  const { sha256Hex } =
    await import('../../../../src/server/nemodots/contracts/index.js');
  const vector = [...receipts]
    .sort((a, b) =>
      a.source.key < b.source.key ? -1 : a.source.key > b.source.key ? 1 : 0,
    )
    .map((r) => ({
      sourceKey: r.source.key,
      sourceRevision: r.sourceRevision,
      receiptId: r.id,
    }));
  const now = new Date().toISOString();
  const toolCallId = `call_${randomUUID().slice(0, 12)}`;
  const snapshot = {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: sha256Hex('prefix'),
    prefixLength: 10,
    contextDigest: sha256Hex(`ctx-${randomUUID()}`),
    contextLength: 20,
    toolSchemaHash: sha256Hex('tools'),
    injected: {
      receipts: receipts.map((r) => ({
        id: r.id,
        sourceKey: r.source.key,
        sourceRevision: r.sourceRevision,
        contentDigest: r.contentDigest,
      })),
      inheritedArtifacts: [],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: vector,
    volatile: { nowIso: now },
  };
  const modelCallId = randomUUID();
  const record = {
    id: modelCallId,
    scope: {
      ownerId: 'owner',
      missionId: ctx.missionId,
      spaceId: null,
      environment: 'dev',
      resource: 'checkout',
    },
    taskId: ctx.taskId,
    attemptId: ctx.attemptId,
    role: 'worker',
    model: { requested: STUB_MODEL, returned: STUB_MODEL },
    provider: { host: c.provider.host, mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts: [
      {
        n: 1,
        startedAt: now,
        headersAt: now,
        firstContentAt: now,
        finishedAt: now,
        httpStatus: 200,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          cachedTokens: null,
          reasoningTokens: null,
        },
        finishReason: 'tool_calls',
        error: null,
        retryAfterMs: null,
        streamed: false,
        outcome: 'recorded',
      },
    ],
    outcome: 'tool_calls',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: vector,
    toolCalls: [
      { toolCallId, name: toolName, argumentsDigest: sha256Hex('{}') },
    ],
    createdAt: now,
  };
  await c.rt.coordinator.recordModelCall(ctx, {
    record: record as never,
    snapshot: snapshot as never,
  });
  return { modelCallId, toolCallId };
}

/** Registers an observed source value in a mission (the watcher's job). */
export async function registerObserved(
  c: Composed,
  missionId: MissionId,
  key: string,
  value: unknown,
): Promise<ObservationReceipt> {
  const result = await withTransaction(c.rt.pools.app, (client) =>
    registerObservation(
      client,
      {
        source: {
          key,
          sourceType: 'observed_endpoint',
          authority: 'observed',
          scope: {
            ownerId: 'owner',
            missionId,
            spaceId: null,
            environment: 'dev',
            resource: 'checkout',
          },
        } as unknown as SourceRef,
        normalizedValue: value,
        provenance: { kind: 'watcher' },
      },
      { ledger: c.rt.ledgerOptions },
    ),
  );
  return result.receipt;
}
