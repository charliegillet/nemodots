import type pg from 'pg';
import type {
  EventSinkPort,
  Scope,
  SourceKey,
  SourceReaderPort,
  SourceRef,
  SourceType,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { EventBuffer } from '../coordinator/events.js';
import {
  ControlledSourceMissingError,
  DigestMismatchError,
  RevisionMismatchError,
  StaleObservationRejectedError,
  findSourceByKey,
  recordReadSet,
  registerObservation,
  type RegisterResult,
} from '../ledger/index.js';
import { ToolError } from './errors.js';
import type { ObservationPort, ObservedReceipt, TeamReader } from './types.js';

// observe_source (TOOL_COVERAGE section 1): read the source through
// SourceReaderPort OUTSIDE any transaction, then in ONE transaction register
// or confirm the receipt (sources row locked by the ledger), record the
// evidence edge receipt -> attempt and append the tool_call.recorded event.
// Scope comes from the mission row, never from the caller.

const COLLECTION_KEY = 'checkout.config';
const MEMBER_PREFIX = 'checkout.config/';
const MAX_RACE_ATTEMPTS = 3;

function observedType(key: string): Extract<SourceType, 'observed_endpoint' | 'observed_store'> {
  return key === 'checkout.orders.recent' || key === 'redis.stats'
    ? 'observed_store'
    : 'observed_endpoint';
}

const READABLE =
  /^(?:checkout\.config(?:\/[a-z][a-z0-9_.]{0,60})?|checkout\.health|checkout\.metrics|checkout\.orders\.recent|redis\.stats|checkout\.inventory\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export interface LedgerObserverDeps {
  pool: pg.Pool;
  readers: SourceReaderPort;
  reader: Pick<TeamReader, 'mission'>;
  events: EventSinkPort;
  clock?: () => Date;
}

function toObserved(result: RegisterResult): ObservedReceipt {
  const r = result.receipt;
  return {
    receiptId: r.id,
    sourceKey: r.source.key,
    sourceRevision: r.sourceRevision,
    collectionRevision: r.collectionRevision,
    observedAt: r.observedAt,
    lastConfirmedAt: r.lastConfirmedAt,
    contentDigest: r.contentDigest,
    normalizedValue: r.normalizedValue,
    negative: r.negative,
    status: r.status,
    trust: r.trust,
    newRevision: result.newRevision,
  };
}

export function createLedgerObserver(deps: LedgerObserverDeps): ObservationPort {
  const clock = deps.clock ?? (() => new Date());

  async function sourceRef(
    scope: Scope,
    key: SourceKey,
  ): Promise<SourceRef> {
    if (key === COLLECTION_KEY)
      return {
        key,
        sourceType: 'controlled_collection',
        authority: 'controlled',
        scope,
      };
    if (key.startsWith(MEMBER_PREFIX))
      return {
        key,
        sourceType: 'controlled_config',
        authority: 'controlled',
        scope,
      };
    // The ledger refuses one key registered with two types: prefer the stored one.
    const stored = await findSourceByKey(deps.pool, {
      ownerId: scope.ownerId,
      environment: scope.environment,
      resource: scope.resource,
      key,
    });
    const type =
      stored &&
      (stored.sourceType === 'observed_endpoint' ||
        stored.sourceType === 'observed_store')
        ? stored.sourceType
        : observedType(key);
    return { key, sourceType: type, authority: 'observed', scope };
  }

  return {
    async observe({ context, sourceKey, toolCallId, modelCallId }) {
      if (!READABLE.test(sourceKey))
        throw new ToolError(
          'source_unavailable',
          'that source cannot be observed with this tool',
        );
      const started = Date.now();
      const mission = await deps.reader.mission(context.missionId);
      const scope = mission.scope;
      const member = sourceKey.startsWith(MEMBER_PREFIX)
        ? sourceKey.slice(MEMBER_PREFIX.length)
        : null;

      let last: unknown;
      for (let attempt = 1; attempt <= MAX_RACE_ATTEMPTS; attempt += 1) {
        let read;
        try {
          read = await deps.readers.read(sourceKey, scope);
        } catch {
          throw new ToolError(
            'source_unavailable',
            'the source could not be read right now',
          );
        }
        const sampledAt = clock();
        let key = sourceKey;
        let normalizedValue = read.normalizedValue;
        let revisionHint = read.revisionHint;
        let negative: { predicate: string; collectionRevision: number } | null =
          null;
        if (member !== null && read.normalizedValue === null) {
          // Negative evidence lives on the membership collection (D1).
          const collection = await deps.readers.read(
            COLLECTION_KEY as SourceKey,
            scope,
          );
          key = COLLECTION_KEY as SourceKey;
          normalizedValue = collection.normalizedValue;
          revisionHint = collection.revisionHint;
          negative = {
            predicate: `key '${member}' does not exist`,
            collectionRevision: collection.revisionHint ?? 0,
          };
        }
        const ref = await sourceRef(scope, key);
        try {
          const result = await withTransaction(deps.pool, async (client) => {
            const registered = await registerObservation(client, {
              source: ref,
              normalizedValue,
              provenance: {
                kind: 'tool_call',
                toolCallId,
                modelCallId,
                attemptId: context.attemptId,
              },
              observedAt: sampledAt,
              ...(negative ? { negative } : {}),
              ...(ref.authority === 'controlled' && revisionHint !== null
                ? { claimed: { sourceRevision: revisionHint } }
                : {}),
            });
            const receipt = registered.receipt;
            await recordReadSet(client, {
              missionId: context.missionId,
              taskId: context.taskId,
              attemptId: context.attemptId,
              receiptIds: [receipt.id],
            });
            const events = new EventBuffer(deps.events);
            if (registered.newRevision)
              events.add(context.missionId, {
                kind: 'receipt.registered',
                receiptId: receipt.id,
                sourceKey: receipt.source.key,
                sourceRevision: receipt.sourceRevision,
                supersedes: receipt.supersedes,
                trust: receipt.trust,
                selfWrite: receipt.provenance.selfWrite,
                provenanceKind: receipt.provenance.kind,
                contentDigest: receipt.contentDigest,
              });
            else if (registered.confirmation)
              events.add(context.missionId, {
                kind: 'receipt.confirmed',
                receiptId: receipt.id,
                sourceKey: receipt.source.key,
                confirmedAt: registered.confirmation.confirmedAt,
              });
            events.add(context.missionId, {
              kind: 'tool_call.recorded',
              attemptId: context.attemptId,
              toolCallId,
              name: 'observe_source',
              durationMs: Date.now() - started,
              ok: true,
              receiptId: receipt.id,
            });
            await events.flush(client);
            return registered;
          });
          return toObserved(result);
        } catch (error) {
          // The authority moved between the read and the registration: read again.
          if (
            error instanceof StaleObservationRejectedError ||
            error instanceof RevisionMismatchError ||
            error instanceof DigestMismatchError
          ) {
            last = error;
            continue;
          }
          if (error instanceof ControlledSourceMissingError)
            throw new ToolError(
              'source_unavailable',
              'that configuration key no longer exists',
            );
          throw error;
        }
      }
      void last;
      throw new ToolError(
        'source_unavailable',
        'the source kept changing while it was being observed; try again',
      );
    },
  };
}
