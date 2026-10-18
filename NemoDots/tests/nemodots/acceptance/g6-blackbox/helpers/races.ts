// Harness for the app-level rare-race adapter scenarios (G6.10). A scenario
// runs one real mission through the OpenDots app (live inference, because the
// team has to author the intent) and then forces ONE interleaving that the
// autonomous trials cannot hit on purpose:
//   - a barrier inside the action commit path, controlled from outside through
//     files (HookDir),
//   - a SIGKILL of the app at a barrier followed by a restart,
//   - a Redis reply that is dropped after the effect was applied
//     (LossyRedisProxy),
//   - a SIGSTOP/SIGCONT zombie worker whose lease expired.
// Each scenario returns evidence; the same scenario is then repeated against a
// build started with NEMODOTS_MUTATION=<name> and must FAIL.
//
// Production entry points these scenarios depend on (recorded as
// dependencies; none exists yet):
//   - src/server/nemodots/actions/test-hooks.ts: with NEMODOTS_TEST_HOOKS=1 and
//     NEMODOTS_TEST_HOOK_DIR=<dir> a process reaching barrier <point> writes
//     <dir>/<point>.arrived (JSON {"pid":n,"actionId":"..."}) and then blocks,
//     polling every 20 ms, until <dir>/<point>.release exists. A barrier whose
//     .release file already exists is passed without parking. Points:
//     after_preliminary_read, before_lock, after_lock_before_commit,
//     after_commit_before_dispatch, after_effect_before_record.
//   - NEMODOTS_LEASE_MS shortens the attempt lease (zombie-worker scenario).
//   - NEMODOTS_MUTATION=<name> selects the gate-8 mutation build.
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { MissionSnapshotSchema } from '../../../../../src/server/nemodots/contracts/index.js';
import {
  BlockedError,
  G6,
  SCRATCH,
  newOwnerToken,
  redisBaseUrl,
  upstreamBaseUrl,
} from './config.js';
import { loadManifest, type FrozenTrial, type Step } from './frozen.js';
import { EventCollector, NemoApi, payloadOf, sleep } from './http.js';
import { ProviderProxy } from './provider-proxy.js';
import type { TrialRecord } from './record.js';
import { scoreInvariants, scoreSafety } from './scoring.js';
import { Sut, assertEntryFiles } from './sut.js';
import { StepApplier } from './trial.js';
import { RedisEffectWatcher, VerifierDb } from './verifier-db.js';

export const HOOK_POINTS = [
  'after_preliminary_read',
  'before_lock',
  'after_lock_before_commit',
  'after_commit_before_dispatch',
  'after_effect_before_record',
] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false | null>,
  timeoutMs: number,
  label: string,
  intervalMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/** File-based barrier control shared with the app process. */
export class HookDir {
  readonly dir: string;
  constructor(name: string) {
    this.dir = resolve(SCRATCH, 'hooks', name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
  private file(point: HookPoint, kind: 'arrived' | 'release') {
    return resolve(this.dir, `${point}.${kind}`);
  }
  hasArrived(point: HookPoint) {
    return existsSync(this.file(point, 'arrived'));
  }
  async arrived(
    point: HookPoint,
    timeoutMs: number,
  ): Promise<{ pid: number | null; actionId: string | null }> {
    await waitFor(
      async () => this.hasArrived(point),
      timeoutMs,
      `barrier ${point}`,
      50,
    );
    try {
      const body = JSON.parse(
        readFileSync(this.file(point, 'arrived'), 'utf8'),
      ) as { pid?: number; actionId?: string };
      return { pid: body.pid ?? null, actionId: body.actionId ?? null };
    } catch {
      return { pid: null, actionId: null };
    }
  }
  release(point: HookPoint) {
    writeFileSync(this.file(point, 'release'), '1');
  }
  releaseAll() {
    for (const point of HOOK_POINTS) this.release(point);
  }
}

/**
 * A TCP proxy in front of the trial's Redis that forwards everything and, once
 * armed, applies one command whose bytes contain `pattern` and then drops the
 * connection instead of delivering the reply: the effect happened, the caller
 * never learns it.
 */
export class LossyRedisProxy {
  drops = 0;
  private pattern: string | null = null;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  constructor(private readonly upstream: { host: string; port: number }) {}

  arm(pattern: string) {
    this.pattern = pattern;
  }

  async listen(port: number) {
    this.server = net.createServer((client) => {
      const up = net.connect(this.upstream.port, this.upstream.host);
      this.sockets.add(client).add(up);
      let dropReply = false;
      client.on('data', (chunk) => {
        if (this.pattern && chunk.toString('latin1').includes(this.pattern)) {
          this.pattern = null;
          dropReply = true;
          this.drops += 1;
        }
        up.write(chunk);
      });
      up.on('data', (chunk) => {
        if (dropReply) {
          dropReply = false;
          client.destroy();
          up.destroy();
          return;
        }
        client.write(chunk);
      });
      const close = () => {
        client.destroy();
        up.destroy();
      };
      client.on('error', close);
      up.on('error', close);
      client.on('close', close);
      up.on('close', close);
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, G6.host, () => resolveListen());
    });
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}

export interface RaceOptions {
  name: string;
  /** pre_start faults applied through the injector before the mission starts */
  steps?: Step[];
  allowedKeys: string[];
  flushAllowed?: boolean;
  mutation?: string;
  hooks?: boolean;
  separateWorker?: boolean;
  leaseMs?: number;
  lossyRedis?: boolean;
}

export interface RaceEnv {
  sut: Sut;
  api: NemoApi;
  db: VerifierDb;
  applier: StepApplier;
  hooks: HookDir | null;
  redisProxy: LossyRedisProxy | null;
  redisWatch: RedisEffectWatcher;
  missionId: string;
  collector: EventCollector;
  preTrialConfig: TrialRecord['preTrialConfig'];
  /** wait for the mission to reach a terminal state (or time out) */
  finish(timeoutMs: number): Promise<void>;
  /** evidence in the shape the scorer consumes */
  record(): Promise<TrialRecord>;
}

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'blocked_provider'];

export async function withRace<T>(
  options: RaceOptions,
  fn: (env: RaceEnv) => Promise<T>,
): Promise<T> {
  assertEntryFiles([
    'appServer',
    'bootstrap',
    ...(options.hooks ? (['testHooks'] as const) : []),
    ...(options.separateWorker ? (['workerMain'] as const) : []),
  ]);
  const upstream = upstreamBaseUrl();
  if (!upstream)
    throw new BlockedError(
      'OPENAI_BASE_URL is not available; race scenarios need a live mission',
    );
  const manifest = loadManifest();
  const ownerToken = newOwnerToken();
  const proxy = new ProviderProxy(upstream, null);
  await proxy.listen(G6.proxyPort);
  let redisProxy: LossyRedisProxy | null = null;
  let sut: Sut | null = null;
  let db: VerifierDb | null = null;
  let applier: StepApplier | null = null;
  let collector: EventCollector | null = null;
  let redisWatch: RedisEffectWatcher | null = null;
  const hooks = options.hooks ? new HookDir(options.name) : null;
  const redisPort = 4723;
  try {
    if (options.lossyRedis) {
      const base = new URL(redisBaseUrl());
      redisProxy = new LossyRedisProxy({
        host: base.hostname,
        port: Number(base.port || 6379),
      });
      await redisProxy.listen(redisPort);
    }
    const redisUrl = new URL(redisBaseUrl());
    redisUrl.port = String(redisPort);
    redisUrl.pathname = `/${G6.redisDb}`;
    sut = await Sut.start({
      trialId: `race-${options.name}`,
      ownerToken,
      providerBaseUrl: `http://${G6.host}:${G6.proxyPort}/v1`,
      separateWorker: !!options.separateWorker,
      extraEnv: {
        ...(hooks
          ? { NEMODOTS_TEST_HOOKS: '1', NEMODOTS_TEST_HOOK_DIR: hooks.dir }
          : {}),
        ...(options.mutation ? { NEMODOTS_MUTATION: options.mutation } : {}),
        ...(options.leaseMs
          ? { NEMODOTS_LEASE_MS: String(options.leaseMs) }
          : {}),
      },
      ...(options.lossyRedis ? { appRedisUrl: redisUrl.toString() } : {}),
    });
    const api = new NemoApi(ownerToken);
    db = await VerifierDb.connect(sut);
    applier = new StepApplier(sut, api, db);
    await applier.open();
    redisWatch = await RedisEffectWatcher.start(sut.redisPrefix);
    const preTrialConfig = await db.configEntries();
    const stepApplications: TrialRecord['stepApplications'] = [];
    for (const [index, step] of (options.steps ?? []).entries())
      stepApplications.push(await applier.apply(index, step));

    const created = await api.post<{ id?: string; missingEnv?: string[] }>(
      '/missions',
      {
        goal: manifest.missionGoal,
        constraints: manifest.missionConstraints,
        mode: 'live',
        admission: { minAgeMs: 0 },
      },
    );
    if (created.status === 503)
      throw new BlockedError(
        `POST /missions returned 503 (missing: ${(created.body.missingEnv ?? []).join(', ')})`,
      );
    if (created.status !== 201 || !created.body.id)
      throw new Error(`POST /missions returned HTTP ${created.status}`);
    const missionId = created.body.id;
    collector = new EventCollector(api, missionId);
    collector.start();
    const started = await api.post(`/missions/${missionId}/start`);
    if (started.status !== 200)
      throw new Error(`start returned HTTP ${started.status}`);

    const frozen: FrozenTrial = {
      trialId: `race-${options.name}`,
      seed: 0,
      steps: options.steps ?? [],
      load: { readConcurrency: 0 },
      probe: { quantity: 1, windowMs: 0 },
      expected: {
        allowedMutationKeys: options.allowedKeys,
        flushAllowed: options.flushAllowed ?? false,
        keyPredicates: [],
      },
    };
    const db_ = db;
    const sut_ = sut;
    const collector_ = collector;
    const watch_ = redisWatch;
    const env: RaceEnv = {
      sut: sut_,
      api,
      db: db_,
      applier,
      hooks,
      redisProxy,
      redisWatch: watch_,
      missionId,
      collector: collector_,
      preTrialConfig,
      async finish(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const status = await api.get<{ mission?: { status?: string } }>(
            `/missions/${missionId}`,
          );
          if (TERMINAL.includes(status.body?.mission?.status ?? '')) return;
          if (Date.now() > deadline) return;
          await sleep(1500);
        }
      },
      async record() {
        const response = await api.get(`/missions/${missionId}`);
        const parsed = MissionSnapshotSchema.safeParse(response.body);
        const snapshot = (
          parsed.success ? parsed.data : response.body
        ) as TrialRecord['snapshot'];
        const events = collector_.events.map((event) => ({
          id: event.id,
          kind: event.kind,
          receivedAt: event.receivedAt,
          payload: payloadOf(event),
        }));
        const record: TrialRecord = {
          trialId: frozen.trialId,
          cls: 'adapter_race',
          frozen,
          goalUsed: manifest.missionGoal,
          constraintsUsed: manifest.missionConstraints,
          expectedProviderHost: `${G6.host}:${G6.proxyPort}`,
          upstreamHost: new URL(upstream).host,
          startedAtMs: Date.now(),
          missionStartedAtMs: null,
          endedAtMs: Date.now(),
          timedOut: false,
          runnerErrors: [],
          snapshot,
          snapshotAfterProbe: snapshot,
          events,
          eventStream: { reconnects: 0, duplicatesDropped: 0 },
          proxyLog: [...proxy.log],
          modelsListing: null,
          stepApplications,
          triggerFires: [],
          preTrialConfig,
          finalConfig: await db_.configEntries(),
          configVersions: await db_.configVersions(),
          orderingBasis: db_.commitTimestamps
            ? 'commit_timestamp'
            : 'start_time_with_harness_brackets',
          businessBefore: null,
          businessAfterReadOnly: null,
          readLoad: { requests: 0, failures: 0 },
          checkoutBefore: null,
          checkoutAfter: null,
          probe: null,
          taggedOrders: await db_.taggedOrders(),
          health: null,
          loadSamples: [],
          cacheAfter: null,
          lineage: await db_.lineage(missionId),
          redisEffects: watch_.peek(),
          crash: null,
          leaks: [],
        };
        return record;
      },
    };
    return await fn(env);
  } finally {
    hooks?.releaseAll();
    await collector?.stop().catch(() => undefined);
    await redisWatch?.stop().catch(() => undefined);
    await applier?.close();
    await db?.close().catch(() => undefined);
    await redisProxy?.close().catch(() => undefined);
    await proxy.close();
    await sut?.stop();
  }
}

/**
 * The safety findings a race may produce, flattened. Provider, business-hash
 * and probe findings are excluded: a race scenario runs no verifier probe and
 * its inference provenance is covered by the autonomous trials.
 */
export function raceViolations(record: TrialRecord): string[] {
  const details = scoreSafety(record).details;
  const keys = [
    'staleControlledCommits',
    'unsafeActions',
    'mutationsOutsideAllowedKeys',
    'duplicateExternalEffects',
    'commitsUnderObsoleteFence',
    'irreversibleEffectsShownUndone',
    'resurrectedReceipts',
  ];
  const out = keys.flatMap((key) => details[key].map((d) => `${key}: ${d}`));
  const inv = scoreInvariants(record);
  for (const id of ['INV-6', 'INV-7'])
    if (!inv[id].ok && !out.some((d) => d.includes(inv[id].detail)))
      out.push(`${id}: ${inv[id].detail}`);
  return [...new Set(out)];
}
