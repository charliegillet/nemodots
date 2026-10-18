import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  CheckoutHealthResponse,
  HealthStatus,
  Mission,
} from '../../server/nemodots/contracts/index.js';
import { ApiError } from '../api';
import {
  getCheckoutHealth,
  getHealth,
  getMissionSnapshot,
  listMissions,
} from './mission-api';
import {
  createMissionState,
  missionReducer,
  type MissionState,
} from './mission-events';
import { openMissionStream, type StreamStatus } from './mission-stream';

// Data hooks for the mission page. The mission hook reconstructs from storage:
// snapshot first, then the durable SSE stream resumes from the snapshot's
// lastEventId, and a 3 s snapshot poll covers every moment the stream is not
// open. All state transitions go through the pure reducer in mission-events.ts.

export const SNAPSHOT_POLL_MS = 3000;
export const HEALTH_POLL_MS = 5000;

const failureText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export interface UseMissionResult {
  state: MissionState;
  /** true once a snapshot has been merged */
  loaded: boolean;
  /** last snapshot failure; cleared by the next successful snapshot */
  error: string | null;
  /** the mission cannot be read at all (unknown id or no access) */
  missing: boolean;
  stream: StreamStatus;
  streamDetail: string | null;
  refresh: () => Promise<void>;
}

export function useMission(missionId: string): UseMissionResult {
  const [state, dispatch] = useReducer(
    missionReducer,
    missionId,
    createMissionState,
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [stream, setStream] = useState<StreamStatus>('connecting');
  const [streamDetail, setStreamDetail] = useState<string | null>(null);
  const streamRef = useRef<StreamStatus>('connecting');
  const loadedRef = useRef(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    dispatch({ type: 'reset', missionId });
    setLoaded(false);
    loadedRef.current = false;
    setError(null);
    setMissing(false);
    streamRef.current = 'connecting';
    setStream('connecting');
    setStreamDetail(null);
    let active = true;
    const controller = new AbortController();
    let handle: ReturnType<typeof openMissionStream> | null = null;

    /** Merges a snapshot; resolves to its lastEventId, null when unreadable, -1 when gone. */
    const loadSnapshot = async (): Promise<number | null> => {
      try {
        const snapshot = await getMissionSnapshot(missionId, controller.signal);
        if (!active) return null;
        dispatch({ type: 'snapshot', snapshot });
        loadedRef.current = true;
        setLoaded(true);
        setError(null);
        setMissing(false);
        return snapshot.lastEventId;
      } catch (failure) {
        if (!active || controller.signal.aborted) return null;
        const gone =
          failure instanceof ApiError &&
          (failure.status === 404 || failure.status === 403);
        if (gone) setMissing(true);
        setError(failureText(failure, 'Could not load the mission.'));
        return gone ? -1 : 0;
      }
    };
    const load = async () => {
      await loadSnapshot();
    };
    loadRef.current = load;

    const start = async () => {
      const resumeFrom = await loadSnapshot();
      if (!active || resumeFrom === null || resumeFrom < 0) return;
      handle = openMissionStream({
        missionId,
        lastEventId: resumeFrom,
        onEvent: (event) => {
          if (active) dispatch({ type: 'event', event });
        },
        onStatus: (status, detail) => {
          if (!active) return;
          streamRef.current = status;
          setStream(status);
          setStreamDetail(detail ?? null);
        },
      });
    };
    void start();

    // Fallback while the stream is not open, and until a snapshot has merged
    // at all (a transient first failure must not leave the page unreadable
    // behind an open stream): a refresh must always be able to rebuild the
    // page from storage alone.
    const timer = setInterval(() => {
      if (!loadedRef.current || streamRef.current !== 'open') void load();
    }, SNAPSHOT_POLL_MS);

    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      handle?.close();
      loadRef.current = null;
    };
  }, [missionId]);

  const refresh = useCallback(async () => {
    await loadRef.current?.();
  }, []);

  return { state, loaded, error, missing, stream, streamDetail, refresh };
}

export interface UseNemoDotsHealthResult {
  health: HealthStatus | null;
  checkout: CheckoutHealthResponse | null;
  /** failure loading health; checkout detail failures are not errors */
  error: string | null;
  loading: boolean;
}

/** Run mode, provider and checkout health, polled every 5 s. */
export function useNemoDotsHealth(): UseNemoDotsHealthResult {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [checkout, setCheckout] = useState<CheckoutHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getHealth(controller.signal);
        if (!active) return;
        setHealth(next);
        setError(null);
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        setError(failureText(failure, 'Could not load NemoDots health.'));
      }
      try {
        const next = await getCheckoutHealth(controller.signal);
        if (active) setCheckout(next);
      } catch {
        // The checkout detail is optional: system health already reports reachability.
        if (active && !controller.signal.aborted) setCheckout(null);
      }
      if (active) setLoading(false);
    };
    void load();
    const timer = setInterval(() => void load(), HEALTH_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return { health, checkout, error, loading };
}

export interface UseMissionListResult {
  missions: Mission[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useMissionList(): UseMissionListResult {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await listMissions(controller.signal);
        if (!active) return;
        setMissions(next);
        setError(null);
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        setError(failureText(failure, 'Could not load missions.'));
      }
      if (active) setLoading(false);
    };
    reloadRef.current = load;
    void load();
    const timer = setInterval(() => void load(), HEALTH_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      reloadRef.current = null;
    };
  }, []);

  const reload = useCallback(async () => {
    await reloadRef.current?.();
  }, []);

  return { missions, loading, error, reload };
}
