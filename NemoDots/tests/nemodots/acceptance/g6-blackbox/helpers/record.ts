// The per-trial evidence record the runner exports and the scorer consumes.
// Everything is observed from outside the system under test: public API,
// SSE, the checkout HTTP surface, verifier-role SQL and Redis read-back.
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
import type { ProxyLogEntry } from './provider-proxy.js';
import type { ConfigEntry, ConfigVersionRow } from './verifier-db.js';

export interface StepApplication {
  index: number;
  step: Step;
  appliedAtMs: number;
  versionBefore: number | null;
  versionAfter: number | null;
  valueAfter: unknown;
  ok: boolean;
  error?: string;
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

export interface ProbeRecord {
  runId: string;
  sku: string;
  quantity: number;
  inventoryBefore: number | null;
  inventoryAfter: number | null;
  rowCountsBefore: Record<string, number>;
  rowCountsAfter: Record<string, number>;
  /** orders tagged with the verifier run id, read with the verifier role */
  taggedOrders: Record<string, unknown>[];
  taggedItems: { order_id: string; sku: string; quantity: number }[];
  create: { status: number; body: unknown };
  orderId: string | null;
  reads: { status: number; body: unknown }[];
  businessAfter: BusinessSnapshot | null;
}

export interface CrashRecord {
  at: string;
  killedAtMs: number | null;
  restartedAtMs: number | null;
  firstEventAfterRestartMs: number | null;
}

export interface TrialRecord {
  trialId: string;
  cls: string;
  frozen: FrozenTrial;
  goalUsed: string;
  constraintsUsed: string[];
  expectedProviderHost: string;
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
  stepApplications: StepApplication[];

  preTrialConfig: Record<string, ConfigEntry>;
  finalConfig: Record<string, ConfigEntry>;
  configVersions: ConfigVersionRow[];

  businessBefore: BusinessSnapshot | null;
  businessAfterReadOnly: BusinessSnapshot | null;
  readLoad: { requests: number; failures: number };

  checkoutBefore: CheckoutProbeSurface | null;
  checkoutAfter: CheckoutProbeSurface | null;
  probe: ProbeRecord | null;
  health: { windowMs: number; samples: HealthSample[] } | null;
  loadSamples: { predicateIndex: number; result: LoadSampleResult }[];
  cacheAfter: {
    namespace: string;
    schema: number;
    total: number;
    stale: number;
  } | null;

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
