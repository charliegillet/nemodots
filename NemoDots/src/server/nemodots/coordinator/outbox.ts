import pg from 'pg';
import { z } from 'zod';
import {
  ActionIdSchema,
  IsoTimeSchema,
  MissionIdSchema,
  type MissionId,
  type PgClient,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import type { CoordinatorDeps } from './types.js';

// Transactional outbox (ARCHITECTURE.md section 3: wakeups are hints, the
// outbox table is the truth).
//
// Delivery is at-least-once: a worker claims a message (claimed_until lease),
// runs the handler OUTSIDE any transaction and then marks it processed. The
// claim is renewed while the handler runs (a long handler such as the
// acceptance probe never loses its message to a second worker); a crash lets
// the lease expire and redelivers it. Handlers must therefore be idempotent;
// handlers whose effect is a database write get exactly-once through
// `helpers.runOnce(fn)`, which commits the effect and an outbox_applied row
// together, so a redelivery skips it.
//
// Wakeups: an INSERT trigger issues NOTIFY nemodots_outbox; `start()` LISTENs
// and also polls, so a lost notification only delays processing. In the
// background loop handlers run concurrently (up to batchSize in flight) and
// maintenance (reaper, recovery sweep) runs beside them, so one slow handler
// blocks neither other messages nor the reaper.

export const OUTBOX_CHANNEL = 'nemodots_outbox';

export interface OutboxMessage {
  id: number;
  missionId: MissionId | null;
  topic: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
}

export interface OutboxHelpers {
  /**
   * Runs `fn` in one transaction together with a (message, topic) applied-row.
   * Returns `{ applied: false }` when an earlier delivery already ran it.
   */
  runOnce<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<{ applied: true; value: T } | { applied: false }>;
}

/** Return `{ deferUntil }` to leave the message queued without using up an attempt. */
export type OutboxHandlerResult = void | { deferUntil: Date };
export type OutboxHandler = (
  message: OutboxMessage,
  helpers: OutboxHelpers,
) => Promise<OutboxHandlerResult>;

export interface EnqueueInput {
  missionId?: MissionId | string | null;
  topic: string;
  payload: unknown;
  /** Duplicate enqueues with the same key are ignored. */
  dedupeKey?: string;
  availableAt?: Date;
}

/** Enqueue inside the caller's transaction (the actions package uses this for action.proposed). */
export async function enqueueOutbox(
  client: PgClient,
  input: EnqueueInput,
): Promise<number | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO coordinator.outbox (mission_id, topic, payload, dedupe_key, available_at)
     VALUES ($1, $2, $3::jsonb, $4, COALESCE($5::timestamptz, now()))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.missionId ?? null,
      input.topic,
      JSON.stringify(input.payload),
      input.dedupeKey ?? null,
      input.availableAt ? input.availableAt.toISOString() : null,
    ],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export interface OutboxOptions {
  workerId: string;
  handlers: Record<string, OutboxHandler>;
  /**
   * How long a claimed message is invisible to other workers (default 30 s).
   * Renewed every third of this while the handler runs.
   */
  claimMs?: number;
  /**
   * Renew the claim while a handler runs (default true). Turn it off only to
   * simulate a worker that stalled or crashed mid-handler.
   */
  renewClaim?: boolean;
  /** Deliveries before a message is parked as failed (default 8). */
  maxAttempts?: number;
  pollMs?: number;
  batchSize?: number;
  /** Extra periodic work (reaper, recovery sweep). Errors go to onError. */
  maintenance?: () => Promise<void>;
  onError?: (error: unknown, message?: OutboxMessage) => void;
}

export interface Outbox {
  /** Claim and run up to `limit` ready messages; returns how many were handled. */
  processBatch(limit?: number): Promise<number>;
  /** Process until nothing is ready (bounded), for tests and shutdown. */
  drain(maxRounds?: number): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface OutboxRow {
  id: string;
  mission_id: string | null;
  topic: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

const backoffMs = (attempts: number) =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));

export function createOutbox(
  deps: Pick<CoordinatorDeps, 'pool'>,
  options: OutboxOptions,
): Outbox {
  const claimMs = options.claimMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const pollMs = options.pollMs ?? 1_000;
  const batchSize = options.batchSize ?? 10;
  let listener: pg.Client | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let wake: (() => void) | null = null;
  /** A notification arrived since the current cycle began (it may have raced the drain). */
  let dirty = false;
  let loop: Promise<void> | null = null;
  let maintaining = false;
  /** Handlers (and maintenance) running in the background loop. */
  const inflight = new Set<Promise<void>>();

  const report = (error: unknown, message?: OutboxMessage) => {
    if (options.onError) options.onError(error, message);
  };

  async function claim(limit: number): Promise<OutboxMessage[]> {
    const { rows } = await deps.pool.query<OutboxRow>(
      `WITH picked AS (
         SELECT id FROM coordinator.outbox
          WHERE processed_at IS NULL AND failed_at IS NULL
            AND available_at <= clock_timestamp()
            AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
          ORDER BY available_at, id
          LIMIT $1
            FOR UPDATE SKIP LOCKED)
       UPDATE coordinator.outbox o
          SET claimed_by = $2,
              claimed_until = clock_timestamp() + $3 * interval '1 millisecond',
              attempts = o.attempts + 1
         FROM picked WHERE o.id = picked.id
       RETURNING o.id, o.mission_id, o.topic, o.payload, o.attempts, o.created_at`,
      [limit, options.workerId, claimMs],
    );
    return rows
      .map((row) => ({
        id: Number(row.id),
        missionId: row.mission_id as MissionId | null,
        topic: row.topic,
        payload: row.payload,
        attempts: row.attempts,
        createdAt: row.created_at,
      }))
      .sort((a, b) => a.id - b.id);
  }

  async function settle(message: OutboxMessage, result: OutboxHandlerResult) {
    if (result && 'deferUntil' in result) {
      await deps.pool.query(
        `UPDATE coordinator.outbox
            SET available_at = $3, claimed_by = NULL, claimed_until = NULL,
                attempts = GREATEST(attempts - 1, 0)
          WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
        [message.id, options.workerId, result.deferUntil.toISOString()],
      );
      return;
    }
    await deps.pool.query(
      `UPDATE coordinator.outbox
          SET processed_at = now(), claimed_by = NULL, claimed_until = NULL
        WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
      [message.id, options.workerId],
    );
  }

  async function fail(message: OutboxMessage, error: unknown) {
    const text = (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    );
    await deps.pool.query(
      `UPDATE coordinator.outbox
          SET last_error = $3, claimed_by = NULL, claimed_until = NULL,
              available_at = now() + $4 * interval '1 millisecond',
              failed_at = CASE WHEN attempts >= $5 THEN now() ELSE NULL END
        WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
      [
        message.id,
        options.workerId,
        text,
        backoffMs(message.attempts),
        maxAttempts,
      ],
    );
  }

  async function run(message: OutboxMessage) {
    const handler = options.handlers[message.topic];
    if (!handler) {
      await fail(message, new Error(`no handler for topic ${message.topic}`));
      return;
    }
    const helpers: OutboxHelpers = {
      runOnce: (fn) =>
        withTransaction(deps.pool, async (client) => {
          const marked = await client.query(
            `INSERT INTO coordinator.outbox_applied (outbox_id, handler)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [message.id, message.topic],
          );
          if (marked.rowCount === 0) return { applied: false as const };
          return { applied: true as const, value: await fn(client) };
        }),
    };
    // Keep the claim alive for as long as the handler runs.
    const renew = setInterval(
      () => {
        if (options.renewClaim === false) return;
        deps.pool
          .query(
            `UPDATE coordinator.outbox
                SET claimed_until = clock_timestamp() + $3 * interval '1 millisecond'
              WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
            [message.id, options.workerId, claimMs],
          )
          .catch((error: unknown) => report(error, message));
      },
      Math.max(20, Math.floor(claimMs / 3)),
    );
    try {
      await settle(message, await handler(message, helpers));
    } catch (error) {
      report(error, message);
      await fail(message, error);
    } finally {
      clearInterval(renew);
    }
  }

  async function processBatch(limit = batchSize) {
    const messages = await claim(limit);
    for (const message of messages) await run(message);
    return messages.length;
  }

  async function drain(maxRounds = 100) {
    let total = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const handled = await processBatch();
      if (handled === 0) break;
      total += handled;
    }
    return total;
  }

  function track(work: Promise<void>, wakeWhenDone: boolean) {
    const done: Promise<void> = work
      .catch((error: unknown) => report(error))
      .finally(() => {
        inflight.delete(done);
        // A freed slot may let the next ready message start right away.
        if (wakeWhenDone) {
          dirty = true;
          wake?.();
        }
      });
    inflight.add(done);
  }

  /** One loop cycle: start handlers for ready messages and the maintenance step, without awaiting them. */
  async function tick() {
    if (stopped) return;
    const capacity = batchSize - inflight.size;
    if (capacity > 0) {
      const messages = await claim(capacity);
      for (const message of messages) track(run(message), true);
      // More may be ready: go around again without sleeping.
      if (messages.length === capacity) dirty = true;
    }
    if (options.maintenance && !maintaining) {
      maintaining = true;
      const maintenance = options.maintenance;
      track(
        maintenance().finally(() => {
          maintaining = false;
        }),
        false,
      );
    }
  }

  return {
    processBatch,
    drain,
    async start() {
      if (!stopped) return;
      stopped = false;
      const client = new pg.Client({
        connectionString: (deps.pool.options as { connectionString?: string })
          .connectionString,
        application_name: 'nemodots-coordinator-listen',
      });
      client.on('error', (error) => report(error));
      client.on('notification', () => {
        dirty = true;
        wake?.();
      });
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
      listener = client;
      loop = (async () => {
        while (!stopped) {
          dirty = false;
          try {
            await tick();
          } catch (error) {
            report(error);
          }
          // A wakeup that raced the tick must not wait for the next poll.
          if (dirty || stopped) continue;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, pollMs);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
            timer = t;
          });
          wake = null;
        }
      })();
    },
    async stop() {
      stopped = true;
      wake?.();
      if (timer) clearTimeout(timer);
      await loop;
      loop = null;
      await Promise.allSettled([...inflight]);
      if (listener) {
        const client = listener;
        listener = null;
        await client.end().catch(() => {});
      }
    },
  };
}

// -------------------------------------------------------------- handlers

export const ActionProposedPayloadSchema = z
  .object({
    actionId: ActionIdSchema,
    missionId: MissionIdSchema,
    proposedAt: IsoTimeSchema,
  })
  .strict();
export type ActionProposedPayload = z.infer<typeof ActionProposedPayloadSchema>;

export const MissionTopicPayloadSchema = z
  .object({ missionId: MissionIdSchema })
  .strict();
