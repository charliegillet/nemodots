import type pg from 'pg';
import type {
  EventSinkPort,
  InvalidationEvent,
  MissionId,
  ObservationReceipt,
  PgClient,
  Scope,
  SourceKey,
  SourceReaderPort,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { registerObservation, type RegisterResult } from '../ledger/index.js';

// Demo source watcher (simplified W3.2): polls the version authority
// (checkout.config_entries) and, when a member's version moved, registers a
// new controlled receipt in the ledger under the active mission's scope. The
// ledger supersedes the prior head and computes the invalidation closure in
// the same transaction; the coordinator then repairs only the affected tasks.
// Writes caused by one of our actions are registered as self-writes.
//
// Simplification: only checkout.config/<key> sources are watched (observed
// endpoints such as checkout.health are re-read by the agents themselves).

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface WatcherDeps {
  pool: pg.Pool;
  readers: SourceReaderPort;
  events: EventSinkPort;
  scopeFor: (missionId: MissionId) => Scope;
  pollMs: number;
  onInvalidation: (event: InvalidationEvent) => Promise<void>;
  onSelfWrite: (
    actionId: string,
    receipt: ObservationReceipt,
    version: number,
  ) => Promise<void>;
  log: (message: string) => void;
}

export async function emitReceipt(
  events: EventSinkPort,
  client: PgClient,
  missionId: string,
  result: RegisterResult,
) {
  if (!result.newRevision) return;
  const receipt = result.receipt;
  await events.append(client, {
    missionId: missionId as MissionId,
    kind: 'receipt.registered',
    payload: {
      kind: 'receipt.registered',
      receiptId: receipt.id,
      sourceKey: receipt.source.key,
      sourceRevision: receipt.sourceRevision,
      supersedes: receipt.supersedes,
      trust: receipt.trust,
      selfWrite: receipt.provenance.selfWrite,
      provenanceKind: receipt.provenance.kind,
      contentDigest: receipt.contentDigest,
    },
  } as never);
}

export function createWatcher(deps: WatcherDeps) {
  const seen = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  async function activeMission(): Promise<MissionId | null> {
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM coordinator.missions
        WHERE status IN ('running', 'awaiting_acceptance', 'paused')
        ORDER BY created_at DESC LIMIT 1`,
    );
    return (rows[0]?.id as MissionId) ?? null;
  }

  async function register(
    missionId: MissionId,
    key: string,
    causedByActionId: string | null,
  ) {
    const sourceKey = `checkout.config/${key}` as SourceKey;
    const scope = deps.scopeFor(missionId);
    const read = await deps.readers.read(sourceKey, scope);
    const result = await withTransaction(deps.pool, async (client) => {
      const registered = await registerObservation(client, {
        source: {
          key: sourceKey,
          sourceType: 'controlled_config',
          authority: 'controlled',
          scope,
        },
        normalizedValue: read.normalizedValue,
        provenance: {
          kind: 'watcher',
          causedByActionId: causedByActionId as never,
          selfWrite: causedByActionId ? 'verified' : 'none',
        },
      });
      await emitReceipt(deps.events, client, missionId, registered);
      return registered;
    });
    if (result.newRevision)
      deps.log(
        `watcher: ${sourceKey} -> revision ${result.receipt.sourceRevision}${
          result.invalidation
            ? ` (invalidation ${result.invalidation.id.slice(0, 8)})`
            : ''
        }`,
      );
    if (result.invalidation) await deps.onInvalidation(result.invalidation);
    if (causedByActionId)
      await deps.onSelfWrite(
        causedByActionId,
        result.receipt,
        result.receipt.sourceRevision,
      );
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const { rows } = await deps.pool.query<Row>(
        'SELECT key, version, caused_by_action_id FROM checkout.config_entries',
      );
      const changed = rows.filter(
        (row) => seen.has(row.key) && seen.get(row.key) !== Number(row.version),
      );
      for (const row of rows)
        if (!seen.has(row.key)) seen.set(row.key, Number(row.version));
      if (changed.length === 0) return;
      const missionId = await activeMission();
      for (const row of changed) {
        if (missionId) {
          try {
            await register(missionId, row.key, row.caused_by_action_id ?? null);
          } catch (error) {
            deps.log(
              `watcher: register ${row.key} failed: ${(error as Error).message}`,
            );
            continue; // retried next tick
          }
        }
        seen.set(row.key, Number(row.version));
      }
    } catch (error) {
      deps.log(`watcher: tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      timer = setInterval(() => void tick(), deps.pollMs);
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    tick,
  };
}
