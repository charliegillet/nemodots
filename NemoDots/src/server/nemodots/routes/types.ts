import type {
  CheckoutHealthResponse,
  EvalsReportResponse,
  HealthStatus,
  Mission,
  MissionControlPort,
  MissionEvent,
  MissionId,
  TelemetrySummary,
} from '../contracts/index.js';
import type { ModeResolution } from '../inference/mode.js';
import type { AdvanceConfigResult } from '../sandbox/version-authority.js';
import type { OwnerEdit } from '../watcher/manual.js';

/** The slice of a pg pool the routes use (a real pg.Pool satisfies it). */
export interface QueryablePool {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface EventNotification {
  missionId: string;
  id: number;
}

/** Wakes SSE streams early; the poll keeps them correct if it is absent or drops. */
export interface EventNotifier {
  subscribe(handler: (message: EventNotification) => void): Promise<() => void>;
}

export interface NemodotsRouteDeps {
  /**
   * The authenticated owner. It comes from the server context (the same single
   * owner OpenDots authenticates), never from a request body, header or query.
   */
  ownerId: string;
  pool: QueryablePool;
  control: MissionControlPort & { get(missionId: MissionId): Promise<Mission> };
  events: {
    replay(
      missionId: MissionId,
      afterId: number,
      limit?: number,
    ): Promise<MissionEvent[]>;
  };
  notifier?: EventNotifier;
  /** Server-resolved inference mode (resolveMode). */
  mode: () => ModeResolution;
  /** Owner edit of a controlled source (watcher/manual.ts ownerEdit). */
  ownerEdit: (
    edit: OwnerEdit,
  ) => Promise<{ change: Pick<AdvanceConfigResult, 'key' | 'versionAfter'> }>;
  /** Starts an injector scenario of the named class; returns only its run id. */
  startInjector: (scenarioClass: string) => Promise<{ runId: string }>;
  /** The checkout /health body; routes validate it and never forward raw bodies. */
  checkoutHealth: () => Promise<unknown>;
  telemetry?: (missionId?: MissionId) => Promise<TelemetrySummary>;
  evalsReport?: () => Promise<unknown>;
  health?: {
    provider?: () => Promise<{
      reachable: boolean;
      modelListed: boolean;
      checkedAt: string | null;
    }>;
    redis?: () => Promise<'ok' | 'down'>;
    checkout?: () => Promise<HealthStatus['checkout']>;
    intelligenceConfigured?: () => boolean;
    incidentDotIds?: () => number;
  };
  sse?: { pollMs?: number; heartbeatMs?: number; batch?: number };
  /** Called for an event whose payload failed validation (it is never written). */
  onInvalidEvent?: (info: {
    missionId: string;
    id: number;
    kind: string;
  }) => void;
}

export type { CheckoutHealthResponse, EvalsReportResponse };
