import type {
  ActionIntent,
  CheckoutHealthResponse,
  CreateMissionRequest,
  EvalsReportResponse,
  HealthStatus,
  InjectorRunRequest,
  InjectorRunResponse,
  Mission,
  MissionLifecycleAction,
  MissionSnapshot,
  ObservationReceipt,
  RecoveryEvent,
  SourceEditRequest,
  SourceEditResponse,
  Task,
  TelemetrySummary,
} from '../../server/nemodots/contracts/index.js';
import { api } from '../api';

// Typed wrappers over api() for every route in CONTRACTS.md section 9.
// api() prefixes `/api`, adds the bearer token and throws ApiError for non-2xx
// responses (including the 503 `{ error, missingEnv }` blocked response). The
// SSE route GET /missions/:id/events is read by mission-stream.ts instead.

const ROOT = '/nemodots';
const mission = (id: string) => `${ROOT}/missions/${encodeURIComponent(id)}`;

export const getHealth = (signal?: AbortSignal) =>
  api<HealthStatus>(`${ROOT}/health`, 'GET', undefined, signal);

export const createMission = (
  request: CreateMissionRequest,
  signal?: AbortSignal,
) => api<Mission>(`${ROOT}/missions`, 'POST', request, signal);

export const listMissions = (signal?: AbortSignal) =>
  api<Mission[]>(`${ROOT}/missions`, 'GET', undefined, signal);

export const getMissionSnapshot = (id: string, signal?: AbortSignal) =>
  api<MissionSnapshot>(mission(id), 'GET', undefined, signal);

export const runMissionLifecycle = (
  id: string,
  action: MissionLifecycleAction,
  signal?: AbortSignal,
) => api<Mission>(`${mission(id)}/${action}`, 'POST', {}, signal);

export const startMission = (id: string, signal?: AbortSignal) =>
  runMissionLifecycle(id, 'start', signal);
export const pauseMission = (id: string, signal?: AbortSignal) =>
  runMissionLifecycle(id, 'pause', signal);
export const resumeMission = (id: string, signal?: AbortSignal) =>
  runMissionLifecycle(id, 'resume', signal);
export const cancelMission = (id: string, signal?: AbortSignal) =>
  runMissionLifecycle(id, 'cancel', signal);

export const getMissionTasks = (id: string, signal?: AbortSignal) =>
  api<Task[]>(`${mission(id)}/tasks`, 'GET', undefined, signal);

export const getMissionEvidence = (id: string, signal?: AbortSignal) =>
  api<ObservationReceipt[]>(
    `${mission(id)}/evidence`,
    'GET',
    undefined,
    signal,
  );

export const getMissionActions = (id: string, signal?: AbortSignal) =>
  api<ActionIntent[]>(`${mission(id)}/actions`, 'GET', undefined, signal);

export const getMissionRecovery = (id: string, signal?: AbortSignal) =>
  api<RecoveryEvent[]>(`${mission(id)}/recovery`, 'GET', undefined, signal);

export const getMissionTelemetry = (id: string, signal?: AbortSignal) =>
  api<TelemetrySummary>(`${mission(id)}/telemetry`, 'GET', undefined, signal);

export const editSource = (
  key: string,
  request: SourceEditRequest,
  signal?: AbortSignal,
) =>
  api<SourceEditResponse>(
    `${ROOT}/sandbox/sources/${encodeURIComponent(key)}`,
    'POST',
    request,
    signal,
  );

export const runInjector = (
  request: InjectorRunRequest,
  signal?: AbortSignal,
) =>
  api<InjectorRunResponse>(
    `${ROOT}/sandbox/injector/run`,
    'POST',
    request,
    signal,
  );

export const getCheckoutHealth = (signal?: AbortSignal) =>
  api<CheckoutHealthResponse>(
    `${ROOT}/sandbox/checkout/health`,
    'GET',
    undefined,
    signal,
  );

export const getTelemetrySummary = (missionId?: string, signal?: AbortSignal) =>
  api<TelemetrySummary>(
    `${ROOT}/telemetry/summary${
      missionId ? `?missionId=${encodeURIComponent(missionId)}` : ''
    }`,
    'GET',
    undefined,
    signal,
  );

export const getEvalsReport = (signal?: AbortSignal) =>
  api<EvalsReportResponse>(`${ROOT}/evals/report`, 'GET', undefined, signal);
