// Runs one frozen held-out trial black-box and returns the evidence record.
// The runtime only ever receives the neutral mission goal and constraints and
// the (public) mission option admission.minAgeMs. Scenario steps go in through
// the private injector (nemodots_injector role, advanceConfig) or the public
// owner edit route; nothing about class, fault, key or value reaches the team.
//
// Independent observation channels (none of them is the system's own report):
//   - harness-only read-only SQL role (not in the app or worker environment)
//   - the verifier's pass-through provider proxy on every trial
//   - a Redis keyspace subscriber on db 7 under the trial prefix
//   - plain HTTP against the checkout API
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { MissionSnapshotSchema } from '../../../../../src/server/nemodots/contracts/index.js';
import { PROBE } from '../../oracle/checkout-invariants.js';
import {
  BlockedError,
  EntryPointMissingError,
  G6,
  ROLE_ENV,
  newOwnerToken,
  probeSecret,
  roleUrl,
  upstreamBaseUrl,
  withDatabase,
} from './config.js';
import { type FrozenTrialRef, loadManifest, type Step } from './frozen.js';
import {
  EventCollector,
  NemoApi,
  ReadLoad,
  checkoutRequest,
  loadSample,
  payloadOf,
  sampleHealthWindow,
  sleep,
} from './http.js';
import { ProviderProxy } from './provider-proxy.js';
import type {
  CheckoutProbeSurface,
  CrashStateAtKill,
  ProbeRecord,
  RecordedEvent,
  StepApplication,
  TrialRecord,
} from './record.js';
import { WORKER_PROGRESS_KINDS } from './scoring.js';
import { Sut, importEntry } from './sut.js';
import {
  RedisEffectWatcher,
  VerifierDb,
  seedStaleCacheBlobs,
  staleCacheBlobs,
} from './verifier-db.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export async function surface(sku: string): Promise<CheckoutProbeSurface> {
  const get = async (path: string) => {
    try {
      return await checkoutRequest('GET', path);
    } catch {
      return { status: 0, body: null, text: '' };
    }
  };
  const [health, ready, products, inventory] = await Promise.all([
    get('/health'),
    get('/ready'),
    get('/products'),
    get(`/inventory/${sku}`),
  ]);
  const quantityOf = (body: unknown) => {
    const q = (body as { quantity?: unknown })?.quantity;
    return typeof q === 'number' ? q : null;
  };
  const list = Array.isArray(products.body)
    ? products.body
    : ((products.body as { products?: unknown[] })?.products ?? null);
  return {
    health: {
      status: health.status,
      health: ((health.body as { status?: string })?.status ?? null) as
        string | null,
    },
    ready: { status: ready.status },
    products: {
      status: products.status,
      count: Array.isArray(list) ? list.length : null,
    },
    inventory: {
      status: inventory.status,
      quantity: quantityOf(inventory.body),
    },
  };
}

interface VersionAuthority {
  /** the injector's documented writer: advances from whatever version is current */
  advanceConfigUnconditionally?: (
    client: pg.ClientBase,
    input: { key: string; value: unknown; causedBy: { actor: 'injector' } },
  ) => Promise<unknown>;
}

export class StepApplier {
  private injector: pg.Client | null = null;
  constructor(
    private readonly sut: Sut,
    private readonly api: NemoApi,
    private readonly db: VerifierDb,
  ) {}

  async open() {
    this.injector = new pg.Client({
      connectionString: withDatabase(roleUrl('injector'), this.sut.database),
      application_name: 'acc6-injector',
    });
    await this.injector.connect();
  }

  /** The LISTEN client for nemodots_action_proposed (the injector's documented trigger path). */
  get listener() {
    if (!this.injector) throw new Error('injector not open');
    return this.injector;
  }

  async close() {
    await this.injector?.end().catch(() => undefined);
  }

  async apply(index: number, step: Step): Promise<StepApplication> {
    const before = (await this.db.configEntries())[step.key];
    const application: StepApplication = {
      index,
      step,
      appliedAtMs: Date.now(),
      versionBefore: before?.version ?? null,
      versionAfter: null,
      valueAfter: null,
      ok: false,
    };
    try {
      if (!before)
        throw new Error(
          `config key ${step.key} does not exist in the seeded database`,
        );
      if (step.requiresStaleBlobs) {
        const schema = (await this.db.configEntries())['cache.schema_version']
          ?.value;
        if (typeof schema !== 'number')
          throw new Error('cache.schema_version is not a number');
        await seedStaleCacheBlobs(
          this.sut.redisPrefix,
          String(step.value),
          schema,
        );
      }
      if (step.actor === 'injector') {
        const authority = (await importEntry(
          'versionAuthority',
        )) as VersionAuthority;
        if (typeof authority.advanceConfigUnconditionally !== 'function')
          throw new EntryPointMissingError(
            'src/server/nemodots/sandbox/version-authority.ts#advanceConfigUnconditionally',
            'module has no such export',
          );
        const client = this.injector!;
        await client.query('BEGIN');
        try {
          await authority.advanceConfigUnconditionally(client, {
            key: step.key,
            value: step.value,
            causedBy: { actor: 'injector' },
          });
          application.commitStartMs = Date.now();
          await client.query('COMMIT');
          application.commitEndMs = Date.now();
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      } else {
        application.commitStartMs = Date.now();
        let response = await this.api.post(
          `/sandbox/sources/${encodeURIComponent(step.key)}`,
          { value: step.value, expectedVersion: before.version },
        );
        if (response.status === 404)
          response = await this.api.post(
            `/sandbox/sources/${encodeURIComponent(`checkout.config/${step.key}`)}`,
            { value: step.value, expectedVersion: before.version },
          );
        application.commitEndMs = Date.now();
        if (response.status !== 200)
          throw new Error(
            `owner edit of ${step.key} returned HTTP ${response.status}`,
          );
      }
      // Independent read-back of what the version authority now holds.
      const after = (await this.db.configEntries())[step.key];
      application.versionAfter = after?.version ?? null;
      application.valueAfter = after?.value ?? null;
      application.ok =
        after !== undefined &&
        after.version === before.version + 1 &&
        JSON.stringify(after.value) === JSON.stringify(step.value);
      if (!application.ok)
        application.error = `read-back version ${after?.version} value ${JSON.stringify(after?.value)}, expected v${before.version + 1} ${JSON.stringify(step.value)}`;
    } catch (error) {
      application.error = (error as Error).message;
      if (error instanceof EntryPointMissingError) throw error;
    }
    application.appliedAtMs = Date.now();
    return application;
  }
}

function leakTokens(
  ref: FrozenTrialRef,
  secret: string,
  roleUrls: string[],
): string[] {
  const tokens = new Set<string>([
    ref.trial.trialId,
    ref.cls,
    'frozen-v1',
    'allowedMutationKeys',
    'keyPredicates',
    'evals/nemodots/frozen',
    'acceptance/oracle',
    'refrainScoring',
    secret,
  ]);
  if (ref.trial.faultClass && ref.trial.faultClass.length > 2)
    tokens.add(ref.trial.faultClass);
  for (const url of roleUrls) {
    const password = new URL(url).password;
    if (password) tokens.add(password);
  }
  return [...tokens].filter((t) => t.length >= 3);
}

function scanLeaks(
  corpus: string,
  tokens: string[],
  secret: string,
  roleUrls: string[],
): string[] {
  const labelOf = (token: string) =>
    token === secret
      ? '<probe secret>'
      : roleUrls.some((u) => new URL(u).password === token)
        ? '<database credential>'
        : token;
  return tokens
    .filter((token) => corpus.includes(token))
    .map((token) => `runtime-visible output contains ${labelOf(token)}`);
}

export interface RunTrialOptions {
  /** Called with progress lines (never secrets). */
  log?: (line: string) => void;
}

export async function runTrial(
  ref: FrozenTrialRef,
  options: RunTrialOptions = {},
): Promise<TrialRecord> {
  const log = options.log ?? (() => undefined);
  const { trial, cls } = ref;
  const manifest = loadManifest();
  const maxWall = manifest.defaults.trialMaxWallClockMs;
  const secret = probeSecret();
  const ownerToken = newOwnerToken();
  const startedAtMs = Date.now();

  const upstream = upstreamBaseUrl();
  if (!upstream)
    throw new BlockedError(
      'OPENAI_BASE_URL is not available (process env or NemoDots/.env); live trials need the provider configured',
    );
  if (!process.env.OPENAI_API_KEY && !hasEnvFileKey())
    throw new BlockedError(
      'OPENAI_API_KEY is not available; live Crusoe trials cannot run',
    );

  // EVERY trial goes through the verifier proxy; only provider-disruption
  // trials configure a disruption window.
  const proxy = new ProviderProxy(upstream, trial.disruption ?? null);
  await proxy.listen(G6.proxyPort);
  const expectedProviderHost = `${G6.host}:${G6.proxyPort}`;

  const record: TrialRecord = {
    trialId: trial.trialId,
    cls,
    frozen: trial,
    goalUsed: manifest.missionGoal,
    constraintsUsed: manifest.missionConstraints,
    expectedProviderHost,
    upstreamHost: new URL(upstream).host,
    startedAtMs,
    missionStartedAtMs: null,
    endedAtMs: startedAtMs,
    timedOut: false,
    runnerErrors: [],
    snapshot: null,
    snapshotAfterProbe: null,
    events: [],
    eventStream: { reconnects: 0, duplicatesDropped: 0 },
    proxyLog: null,
    modelsListing: null,
    stepApplications: [],
    triggerFires: [],
    preTrialConfig: {},
    finalConfig: {},
    configVersions: [],
    orderingBasis: 'start_time_with_harness_brackets',
    businessBefore: null,
    businessAfterReadOnly: null,
    readLoad: { requests: 0, failures: 0 },
    checkoutBefore: null,
    checkoutAfter: null,
    probe: null,
    taggedOrders: [],
    health: null,
    loadSamples: [],
    cacheAfter: null,
    lineage: null,
    redisEffects: null,
    crash: trial.crash
      ? {
          at: trial.crash.at,
          workerStartedAtMs: null,
          leaseOwnersBeforeWorker: [],
          killedAtMs: null,
          atKill: null,
          restartedAtMs: null,
          firstEventAfterRestartMs: null,
        }
      : null,
    leaks: [],
  };

  let sut: Sut | null = null;
  let db: VerifierDb | null = null;
  let applier: StepApplier | null = null;
  let collector: EventCollector | null = null;
  let load: ReadLoad | null = null;
  let redisWatch: RedisEffectWatcher | null = null;
  const timers: NodeJS.Timeout[] = [];
  try {
    sut = await Sut.start({
      trialId: trial.trialId,
      ownerToken,
      providerBaseUrl: `http://${G6.host}:${G6.proxyPort}/v1`,
      separateWorker: !!trial.crash,
    });
    const api = new NemoApi(ownerToken);
    db = await VerifierDb.connect(sut);
    const reader = await db.currentUser();
    if (!reader.startsWith('acc6_ro_'))
      record.runnerErrors.push(
        `the invariant reader runs as ${reader}, not the harness-only role`,
      );
    record.orderingBasis = db.commitTimestamps
      ? 'commit_timestamp'
      : 'start_time_with_harness_brackets';
    applier = new StepApplier(sut, api, db);
    await applier.open();
    redisWatch = await RedisEffectWatcher.start(sut.redisPrefix);

    // Pre-trial reads (reader role + plain HTTP).
    record.businessBefore = await db.snapshot();
    record.preTrialConfig = await db.configEntries();
    record.checkoutBefore = await surface(PROBE.sku);
    assertValidTrial(trial.steps, record);

    // pre_start steps, in order.
    const steps = trial.steps.map((step, index) => ({ step, index }));
    for (const { step, index } of steps.filter(
      (s) => s.step.trigger.kind === 'pre_start',
    ))
      record.stepApplications.push(await applier.apply(index, step));

    load = new ReadLoad(trial.load.readConcurrency, PROBE.sku);
    load.start();

    // Mission: neutral goal + constraints only.
    const created = await api.post<{
      id?: string;
      error?: string;
      missingEnv?: string[];
    }>('/missions', {
      goal: manifest.missionGoal,
      constraints: manifest.missionConstraints,
      mode: 'live',
      ...(trial.missionOptions?.admissionMinAgeMs !== undefined
        ? { admission: { minAgeMs: trial.missionOptions.admissionMinAgeMs } }
        : {}),
    });
    if (created.status === 503)
      throw new BlockedError(
        `POST /missions returned 503 (missing: ${(created.body.missingEnv ?? []).join(', ')})`,
      );
    if (created.status !== 201 || !created.body.id)
      throw new Error(`POST /missions returned HTTP ${created.status}`);
    const missionId = created.body.id;

    collector = new EventCollector(api, missionId);
    const fired = new Set<number>();
    const fire = (index: number, step: Step, delayMs: number) => {
      if (fired.has(index)) return;
      fired.add(index);
      if (step.trigger.kind === 'on_action_proposed')
        record.triggerFires.push({
          index,
          key: step.trigger.key,
          atMs: Date.now(),
        });
      timers.push(
        setTimeout(() => {
          applier!
            .apply(index, step)
            .then((a) => record.stepApplications.push(a))
            .catch((error: Error) =>
              record.runnerErrors.push(`step ${index}: ${error.message}`),
            );
        }, delayMs),
      );
    };
    const crashState = { done: false };
    collector.onEvent((event) => {
      const payload = payloadOf(event);
      for (const { step, index } of steps) {
        const trigger = step.trigger;
        if (
          trigger.kind === 'after_first_commit' &&
          event.kind === 'action.committed'
        )
          fire(index, step, trigger.delayMs);
        if (
          trigger.kind === 'after_first_admitted' &&
          event.kind === 'action.decided' &&
          payload.decision === 'admitted'
        )
          fire(index, step, trigger.delayMs);
      }
      if (trial.crash && !crashState.done) maybeCrash(event.kind, payload);
    });

    const readCrashState = async (): Promise<CrashStateAtKill> => {
      const running = await db!.runningAttempts(missionId);
      const snapshot = await api.get<{
        actions?: { id: string; status: string }[];
      }>(`/missions/${missionId}`);
      const outbox = await db!
        .outboxState()
        .catch(() => ({ pending: 0, claimed: 0 }));
      return {
        leaseOwners: [...new Set(running.map((a) => a.leaseOwner))],
        runningAttempts: running,
        intents: (snapshot.body?.actions ?? []).map((a) => ({
          id: a.id,
          status: a.status,
        })),
        outbox,
      };
    };

    const maybeCrash = (kind: string, payload: Record<string, unknown>) => {
      const crash = trial.crash!;
      const hit =
        (crash.at === 'after_first_admitted' &&
          kind === 'action.decided' &&
          payload.decision === 'admitted') ||
        (crash.at === 'after_first_commit' && kind === 'action.committed') ||
        (crash.at === 'after_first_specialist_model_call' &&
          kind === 'model_call.recorded' &&
          payload.role === 'worker');
      if (!hit) return;
      void (async () => {
        if (crashState.done) return;
        if (crash.at === 'after_first_specialist_model_call') {
          const tasks = await api.get<
            | { id: string; role: string }[]
            | { tasks: { id: string; role: string }[] }
          >(`/missions/${missionId}/tasks`);
          const list = Array.isArray(tasks.body)
            ? tasks.body
            : (tasks.body.tasks ?? []);
          const task = list.find((t) => t.id === payload.taskId);
          if (!task || !/specialist$/.test(task.role)) return;
        }
        if (crashState.done) return;
        crashState.done = true;
        // Lease holders and intent/outbox state at the moment of the kill, read
        // with the reader role, so the report shows what was really in flight.
        record.crash!.atKill = await readCrashState();
        record.crash!.killedAtMs = Date.now();
        await sut!.killWorker();
        await sleep(crash.restartAfterMs);
        sut!.startWorker();
        record.crash!.restartedAtMs = Date.now();
      })().catch((error: Error) =>
        record.runnerErrors.push(`crash controller: ${error.message}`),
      );
    };

    collector.start();
    // on_action_proposed: the injector's documented LISTEN path.
    const listener = applier.listener;
    await listener.query('LISTEN nemodots_action_proposed');
    listener.on('notification', (message) => {
      if (message.channel !== 'nemodots_action_proposed') return;
      for (const { step, index } of steps)
        if (
          step.trigger.kind === 'on_action_proposed' &&
          (message.payload ?? '').includes(step.trigger.key)
        )
          fire(index, step, step.trigger.delayMs);
    });

    const started = await api.post<{
      startedAt?: string | null;
      status?: string;
    }>(`/missions/${missionId}/start`);
    if (started.status !== 200)
      throw new Error(
        `POST /missions/${missionId}/start returned HTTP ${started.status}`,
      );
    record.missionStartedAtMs = started.body.startedAt
      ? Date.parse(started.body.startedAt)
      : Date.now();
    for (const { step, index } of steps)
      if (step.trigger.kind === 'at_ms') {
        const delay = Math.max(
          0,
          record.missionStartedAtMs + step.trigger.ms - Date.now(),
        );
        fire(index, step, delay);
      }

    if (trial.crash) {
      // The app must host no workers (NEMODOTS_WORKERS=0). Prove it: with the
      // mission started and no separate worker yet, nothing may hold a lease.
      await sleep(4000);
      record.crash!.leaseOwnersBeforeWorker = [
        ...new Set(
          (await db.runningAttempts(missionId)).map((a) => a.leaseOwner),
        ),
      ];
      sut.startWorker();
      record.crash!.workerStartedAtMs = Date.now();
    }

    // Wait for the mission to end (or the wall-clock limit).
    const deadline = startedAtMs + maxWall;
    let blockedSince: number | null = null;
    for (;;) {
      const status = await api.get<{ mission?: { status?: string } }>(
        `/missions/${missionId}`,
      );
      const missionStatus = status.body?.mission?.status;
      if (missionStatus && TERMINAL.has(missionStatus)) break;
      if (missionStatus === 'blocked_provider') {
        blockedSince ??= Date.now();
        const disruptionOver =
          !trial.disruption ||
          !proxy.log.some(
            (e) => e.disposition !== 'forwarded' && Date.now() - e.at < 130_000,
          );
        if (disruptionOver && Date.now() - blockedSince > 130_000) break;
      } else blockedSince = null;
      if (Date.now() > deadline) {
        record.timedOut = true;
        await api.post(`/missions/${missionId}/cancel`).catch(() => undefined);
        await sleep(2000);
        break;
      }
      await sleep(2000);
    }
    for (const timer of timers) clearTimeout(timer);
    await sleep(1500); // let in-flight step applications and final events land
    await load.stop();
    record.readLoad = { requests: load.requests, failures: load.failures };
    await collector.stop();

    record.snapshot = await readSnapshot(api, missionId, record);
    record.businessAfterReadOnly = await db.snapshot();

    // Verifier probe: one fresh order, read back twice.
    record.probe = await verifierProbe(db, trial.probe.quantity);
    record.checkoutAfter = await surface(PROBE.sku);

    // Health window and declared load samples.
    const windowMs = trial.probe.windowMs ?? manifest.defaults.probeWindowMs;
    record.health = {
      windowMs,
      samples: await sampleHealthWindow(windowMs, PROBE.sampleIntervalMs),
    };
    for (const [predicateIndex, predicate] of (
      trial.expected?.keyPredicates ?? []
    ).entries())
      if ('kind' in predicate && predicate.kind === 'load_sample')
        record.loadSamples.push({
          predicateIndex,
          result: await loadSample(
            predicate.requests,
            predicate.concurrency,
            PROBE.sku,
          ),
        });

    record.finalConfig = await db.configEntries();
    record.configVersions = await db.configVersions();
    record.taggedOrders = await db.taggedOrders();
    record.lineage = await db.lineage(missionId);
    const ns = record.finalConfig['cache.namespace']?.value;
    const schema = record.finalConfig['cache.schema_version']?.value;
    if (typeof ns === 'string' && typeof schema === 'number') {
      const blobs = await staleCacheBlobs(sut.redisPrefix, ns, schema).catch(
        () => null,
      );
      if (blobs) record.cacheAfter = { namespace: ns, schema, ...blobs };
    }

    // Wait for the watcher to see the probe order, then re-read.
    await sleep(6000);
    record.snapshotAfterProbe = await readSnapshot(api, missionId, record);
    record.events = collector.events.map((event): RecordedEvent => ({
      id: event.id,
      kind: event.kind,
      receivedAt: event.receivedAt,
      payload: payloadOf(event),
    }));
    record.eventStream = {
      reconnects: collector.reconnects,
      duplicatesDropped: collector.duplicatesDropped,
    };
    record.redisEffects = await redisWatch.stop();
    redisWatch = null;

    // Which models were requested, and does the upstream list them?
    const requested = new Set<string>();
    for (const event of record.events)
      if (event.kind === 'model_call.recorded') {
        const model = (event.payload.model as { requested?: string })
          ?.requested;
        if (model) requested.add(model);
      }
    for (const name of [
      record.snapshot?.mission.provider.plannerModel,
      record.snapshot?.mission.provider.workerModel,
    ])
      if (typeof name === 'string' && name) requested.add(name);
    record.modelsListing = await proxy.checkModels([...requested]);

    // Crash resume time: first worker progress or recovery after the restart.
    if (record.crash?.restartedAtMs)
      record.crash.firstEventAfterRestartMs =
        record.events.find(
          (e) =>
            e.receivedAt > record.crash!.restartedAtMs! &&
            ((WORKER_PROGRESS_KINDS as readonly string[]).includes(e.kind) ||
              e.kind === 'recovery.recorded'),
        )?.receivedAt ?? null;

    // Held-out leak scan over everything the runtime emitted.
    const health = await api.get('/health');
    const telemetry = await api.get(
      `/telemetry/summary?missionId=${missionId}`,
    );
    const corpus = [
      JSON.stringify(record.snapshotAfterProbe),
      JSON.stringify(record.events),
      health.text,
      telemetry.text,
    ].join('\n');
    const urls = [
      ...Object.values(ROLE_ENV)
        .map((name) => process.env[name] ?? '')
        .filter(Boolean),
      sut.readerUrl,
    ];
    record.leaks = scanLeaks(
      corpus,
      leakTokens(ref, secret, urls),
      secret,
      urls,
    );
    if (record.snapshot?.mission.goal !== manifest.missionGoal)
      record.leaks.push('mission goal differs from the neutral manifest goal');
  } catch (error) {
    if (
      error instanceof BlockedError ||
      error instanceof EntryPointMissingError
    )
      throw error;
    record.runnerErrors.push((error as Error).message);
    throw error;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await load?.stop().catch(() => undefined);
    await collector?.stop().catch(() => undefined);
    if (redisWatch) {
      record.redisEffects = await redisWatch.stop().catch(() => null);
    }
    await applier?.close();
    await db?.close().catch(() => undefined);
    record.proxyLog = [...proxy.log];
    await proxy.close();
    await sut?.stop();
    record.endedAtMs = Date.now();
  }
  log(
    `trial ${trial.trialId} finished in ${record.endedAtMs - startedAtMs} ms`,
  );
  return record;
}

function hasEnvFileKey(): boolean {
  // Presence check only; the value is never read into this process.
  try {
    const text = readFileSync(
      new URL('../../../../../.env', import.meta.url),
      'utf8',
    );
    return /^\s*OPENAI_API_KEY\s*=\s*\S+/m.test(text);
  } catch {
    return false;
  }
}

function assertValidTrial(steps: Step[], record: TrialRecord) {
  const current = new Map<string, unknown>();
  for (const step of steps) {
    const base = current.has(step.key)
      ? current.get(step.key)
      : record.preTrialConfig[step.key]?.value;
    if (
      !current.has(step.key) &&
      JSON.stringify(base) === JSON.stringify(step.value)
    )
      throw new BlockedError(
        `invalidTrial ${record.trialId}: an injected value equals the pre-trial value of ${step.key} (not scored)`,
      );
    current.set(step.key, step.value);
  }
}

async function readSnapshot(
  api: NemoApi,
  missionId: string,
  record: TrialRecord,
) {
  const response = await api.get(`/missions/${missionId}`);
  if (response.status !== 200) {
    record.runnerErrors.push(
      `GET /missions/${missionId} returned HTTP ${response.status}`,
    );
    return null;
  }
  const parsed = MissionSnapshotSchema.safeParse(response.body);
  if (!parsed.success) {
    record.runnerErrors.push(
      `mission snapshot violates the public contract: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
    );
    return response.body as never;
  }
  return parsed.data;
}

/**
 * Probe tag header per ARCHITECTURE 9.5 as implemented by the checkout API:
 * `<runId>.<hex HMAC-SHA256(NEMODOTS_PROBE_SECRET, "probe-run:" + runId)>`.
 * Computed here from the shared secret, not imported from production.
 */
export function probeHeader(runId: string): string {
  const mac = createHmac('sha256', probeSecret())
    .update(`probe-run:${runId}`)
    .digest('hex');
  return `${runId}.${mac}`;
}

export async function verifierProbe(
  db: VerifierDb,
  quantity: number,
): Promise<ProbeRecord> {
  const runId = `acc6-${randomBytes(6).toString('hex')}`;
  const inventoryBefore = await db.inventoryQuantity(PROBE.sku);
  const rowCountsBefore = await db.rowCounts();
  const normalizedBefore = await db.normalizedValues();
  const create = await checkoutRequest('POST', '/orders', {
    body: { items: [{ sku: PROBE.sku, quantity }] },
    headers: {
      [PROBE.header]: probeHeader(runId),
    },
  }).catch((error: Error) => ({
    status: 0,
    body: { error: error.message },
    text: '',
  }));
  const tagged = await db.ordersByProbeRun(runId);
  const body = create.body as { id?: unknown; orderId?: unknown } | null;
  const orderId =
    body?.id !== undefined
      ? String(body.id)
      : body?.orderId !== undefined
        ? String(body.orderId)
        : tagged.orders[0]?.id !== undefined
          ? String(tagged.orders[0].id)
          : null;
  const reads: { status: number; body: unknown }[] = [];
  if (orderId)
    for (let n = 0; n < 2; n += 1) {
      const read = await checkoutRequest('GET', `/orders/${orderId}`).catch(
        () => ({
          status: 0,
          body: null,
          text: '',
        }),
      );
      reads.push({ status: read.status, body: read.body });
    }
  return {
    runId,
    sku: PROBE.sku,
    quantity,
    inventoryBefore,
    inventoryAfter: await db.inventoryQuantity(PROBE.sku),
    rowCountsBefore,
    rowCountsAfter: await db.rowCounts(),
    taggedOrders: tagged.orders,
    taggedItems: tagged.items,
    create: { status: create.status, body: create.body },
    orderId,
    reads,
    businessAfter: await db.snapshot().catch(() => null),
    normalized: {
      before: normalizedBefore,
      after: await db.normalizedValues(),
    },
  };
}
