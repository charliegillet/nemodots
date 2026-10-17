// The per-trial evidence record the runner exports and the scorer consumes.
// Everything is observed from outside the system under test: public API,
// SSE, the checkout HTTP surface, harness-only read-only SQL, the verifier's
// pass-through provider proxy and a verifier Redis keyspace subscriber.
import type {
  ActionIntent,
  Authorization,
  InvalidationEvent,
  MissionSnapshot,
  ObservationReceipt,
  ResultReceipt,
  TaskAttempt,
} from '../../../../../src/server/nemodots/contracts/index.js';
import type { BusinessSnapshot } from '../../driver/business-hash.js';
import type { FrozenTrial, Step } from './frozen.js';
import type { HealthSample, LoadSampleResult } from './http.js';
import type { ModelsListing, ProxyLogEntry } from './provider-proxy.js';
import type { ConfigEntry, ConfigVersionRow } from './verifier-db.js';

export interface StepApplication {
  index: number;
  step: Step;
  appliedAtMs: number;
  /** wall clock just before / after the COMMIT (injector) or request (owner) */
  commitStartMs?: number;
  commitEndMs?: number;
  versionBefore: number | null;
  versionAfter: number | null;
  valueAfter: unknown;
  ok: boolean;
  error?: string;
}

/** One firing of an on_action_proposed trigger (NOTIFY nemodots_action_proposed). */
export interface TriggerFire {
  index: number;
  key: string;
  atMs: number;
}

export interface RecordedEvent {
  id: number;
  kind: string;
  receivedAt: number;
  payload: Record<string, unknown>;
}

export interface CheckoutProbeSurface {
  health: { status: number; health: string | null };
  ready: { status: number };
  products: { status: number; count: number | null };
  inventory: { status: number; quantity: number | null };
}

/** Evidence values as the verifier computes them (probe rows excluded). */
export interface NormalizedValues {
  ordersRecentDigest: string;
  inventory: Record<string, number>;
}

export interface ProbeRecord {
  runId: string;
  sku: string;
  quantity: number;
  inventoryBefore: number | null;
  inventoryAfter: number | null;
  rowCountsBefore: Record<string, number>;
  rowCountsAfter: Record<string, number>;
  /** orders tagged with the verifier run id, read with the reader role */
  taggedOrders: Record<string, unknown>[];
  taggedItems: { order_id: string; sku: string; quantity: number }[];
  create: { status: number; body: unknown };
  orderId: string | null;
  reads: { status: number; body: unknown }[];
  businessAfter: BusinessSnapshot | null;
  normalized: { before: NormalizedValues; after: NormalizedValues } | null;
}

/** Every probe-tagged order found in the trial database at the end of the trial. */
export interface TaggedOrder {
  id: string;
  probeRunId: string;
  items: { sku: string; quantity: number }[];
}

export interface LineageCall {
  id: string;
  taskId: string;
  attemptId: string;
  createdAtMs: number;
  /** the dependency vector of the call's recorded context snapshot */
  contextVector: { sourceKey: string; sourceRevision: number; receiptId: string }[];
  outputVector: { sourceKey: string; sourceRevision: number; receiptId: string }[];
}

export interface CrashStateAtKill {
  leaseOwners: string[];
  runningAttempts: {
    id: string;
    taskId: string;
    leaseOwner: string;
    fencingToken: number;
  }[];
  intents: { id: string; status: string }[];
  outbox: { pending: number; claimed: number };
}

export interface CrashRecord {
  at: string;
  workerStartedAtMs: number | null;
  /** lease holders read before the separate worker was started (must be empty) */
  leaseOwnersBeforeWorker: string[];
  killedAtMs: number | null;
  atKill: CrashStateAtKill | null;
  restartedAtMs: number | null;
  firstEventAfterRestartMs: number | null;
}

export interface RedisEffects {
  /** false when keyspace notifications could not be enabled (BLOCKED) */
  available: boolean;
  reason: string | null;
  /** number of `set` keyspace events on <prefix>:effect:<actionId> */
  markerSets: Record<string, number>;
  /** number of `set` keyspace events on <prefix>:fence:* */
  fenceSets: number;
  /** informational: `del` events on cache keys (not scored per action) */
  cacheDeletes: number;
  totalEvents: number;
}

export interface TrialRecord {
  trialId: string;
  cls: string;
  frozen: FrozenTrial;
  goalUsed: string;
  constraintsUsed: string[];
  /** host:port the app was configured with (always the verifier proxy) */
  expectedProviderHost: string;
  /** host:port of the real upstream the proxy forwards to */
  upstreamHost: string;
  startedAtMs: number;
  missionStartedAtMs: number | null;
  endedAtMs: number;
  timedOut: boolean;
  /** Harness-level failure that prevented a clean run (reported, never hidden). */
  runnerErrors: string[];

  snapshot: MissionSnapshot | null;
  /** snapshot re-read after the verifier probe, to catch probe-caused invalidations */
  snapshotAfterProbe: MissionSnapshot | null;
  events: RecordedEvent[];
  eventStream: { reconnects: number; duplicatesDropped: number };
  proxyLog: ProxyLogEntry[] | null;
  modelsListing: ModelsListing | null;
  stepApplications: StepApplication[];
  triggerFires: TriggerFire[];

  preTrialConfig: Record<string, ConfigEntry>;
  finalConfig: Record<string, ConfigEntry>;
  configVersions: ConfigVersionRow[];
  /** how config_versions rows can be ordered across keys */
  orderingBasis: 'commit_timestamp' | 'start_time_with_harness_brackets';

  businessBefore: BusinessSnapshot | null;
  businessAfterReadOnly: BusinessSnapshot | null;
  readLoad: { requests: number; failures: number };

  checkoutBefore: CheckoutProbeSurface | null;
  checkoutAfter: CheckoutProbeSurface | null;
  probe: ProbeRecord | null;
  taggedOrders: TaggedOrder[];
  health: { windowMs: number; samples: HealthSample[] } | null;
  loadSamples: { predicateIndex: number; result: LoadSampleResult }[];
  cacheAfter: {
    namespace: string;
    schema: number;
    total: number;
    stale: number;
  } | null;

  /** model-call context records read with the reader role (independent of the system's closure) */
  lineage: LineageCall[] | null;
  redisEffects: RedisEffects | null;

  crash: CrashRecord | null;
  leaks: string[];
}

export type Snapshot = MissionSnapshot;
export type Intent = ActionIntent;
export type Auth = Authorization;
export type Result = ResultReceipt;
export type Invalidation = InvalidationEvent;
export type Attempt = TaskAttempt;
export type Receipt = ObservationReceipt;
