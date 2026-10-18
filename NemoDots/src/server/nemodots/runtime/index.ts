import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createClient } from 'redis';
import {
  CreateMissionRequestSchema,
  SourceEditRequestSchema,
  InjectorRunRequestSchema,
  type HealthStatus,
  type MissionId,
  type ObservationReceipt,
  type Scope,
} from '../contracts/index.js';
import {
  createCoordinator,
  buildSnapshot,
  type Coordinator,
  type ForeignSnapshot,
  type ForeignSnapshotReader,
  type LedgerWriterPort,
} from '../coordinator/index.js';
import { createRolePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import {
  addEdges,
  createSupportValidator,
  listEvidence,
  recordModelCall as ledgerRecordModelCall,
  recordOrphanedAttempt as ledgerRecordOrphanedAttempt,
  registerObservation,
} from '../ledger/index.js';
import { createInferenceFromEnv, resolveMode } from '../inference/index.js';
import { createSourceReaders } from '../sandbox/readers.js';
import { createProbe, acceptanceNormalizedValue } from '../sandbox/probe.js';
import { loadConfig, roleUrl } from '../sandbox/runtime-env.js';
import { Injector } from '../sandbox/injector.js';
import { loadScenario } from '../sandbox/manifest.js';
import {
  advanceConfigTx,
  ConfigVersionError,
} from '../sandbox/version-authority.js';
import { summarizeTelemetry } from '../telemetry/summary.js';
import {
  authorizationFromRow,
  createActions,
  intentFromRow,
  resultFromRow,
} from './actions.js';
import { createTeamHandler } from './team.js';
import { createWatcher, emitReceipt } from './watcher.js';

// Composition root for the fast demo path (simplified W4.2 + W5.1).

const SCENARIO_FOR_CLASS: Record<string, string> = {
  repairable_checkout_fault: 'cache_schema_mismatch',
  dependent_change_after_proposal: 'dependent_change_after_proposal',
  benign_change: 'benign_change',
  healthy_control: 'healthy',
  second_change_during_repair: 'second_change_during_repair',
  conflicting_observations: 'conflicting_observations',
  diverging_edges: 'diverging_edges',
};

const log = (message: string) =>
  console.log(`[nemodots ${new Date().toISOString().slice(11, 19)}] ${message}`);

export async function createNemoDotsRuntime(env = process.env) {
  const config = loadConfig(env);
  const app = createRolePool('app', roleUrl(config, 'app'), { max: 8 });
  const injectorPool = createRolePool('injector', roleUrl(config, 'injector'), {
    max: 2,
  });
  const verifier = createRolePool('verifier', roleUrl(config, 'verifier'), {
    max: 4,
  });
  const redis = createClient({ url: config.redis.url });
  redis.on('error', () => {});
  await redis.connect();

  const mode = resolveMode(env);
  if (mode.mode !== 'live')
    throw new Error(
      `NemoDots demo needs live inference (missing: ${JSON.stringify(mode)})`,
    );
  // At most 2 Crusoe requests in flight (shared rate limit).
  const inference = createInferenceFromEnv({
    ...env,
    NEMODOTS_INFERENCE_MAX_IN_FLIGHT: '2',
  }) as ReturnType<typeof createInferenceFromEnv> & { mode: 'live' };
  const model = env.OPENAI_MODEL!.trim();
  const ownerId = env.OWNER_ID?.trim() || 'nemodots-owner';
  const scopeFor = (missionId: string): Scope => ({
    ownerId,
    missionId: missionId as MissionId,
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
  });

  const readers = createSourceReaders({
    pg: app,
    redis: redis as never,
    redisPrefix: config.redis.prefix,
    checkoutUrl: config.checkout.url,
    probeSecret: config.probe.secret,
  });

  let coordinator!: Coordinator;
  const events = { append: (...a: Parameters<Coordinator['deps']['events']['append']>) => coordinator.deps.events.append(...a) };

  const actions = createActions({
    pool: app,
    events,
    dispatcherId: `dispatcher-${process.pid}`,
    commitDelayMs: Number(env.NEMODOTS_COMMIT_DELAY_MS ?? 3000),
    dispatchLeaseMs: 60_000,
    redis: {
      async unlinkNamespace(namespace) {
        let deleted = 0;
        for await (const keys of redis.scanIterator({
          MATCH: `${config.redis.prefix}:cache:${namespace}:*`,
          COUNT: 200,
        })) {
          const list = (Array.isArray(keys) ? keys : [keys]) as string[];
          if (list.length) deleted += await redis.unlink(list);
        }
        return deleted;
      },
    },
  });

  const ledgerPort: LedgerWriterPort = {
    async recordModelCall(client, input) {
      await ledgerRecordModelCall(client, {
        record: input.record,
        snapshot: input.snapshot,
      });
    },
    async recordArtifact(client, a) {
      if (a.kind === 'finding') return;
      const to = {
        kind: a.kind,
        id: a.id,
        missionId: a.missionId,
        taskId: a.taskId,
      } as const;
      await addEdges(client, [
        ...a.dependencyVector.map((e) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: e.receiptId },
          to,
        })),
        {
          kind: 'evidence' as const,
          from: {
            kind: 'attempt' as const,
            id: a.attemptId,
            missionId: a.missionId,
            taskId: a.taskId,
          },
          to,
        },
      ]);
    },
  };

  const snapshotReader: ForeignSnapshotReader = {
    async read(client, missionId) {
      const evidence = await listEvidence(client, {
        ownerId,
        environment: 'dev',
        resource: 'checkout',
        missionId,
        includeHistory: true,
      });
      const receipts = evidence
        .map((item) => item.receipt)
        .filter((r) => r.source.scope.missionId === missionId);
      const intents = (
        await client.query(
          'SELECT * FROM coordinator.action_intents WHERE mission_id = $1 ORDER BY proposed_at',
          [missionId],
        )
      ).rows;
      const ids = intents.map((row) => row.id);
      const authorizations = (
        await client.query(
          'SELECT * FROM coordinator.authorizations WHERE action_id = ANY($1::uuid[]) ORDER BY seq',
          [ids],
        )
      ).rows;
      const results = (
        await client.query(
          'SELECT * FROM coordinator.result_receipts WHERE action_id = ANY($1::uuid[]) ORDER BY seq',
          [ids],
        )
      ).rows;
      const probe =
        [...receipts]
          .reverse()
          .find((r) => r.source.key === 'checkout.acceptance') ?? null;
      return {
        receipts,
        confirmations: [],
        actions: intents.map(intentFromRow),
        authorizations: authorizations.map(authorizationFromRow),
        results: results.map(resultFromRow),
        probe,
        telemetry: await summarizeTelemetry(client as never, missionId),
      } as ForeignSnapshot;
    },
  };

  const probe = createProbe({
    verifier,
    checkoutUrl: config.checkout.url,
    probeSecret: config.probe.secret ?? '',
    windowMs: Math.min(config.probe.windowMs, 10_000),
    async register(missionId, result): Promise<ObservationReceipt> {
      log(`probe: ${result.verdict} ${JSON.stringify(result.invariants.filter((i) => !i.ok))}`);
      return withTransaction(app, async (client) => {
        const registered = await registerObservation(client, {
          source: {
            key: 'checkout.acceptance' as never,
            sourceType: 'probe',
            authority: 'observed',
            scope: scopeFor(missionId),
          },
          normalizedValue: {
            ...acceptanceNormalizedValue(result),
            healthSamples: result.healthWindow.samples,
            healthOk: result.healthWindow.okSamples,
          },
          provenance: { kind: 'probe' },
        });
        await emitReceipt(events, client, missionId, registered);
        await events.append(client, {
          missionId,
          kind: 'probe.recorded',
          payload: {
            kind: 'probe.recorded',
            receiptId: registered.receipt.id,
            verdict: result.verdict,
            invariants: result.invariants,
            healthSamples: result.healthWindow.samples,
            healthOk: result.healthWindow.okSamples,
          },
        } as never);
        return registered.receipt;
      });
    },
  });

  coordinator = createCoordinator(
    {
      pool: app,
      config: {
        ownerId,
        spaceId: null,
        environment: 'dev',
        resource: 'checkout',
        mode: 'live',
        provider: {
          host: inference.host(),
          plannerModel: model,
          workerModel: model,
        },
        budgets: {
          maxTasks: 24,
          maxDepth: 3,
          maxBreadth: 4,
          maxTokens: 2_000_000,
          maxInferenceCalls: 300,
          maxWallClockMs: 3_600_000,
        },
        leaseMs: 60_000,
        taskDefaults: { maxAttempts: 3, maxIterations: 14, maxTokens: 200_000 },
        replanCap: 3,
      },
      supportValidator: createSupportValidator(),
      ledger: ledgerPort,
      async recordOrphanedAttempt(info) {
        await withTransaction(app, (client) =>
          ledgerRecordOrphanedAttempt(client, {
            modelCallId: info.record.id,
            scope: info.record.scope,
            taskId: info.record.taskId,
            attemptId: info.record.attemptId,
            role: info.record.role,
            model: info.record.model,
            provider: info.record.provider,
            attempts: info.record.attempts,
          } as never),
        );
      },
      intents: {
        async find(client, id) {
          const r = await client.query<Record<string, string>>(
            'SELECT id, mission_id, task_id, attempt_id, status FROM coordinator.action_intents WHERE id=$1',
            [id],
          );
          const x = r.rows[0];
          return x
            ? ({
                id: x.id,
                missionId: x.mission_id,
                taskId: x.task_id,
                attemptId: x.attempt_id,
                status: x.status,
              } as never)
            : null;
        },
        async statuses(client, ids) {
          return (
            await client.query(
              'SELECT id, status FROM coordinator.action_intents WHERE id = ANY($1::uuid[])',
              [ids],
            )
          ).rows as never;
        },
        async committedEffects(client, missionId) {
          return (
            await client.query<{ id: string }>(
              "SELECT id FROM coordinator.action_intents WHERE mission_id=$1 AND status IN ('committed','dispatched','verified','outcome_unknown')",
              [missionId],
            )
          ).rows.map((x) => x.id) as never;
        },
      },
      actions: {
        admit: async (id) => (await actions.read(id)) as never,
        cancelQueued: (m, g) => actions.cancelQueued(m, g),
      },
      snapshotReader,
      probe,
      providerHealthy: async () => true,
    },
    { workerId: `nemodots-${process.pid}` },
  );

  const watcher = createWatcher({
    pool: app,
    readers,
    events,
    scopeFor: scopeFor as never,
    pollMs: 400,
    log,
    onInvalidation: async (event) => {
      log(
        `invalidation ${event.id.slice(0, 8)} ${event.sourceKey}: affected tasks ${event.affected.taskIds.length}, attempts ${event.affected.attemptIds.length}`,
      );
      await coordinator.onInvalidation(event);
    },
    onSelfWrite: async (actionId, receipt, version) => {
      await actions.verify(actionId, receipt.id, version);
      await coordinator.onSelfWriteSettled(actionId as never, 'verified');
    },
  });

  const host = coordinator.createWorkerHost({
    workerId: `team-${process.pid}`,
    handler: createTeamHandler({
      pool: app,
      coordinator,
      inference,
      readers,
      actions,
      events,
      plannerModel: model,
      workerModel: model,
      scopeFor,
      log,
    }),
    concurrency: 8,
    pollMs: 300,
    onError: (error) => log(`worker error: ${(error as Error).message}`),
    onRun: (run) =>
      log(`attempt ${run.attemptId.slice(0, 8)} ${run.result}${run.abortReason ? ` (${run.abortReason})` : ''}${run.error ? ` ${(run.error as Error).message}` : ''}`),
  });

  const injectorRuns = new Map<string, Awaited<ReturnType<Injector['start']>>>();
  const routes = new Hono();

  routes.get('/health', async (c) => {
    const pgOk = await app.query('SELECT 1').then(() => true, () => false);
    const redisOk = await redis.ping().then(() => true, () => false);
    const checkout = await fetch(`${config.checkout.url}/health`)
      .then(async (r) => ((await r.json()) as { status?: string }).status ?? null)
      .catch(() => null);
    const health: HealthStatus = {
      mode: 'live',
      provider: {
        reachable: true,
        modelListed: true,
        model,
        host: inference.host(),
        checkedAt: new Date().toISOString(),
      },
      postgres: pgOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      checkout: { reachable: checkout !== null, status: checkout as never },
      intelligence: env.CPK_INTELLIGENCE_API_KEY ? 'configured' : 'blocked',
      missingEnv: [],
      incidentDotIds: 0,
    };
    return c.json(health);
  });
  routes.post('/missions', async (c) => {
    const parsed = CreateMissionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.mode && parsed.data.mode !== 'live')
      return c.json({ error: 'mode must be live' }, 400);
    const mission = await coordinator.control.create(parsed.data);
    log(`mission ${mission.id} created: ${mission.goal}`);
    return c.json(mission);
  });
  routes.get('/missions', async (c) => {
    const { rows } = await app.query<{ id: string }>(
      'SELECT id FROM coordinator.missions ORDER BY created_at DESC LIMIT 20',
    );
    const missions = [];
    for (const row of rows)
      missions.push(await coordinator.control.get(row.id as MissionId));
    return c.json(missions);
  });
  routes.get('/missions/:id', async (c) => {
    try {
      return c.json(
        await buildSnapshot(coordinator.deps, c.req.param('id') as MissionId),
      );
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404);
    }
  });
  for (const action of ['start', 'pause', 'resume', 'cancel'] as const)
    routes.post(`/missions/:id/${action}`, async (c) => {
      try {
        const mission = await coordinator.control[action](
          c.req.param('id') as MissionId,
        );
        log(`mission ${mission.id} ${action} -> ${mission.status}`);
        return c.json(mission);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 409);
      }
    });
  routes.get('/missions/:id/events', (c) => {
    const missionId = c.req.param('id') as MissionId;
    let after = Number(c.req.header('Last-Event-ID') ?? '0') || 0;
    return streamSSE(c, async (stream) => {
      let lastBeat = Date.now();
      while (!stream.aborted) {
        const events = await coordinator.events.replay(missionId, after, 200);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.id),
            event: event.kind,
            data: JSON.stringify(event),
          });
          after = Math.max(after, event.id);
        }
        if (Date.now() - lastBeat > 15_000) {
          await stream.write(': heartbeat\n\n');
          lastBeat = Date.now();
        }
        await stream.sleep(events.length ? 50 : 400);
      }
    });
  });
  routes.post('/sandbox/sources/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key')).replace(
      /^checkout\.config\//,
      '',
    );
    const parsed = SourceEditRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const written = await advanceConfigTx(app, {
        key,
        value: parsed.data.value,
        expectedVersion: parsed.data.expectedVersion,
        causedBy: { actor: 'owner' },
      });
      log(`owner edit ${key} -> v${written.versionAfter}`);
      void watcher.tick();
      return c.json({ key: `checkout.config/${key}`, version: written.versionAfter });
    } catch (error) {
      if (error instanceof ConfigVersionError)
        return c.json({ error: `${error.code}: ${error.message}` }, 409);
      throw error;
    }
  });
  routes.post('/sandbox/injector/run', async (c) => {
    const parsed = InjectorRunRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const id =
      SCENARIO_FOR_CLASS[parsed.data.scenarioClass] ?? parsed.data.scenarioClass;
    let manifest;
    try {
      manifest = loadScenario(id);
    } catch {
      return c.json({ error: `unknown scenario ${id}` }, 400);
    }
    const injector = new Injector({
      pool: injectorPool,
      listenUrl: roleUrl(config, 'injector'),
    });
    const run = await injector.start(manifest, randomInt(1, 1_000_000));
    injectorRuns.set(run.runId, run);
    log(`injector run ${run.runId.slice(0, 8)} scenario ${id}`);
    void run.done.then(
      (summary) => log(`injector run ${run.runId.slice(0, 8)} done: ${JSON.stringify(summary).slice(0, 300)}`),
      (error) => log(`injector run failed: ${(error as Error).message}`),
    );
    return c.json({ runId: run.runId });
  });
  routes.get('/sandbox/checkout/health', async (c) => {
    const r = await fetch(`${config.checkout.url}/health`).catch(() => null);
    if (!r) return c.json({ error: 'checkout unreachable' }, 503);
    const body = (await r.json()) as Record<string, unknown>;
    return c.json({
      status: body.status,
      postgres: Boolean(body.postgres),
      redis: Boolean(body.redis),
      config_parse: Boolean(body.config_parse),
      writes: Boolean(body.writes),
      errorClasses: Array.isArray(body.errorClasses) ? body.errorClasses : [],
      sampledAt: new Date().toISOString(),
    });
  });
  routes.get('/telemetry/summary', async (c) => {
    const missionId = c.req.query('missionId');
    return c.json(await summarizeTelemetry(app as never, missionId as never));
  });
  routes.get('/evals/report', (c) => c.json({ status: 'NOT_RUN' }));

  return {
    routes,
    async start() {
      await coordinator.outbox.start();
      watcher.start();
      host.start();
      log(
        `runtime up: instance ${config.instance}, provider ${inference.host()} model ${model}`,
      );
    },
    async stop() {
      await host.stop();
      await watcher.stop();
      await coordinator.outbox.stop();
      for (const run of injectorRuns.values()) await run.cancel().catch(() => {});
      await redis.quit().catch(() => {});
      await Promise.all([app.end(), injectorPool.end(), verifier.end()]);
    },
  };
}
