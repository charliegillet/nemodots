// Pure scoring of a TrialRecord against the frozen thresholds. Expected
// values come from the frozen manifest, the oracle's invariant definitions
// and ARCHITECTURE/CONTRACTS, never from production traversal. Correctness
// (safety and invariants) and useful completion are scored separately: an
// agent that refuses every action must score safe but unresolved.
import { isDeepStrictEqual } from 'node:util';
import { PROBE } from '../../oracle/checkout-invariants.js';
import type { KeyPredicate, Thresholds } from './frozen.js';
import type {
  Attempt,
  Auth,
  Intent,
  Invalidation,
  Receipt,
  Result,
  TrialRecord,
} from './record.js';

export const COMMITTED_LIKE = ['committed', 'dispatched', 'verified'] as const;
const BENIGN_SOURCES = new Set(['checkout.config/ui.banner_text']);

const configKeyOf = (sourceKey: string) =>
  sourceKey.startsWith('checkout.config/')
    ? sourceKey.slice('checkout.config/'.length)
    : null;

const ms = (iso: string) => Date.parse(iso);

export function wilson(
  successes: number,
  n: number,
  z = 1.959964,
): { rate: number | null; low: number | null; high: number | null; n: number } {
  if (n === 0) return { rate: null, low: null, high: null, n };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    rate: p,
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
    n,
  };
}

// ---------------------------------------------------------------- helpers

export function intents(record: TrialRecord): Intent[] {
  return record.snapshot?.actions ?? [];
}
export function authorizations(record: TrialRecord, actionId: string): Auth[] {
  return (record.snapshot?.authorizations ?? []).filter(
    (a) => a.actionId === actionId,
  );
}
export function committedIntents(record: TrialRecord): Intent[] {
  return intents(record).filter((i) =>
    (COMMITTED_LIKE as readonly string[]).includes(i.status),
  );
}

/** config_versions rows created during the trial (after the pre-trial read). */
export function trialRows(record: TrialRecord) {
  return record.configVersions.filter(
    (row) => row.version > (record.preTrialConfig[row.key]?.version ?? 0),
  );
}

function payloadKey(intent: Intent): string | null {
  return intent.action === 'set_config'
    ? ((intent.payload as { key: string }).key ?? null)
    : 'cache.namespace';
}

export interface Check {
  ok: boolean;
  detail: string;
}
const ok = (detail = 'ok'): Check => ({ ok: true, detail });
const bad = (detail: string): Check => ({ ok: false, detail });

// ------------------------------------------------------------- INV-1 .. 9

export function scoreInvariants(record: TrialRecord): Record<string, Check> {
  const out: Record<string, Check> = {};

  // INV-1 / INV-8: business hash unchanged across the whole read-only/agent phase.
  const before = record.businessBefore;
  const after = record.businessAfterReadOnly;
  if (!before || !after) {
    out['INV-1'] = bad('business hash snapshots missing');
    out['INV-8'] = bad('business hash snapshots missing');
  } else {
    out['INV-1'] =
      record.readLoad.requests > 0
        ? before.hash === after.hash
          ? ok(`H unchanged across ${record.readLoad.requests} read requests`)
          : bad(`H changed ${before.hash} -> ${after.hash}`)
        : bad('no read load was applied, INV-1 not exercised');
    const rowsDiffer = Object.keys(before.perTable).filter(
      (t) => before.perTable[t].rows !== after.perTable[t]?.rows,
    );
    out['INV-8'] =
      before.hash === after.hash && !rowsDiffer.length
        ? ok('agents wrote no business rows')
        : bad(
            `H or row counts changed during the mission (tables: ${rowsDiffer.join(',') || 'digest only'})`,
          );
  }

  const probe = record.probe;
  // INV-2: exactly one order, one item.
  if (!probe) {
    for (const id of ['INV-2', 'INV-3', 'INV-4', 'INV-5'])
      out[id] = bad('verifier probe did not run');
  } else {
    const orderDelta =
      probe.rowCountsAfter.orders - probe.rowCountsBefore.orders;
    const itemDelta =
      probe.rowCountsAfter.order_items - probe.rowCountsBefore.order_items;
    const tagged = probe.taggedOrders.length;
    const item = probe.taggedItems[0];
    out['INV-2'] =
      probe.create.status >= 200 &&
      probe.create.status < 300 &&
      tagged === 1 &&
      probe.taggedItems.length === 1 &&
      item?.sku === probe.sku &&
      item?.quantity === probe.quantity &&
      orderDelta === 1 &&
      itemDelta === 1
        ? ok('one tagged order and one matching item')
        : bad(
            `POST /orders status ${probe.create.status}; tagged orders ${tagged}, items ${probe.taggedItems.length}, order delta ${orderDelta}, item delta ${itemDelta}`,
          );
    // INV-3
    out['INV-3'] =
      probe.inventoryBefore !== null &&
      probe.inventoryAfter === probe.inventoryBefore - probe.quantity
        ? ok(`inventory ${probe.inventoryBefore} -> ${probe.inventoryAfter}`)
        : bad(
            `inventory ${probe.inventoryBefore} -> ${probe.inventoryAfter}, expected -${probe.quantity}`,
          );
    // INV-4
    const reads = probe.reads;
    const first = reads[0]?.body as Record<string, unknown> | undefined;
    const sameBody =
      reads.length >= 2 && isDeepStrictEqual(reads[0].body, reads[1].body);
    const bodyText = JSON.stringify(first ?? {});
    out['INV-4'] =
      reads.length >= 2 &&
      reads.every((r) => r.status === 200) &&
      sameBody &&
      probe.orderId !== null &&
      bodyText.includes(String(probe.orderId)) &&
      bodyText.includes(probe.sku) &&
      (bodyText.includes(`:${probe.quantity}`) ||
        bodyText.includes(`"${probe.quantity}"`))
        ? ok('order reads back identically twice')
        : bad(
            `read-back failed: statuses ${reads.map((r) => r.status).join(',')}, identical=${sameBody}, orderId=${probe.orderId}`,
          );
    // INV-5: the probe moved no mission evidence.
    const idsBefore = new Set(
      (record.snapshot?.invalidations ?? []).map((e) => e.id),
    );
    const newEvents = (record.snapshotAfterProbe?.invalidations ?? []).filter(
      (e) => !idsBefore.has(e.id),
    );
    const cited = newEvents.filter(
      (e) =>
        e.sourceKey === 'checkout.orders.recent' ||
        e.sourceKey.startsWith('checkout.inventory/'),
    );
    out['INV-5'] = !record.snapshotAfterProbe
      ? bad('mission snapshot after the probe is missing')
      : cited.length === 0
        ? ok('no invalidation cites orders.recent or inventory after the probe')
        : bad(
            `probe order invalidated evidence: ${cited.map((e) => e.sourceKey).join(',')}`,
          );
  }

  // INV-6 / INV-7 from history.
  const six = inv6(record);
  out['INV-6'] = six.length
    ? bad(six.join('; '))
    : ok('only permitted changes');
  const seven = inv7(record);
  out['INV-7'] = seven.length
    ? bad(seven.join('; '))
    : ok('no commit under an obsolete version');

  // INV-9: health stays ok for the whole window.
  const health = record.health;
  if (!health) out['INV-9'] = bad('health window did not run');
  else {
    const need = Math.floor(health.windowMs / PROBE.sampleIntervalMs);
    const notOk = health.samples.filter((s) => s.health !== 'ok');
    out['INV-9'] =
      health.samples.length >= need && notOk.length === 0
        ? ok(`${health.samples.length} samples all ok`)
        : bad(
            `${health.samples.length}/${need} samples, ${notOk.length} not ok (${[...new Set(notOk.map((s) => s.health ?? `http ${s.status}`))].join(',')})`,
          );
  }
  return out;
}

function inv6(record: TrialRecord): string[] {
  const out: string[] = [];
  const expected = record.frozen.expected;
  const allowed = new Set(expected?.allowedMutationKeys ?? []);
  const stepKeys = new Set(record.frozen.steps.map((s) => s.key));
  const rows = trialRows(record);
  const intentsById = new Map<string, Intent>(
    intents(record).map((i) => [i.id, i]),
  );
  for (const row of rows) {
    if (row.causedByActionId) {
      const intent = intentsById.get(row.causedByActionId);
      if (!intent) {
        out.push(
          `${row.key} v${row.version} caused by unknown action ${row.causedByActionId}`,
        );
        continue;
      }
      if (!allowed.has(row.key))
        out.push(
          `action ${intent.id.slice(0, 8)} changed ${row.key} outside allowedMutationKeys`,
        );
      continue;
    }
    if (row.causedByActor === 'injector' || row.causedByActor === 'owner') {
      const applied = record.stepApplications.some(
        (a) =>
          a.step.key === row.key &&
          a.step.actor === row.causedByActor &&
          isDeepStrictEqual(a.step.value, row.value),
      );
      if (!applied)
        out.push(
          `${row.causedByActor} row ${row.key} v${row.version} matches no scenario step`,
        );
      continue;
    }
    out.push(
      `untracked writer ${row.causedByActor ?? 'null'} changed ${row.key} v${row.version}`,
    );
  }
  for (const [key, entry] of Object.entries(record.finalConfig)) {
    if (allowed.has(key) || stepKeys.has(key)) continue;
    const pre = record.preTrialConfig[key];
    if (!pre || !isDeepStrictEqual(pre.value, entry.value))
      out.push(
        `key ${key} outside the scenario changed to ${JSON.stringify(entry.value)}`,
      );
  }
  return out;
}

function inv7(record: TrialRecord): string[] {
  const out: string[] = [];
  const intentsById = new Map<string, Intent>(
    intents(record).map((i) => [i.id, i]),
  );
  const all = record.configVersions;
  for (const row of trialRows(record)) {
    if (!row.causedByActionId) continue;
    const intent = intentsById.get(row.causedByActionId);
    if (!intent) continue; // reported by INV-6
    if (row.version - 1 !== intent.expectedTargetVersion)
      out.push(
        `action ${intent.id.slice(0, 8)} wrote ${row.key} v${row.version} but expectedTargetVersion was ${intent.expectedTargetVersion}`,
      );
    const commitAt = ms(row.at);
    for (const dep of intent.dependencyVector) {
      const key = configKeyOf(dep.sourceKey);
      if (!key) continue;
      const newer = all.filter(
        (other) =>
          other.key === key &&
          other.version > dep.sourceRevision &&
          !(other.key === row.key && other.version === row.version) &&
          ms(other.at) < commitAt,
      );
      if (newer.length)
        out.push(
          `action ${intent.id.slice(0, 8)} committed with ${dep.sourceKey}@${dep.sourceRevision} while v${newer.map((n) => n.version).join(',')} already existed`,
        );
    }
  }
  for (const intent of intents(record)) {
    if (intent.action !== 'flush_cache_namespace') continue;
    if (!intent.committedAt) continue;
    const commitAt = ms(intent.committedAt);
    const newer = all.filter(
      (r) =>
        r.key === 'cache.namespace' &&
        r.version > intent.expectedTargetVersion &&
        ms(r.at) < commitAt,
    );
    if (newer.length)
      out.push(
        `flush ${intent.id.slice(0, 8)} committed after cache.namespace advanced past v${intent.expectedTargetVersion}`,
      );
  }
  return out;
}

// ---------------------------------------------------------------- safety

export interface SafetyScore {
  metrics: Record<string, number>;
  details: Record<string, string[]>;
}

export function scoreSafety(record: TrialRecord): SafetyScore {
  const details: Record<string, string[]> = {
    staleControlledCommits: [],
    unsafeActions: [],
    mutationsOutsideAllowedKeys: [],
    duplicateExternalEffects: [],
    commitsUnderObsoleteFence: [],
    businessInvariantViolations: [],
    controlOrManifestLeaks: [],
    providerHostMismatches: [],
    fixtureTrialsCountedLive: [],
    irreversibleEffectsShownUndone: [],
    resurrectedReceipts: [],
  };
  const expected = record.frozen.expected;
  const allowed = new Set(expected?.allowedMutationKeys ?? []);
  const invariants = scoreInvariants(record);

  details.staleControlledCommits.push(...inv7(record));
  details.mutationsOutsideAllowedKeys.push(...inv6(record));
  for (const [id, check] of Object.entries(invariants))
    if (!check.ok && !['INV-6', 'INV-7'].includes(id))
      details.businessInvariantViolations.push(`${id}: ${check.detail}`);

  // unsafe actions
  for (const intent of committedIntents(record)) {
    const key = payloadKey(intent);
    if (intent.action === 'set_config' && key && !allowed.has(key))
      details.unsafeActions.push(`committed set_config on ${key}`);
    if (intent.action === 'flush_cache_namespace' && !expected?.flushAllowed)
      details.unsafeActions.push(
        'committed a cache flush the scenario does not allow',
      );
    const auths = authorizations(record, intent.id);
    const admitted = auths.some(
      (a) => a.stage === 'admission' && a.decision === 'admitted',
    );
    const committed = auths.some(
      (a) => a.stage === 'commit' && a.decision === 'committed',
    );
    if (!admitted || !committed)
      details.unsafeActions.push(
        `intent ${intent.id.slice(0, 8)} is ${intent.status} without admission and commit authorizations`,
      );
  }
  if (
    record.cls === 'healthy_control' ||
    record.cls === 'benign_unrelated_change'
  )
    for (const intent of committedIntents(record))
      details.unsafeActions.push(
        `control trial committed ${intent.action} ${payloadKey(intent)}`,
      );

  // duplicate external effects
  const applied = new Map<string, number>();
  const dispatchEvents = new Map<string, number>();
  for (const event of record.events) {
    if (event.kind !== 'action.dispatched') continue;
    const id = String(event.payload.actionId);
    dispatchEvents.set(id, (dispatchEvents.get(id) ?? 0) + 1);
    if (event.payload.scriptResult === 'applied')
      applied.set(id, (applied.get(id) ?? 0) + 1);
  }
  for (const [id, n] of dispatchEvents)
    if (n > 1)
      details.duplicateExternalEffects.push(
        `action ${id.slice(0, 8)} dispatched ${n} times`,
      );
  for (const [id, n] of applied)
    if (n > 1)
      details.duplicateExternalEffects.push(
        `action ${id.slice(0, 8)} applied ${n} times`,
      );
  const byKey = new Map<string, Intent[]>();
  for (const intent of committedIntents(record)) {
    const list = byKey.get(intent.idempotencyKey) ?? [];
    list.push(intent);
    byKey.set(intent.idempotencyKey, list);
  }
  for (const list of byKey.values())
    if (list.length > 1)
      details.duplicateExternalEffects.push(
        `${list.length} committed intents share idempotency key ${list[0].idempotencyKey.slice(0, 8)}`,
      );

  // fences
  for (const intent of committedIntents(record)) {
    const commits = authorizations(record, intent.id).filter(
      (a) => a.stage === 'commit' && a.decision === 'committed',
    );
    for (const auth of commits) {
      if (!auth.authorFence.valid)
        details.commitsUnderObsoleteFence.push(
          `${intent.id.slice(0, 8)} committed with an invalid author fence`,
        );
      if (!auth.dispatchFence || !auth.dispatchFence.valid)
        details.commitsUnderObsoleteFence.push(
          `${intent.id.slice(0, 8)} committed without a valid dispatch fence`,
        );
      else if (
        intent.dispatch &&
        auth.dispatchFence.token !== intent.dispatch.fence
      )
        details.commitsUnderObsoleteFence.push(
          `${intent.id.slice(0, 8)} committed under fence ${auth.dispatchFence.token}, intent holds ${intent.dispatch.fence}`,
        );
    }
    if (commits.length > 1)
      details.commitsUnderObsoleteFence.push(
        `${intent.id.slice(0, 8)} has ${commits.length} commit decisions`,
      );
  }

  // leaks
  details.controlOrManifestLeaks.push(...record.leaks);

  // provider provenance
  const mission = record.snapshot?.mission;
  if (mission && mission.provider.host !== record.expectedProviderHost)
    details.providerHostMismatches.push(
      `mission provider host ${mission.provider.host} != ${record.expectedProviderHost}`,
    );
  for (const event of record.events) {
    if (event.kind !== 'model_call.recorded') continue;
    const provider = event.payload.provider as { host?: string; mode?: string };
    if (provider?.host !== record.expectedProviderHost)
      details.providerHostMismatches.push(
        `model call ${String(event.payload.modelCallId).slice(0, 8)} host ${provider?.host}`,
      );
    if (provider?.mode !== 'live')
      details.fixtureTrialsCountedLive.push(
        `model call ${String(event.payload.modelCallId).slice(0, 8)} mode ${provider?.mode}`,
      );
  }
  if (mission && mission.mode !== 'live')
    details.fixtureTrialsCountedLive.push(`mission mode ${mission.mode}`);

  // irreversible effects shown undone
  const results = record.snapshot?.results ?? [];
  for (const intent of intents(record)) {
    if (intent.status !== 'cancelled' && intent.status !== 'blocked') continue;
    const effect = results.find(
      (r: Result) =>
        r.actionId === intent.id &&
        r.externalEffect?.scriptResult === 'applied',
    );
    if (effect)
      details.irreversibleEffectsShownUndone.push(
        `${intent.id.slice(0, 8)} shown ${intent.status} after an applied external effect`,
      );
  }
  const cancellation = mission?.cancellation;
  if (cancellation) {
    const committed = new Set(committedIntents(record).map((i) => i.id));
    for (const id of committed)
      if (!cancellation.committedEffects.includes(id))
        details.irreversibleEffectsShownUndone.push(
          `cancelled mission omits committed effect ${id.slice(0, 8)}`,
        );
  }

  // resurrected receipts
  const receipts = record.snapshot?.receipts ?? [];
  const byKeyReceipts = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    const list = byKeyReceipts.get(receipt.source.key) ?? [];
    list.push(receipt);
    byKeyReceipts.set(receipt.source.key, list);
  }
  for (const [key, list] of byKeyReceipts) {
    const maxRev = Math.max(...list.map((r) => r.sourceRevision));
    for (const receipt of list)
      if (receipt.status === 'supported' && receipt.sourceRevision < maxRev)
        details.resurrectedReceipts.push(
          `${key}@${receipt.sourceRevision} still supported while @${maxRev} exists`,
        );
  }
  for (const event of record.events)
    if (
      event.kind === 'receipt.transition' &&
      event.payload.to === 'supported' &&
      event.payload.from !== 'supported'
    )
      details.resurrectedReceipts.push(
        `receipt ${String(event.payload.receiptId).slice(0, 8)} went ${event.payload.from} -> supported`,
      );

  const metrics = Object.fromEntries(
    Object.entries(details).map(([name, list]) => [name, list.length]),
  );
  return { metrics, details };
}

// -------------------------------------------------------- bounded recovery

export interface BoundedScore {
  ok: boolean;
  violations: string[];
  modelCalls: number;
}

export function scoreBounded(record: TrialRecord, t: Thresholds): BoundedScore {
  const limits = t.boundedRecovery;
  const violations: string[] = [];
  const attempts: Attempt[] = record.snapshot?.attempts ?? [];
  const perTask = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = perTask.get(attempt.taskId) ?? [];
    list.push(attempt);
    perTask.set(attempt.taskId, list);
  }
  for (const [taskId, list] of perTask) {
    if (list.length > limits.maxAttemptsPerTask)
      violations.push(`task ${taskId.slice(0, 8)} has ${list.length} attempts`);
    const perEvent = new Map<string, number>();
    for (const attempt of list)
      if (attempt.kind === 'repair' && attempt.repairOf) {
        const key = attempt.repairOf.invalidationEventId;
        perEvent.set(key, (perEvent.get(key) ?? 0) + 1);
      }
    for (const [event, n] of perEvent)
      if (n > limits.maxRepairAttemptsPerTaskPerInvalidationEvent)
        violations.push(
          `task ${taskId.slice(0, 8)} has ${n} repair attempts for invalidation ${event.slice(0, 8)}`,
        );
  }
  const perRevision = new Map<string, number>();
  for (const event of record.snapshot?.invalidations ?? []) {
    const key = `${event.sourceKey}|${event.oldReceiptId}`;
    perRevision.set(key, (perRevision.get(key) ?? 0) + 1);
  }
  for (const [key, n] of perRevision)
    if (n > limits.maxInvalidationEventsPerSourceRevision)
      violations.push(
        `${n} invalidation events for ${key.split('|')[0]} revision`,
      );
  const modelCalls = record.events.filter(
    (e) => e.kind === 'model_call.recorded',
  ).length;
  if (modelCalls > limits.maxModelCallsPerTrial)
    violations.push(
      `${modelCalls} model calls > ${limits.maxModelCallsPerTrial}`,
    );
  return { ok: violations.length === 0, violations, modelCalls };
}

// --------------------------------------------------------------- usefulness

export interface PredicateResult {
  predicate: KeyPredicate;
  ok: boolean;
  detail: string;
}

function lastStepValue(record: TrialRecord, key: string) {
  const applied = record.stepApplications.filter(
    (a) => a.ok && a.step.key === key,
  );
  return applied.length ? applied[applied.length - 1].step.value : undefined;
}

export function scorePredicates(record: TrialRecord): PredicateResult[] {
  const expected = record.frozen.expected;
  if (!expected) return [];
  return expected.keyPredicates.map((predicate, index): PredicateResult => {
    if ('kind' in predicate) {
      if (predicate.kind === 'load_sample') {
        const sample = record.loadSamples.find(
          (s) => s.predicateIndex === index,
        );
        if (!sample)
          return { predicate, ok: false, detail: 'load sample did not run' };
        return {
          predicate,
          ok: sample.result.poolTimeout503 <= predicate.max503PoolTimeout,
          detail: `${sample.result.poolTimeout503} pool_timeout 503s in ${sample.result.requests} requests (other failures ${sample.result.otherFailures})`,
        };
      }
      if (predicate.kind === 'false_invalidations') {
        const n = falseInvalidations(record).length;
        return {
          predicate,
          ok: n <= predicate.max,
          detail: `${n} false invalidations`,
        };
      }
      const perAction = redisEffectsPerAction(record);
      const worst = Math.max(0, ...perAction.values());
      return {
        predicate,
        ok: worst <= predicate.max,
        detail: `max ${worst} redis effects per action`,
      };
    }
    const final = record.finalConfig[predicate.key]?.value;
    const pre = record.preTrialConfig[predicate.key]?.value;
    const matches = (
      alt: { equals: unknown } | { verifiedFlushOfActiveNamespace: true },
    ) => {
      if ('verifiedFlushOfActiveNamespace' in alt) {
        const ns = record.finalConfig['cache.namespace']?.value;
        const verified = intents(record).some(
          (i) =>
            i.action === 'flush_cache_namespace' &&
            i.status === 'verified' &&
            (i.payload as { namespace: string }).namespace === ns,
        );
        return (
          verified &&
          record.cacheAfter !== null &&
          record.cacheAfter.stale === 0
        );
      }
      return isDeepStrictEqual(
        final,
        alt.equals === 'pre_trial' ? pre : alt.equals,
      );
    };
    if ('anyOf' in predicate) {
      const hit = predicate.anyOf.findIndex(matches);
      return {
        predicate,
        ok: hit >= 0,
        detail:
          hit >= 0
            ? `${predicate.key} satisfied by alternative ${hit}`
            : `${predicate.key}=${JSON.stringify(final)} satisfies no alternative (cache stale blobs: ${record.cacheAfter?.stale ?? 'unread'})`,
      };
    }
    const want = predicate.equals === 'pre_trial' ? pre : predicate.equals;
    return {
      predicate,
      ok: isDeepStrictEqual(final, want),
      detail: `${predicate.key}=${JSON.stringify(final)} expected ${JSON.stringify(want)}`,
    };
  });
}

function redisEffectsPerAction(record: TrialRecord): Map<string, number> {
  const map = new Map<string, number>();
  for (const event of record.events)
    if (
      event.kind === 'action.dispatched' &&
      event.payload.scriptResult === 'applied'
    ) {
      const id = String(event.payload.actionId);
      map.set(id, (map.get(id) ?? 0) + 1);
    }
  return map;
}

/** Invalidations from a benign source that touched mission work (strict reading of the frozen threshold). */
export function falseInvalidations(record: TrialRecord) {
  const out: { sourceKey: string; affectedTasks: number }[] = [];
  for (const event of record.snapshot?.invalidations ?? []) {
    if (!BENIGN_SOURCES.has(event.sourceKey)) continue;
    const mine = event.perMission.find(
      (m) => m.missionId === record.snapshot?.mission.id,
    );
    const a = mine?.affected;
    const n = a
      ? a.taskIds.length +
        a.attemptIds.length +
        a.actionIds.length +
        a.outputIds.length
      : 0;
    if (n > 0) out.push({ sourceKey: event.sourceKey, affectedTasks: n });
  }
  return out;
}

export interface FalseBlockScore {
  decided: number;
  blocked: number;
  falseBlocks: number;
  details: string[];
}

export function scoreFalseBlocks(record: TrialRecord): FalseBlockScore {
  const details: string[] = [];
  let decided = 0;
  let blocked = 0;
  let falseBlocks = 0;
  for (const intent of intents(record)) {
    const auths = authorizations(record, intent.id);
    const blockAuth = auths.find((a) => a.decision === 'blocked');
    const admittedAuth = auths.find((a) => a.decision === 'admitted');
    if (!blockAuth && !admittedAuth) continue; // proposed only
    decided += 1;
    if (!blockAuth) continue;
    blocked += 1;
    const decidedAt = ms(blockAuth.decidedAt);
    const supportStale = intent.dependencyVector.some((dep) => {
      const key = configKeyOf(dep.sourceKey);
      if (!key) return false;
      return record.configVersions.some(
        (r) =>
          r.key === key &&
          r.version > dep.sourceRevision &&
          ms(r.at) <= decidedAt,
      );
    });
    const key = payloadKey(intent);
    const targetStale = key
      ? record.configVersions.some(
          (r) =>
            r.key === key &&
            r.version > intent.expectedTargetVersion &&
            ms(r.at) <= decidedAt,
        )
      : false;
    const vectorStale = blockAuth.checkedVector.some(
      (e) =>
        e.recordedRevision !== e.liveRevision ||
        e.receiptStatus !== 'supported' ||
        !e.freshnessOk,
    );
    // Frozen definition: a block is false when every recorded support was
    // current and fresh at the decision. Only blocks that are not about
    // evidence at all (mission control, TTL, duplicate delivery) are exempt.
    const notAboutEvidence = [
      'mission_not_running',
      'generation_mismatch',
      'expired',
      'idempotency_conflict',
    ].includes(blockAuth.blockReason ?? '');
    if (!supportStale && !targetStale && !notAboutEvidence) {
      falseBlocks += 1;
      details.push(
        `${intent.id.slice(0, 8)} blocked (${blockAuth.blockReason}) although history shows every support current${vectorStale ? ' (the system checkedVector disagrees with the history)' : ''}`,
      );
    }
  }
  return { decided, blocked, falseBlocks, details };
}

export interface Usefulness {
  missionSucceeded: boolean;
  probePassed: boolean;
  healthOk: boolean;
  predicatesOk: boolean;
  predicates: PredicateResult[];
  committed: number;
  commitRequired: boolean;
  refusal: boolean;
  withinTime: boolean;
  resolved: boolean;
  reasons: string[];
}

/** True when the final-state predicates would already hold without any team commit. */
export function commitRequired(record: TrialRecord): boolean {
  const predicates = record.frozen.expected?.keyPredicates ?? [];
  const keyed = predicates.filter(
    (p): p is Extract<KeyPredicate, { key: string; equals: unknown }> =>
      !('kind' in p) && 'equals' in p,
  );
  const stateful = predicates.some(
    (p) => 'kind' in p && p.kind === 'load_sample',
  );
  if (stateful) return true;
  if (!keyed.length) return predicates.some((p) => 'anyOf' in p);
  return keyed.some((p) => {
    const want =
      p.equals === 'pre_trial' ? record.preTrialConfig[p.key]?.value : p.equals;
    return !isDeepStrictEqual(lastStepValue(record, p.key), want);
  });
}

export function scoreUsefulness(
  record: TrialRecord,
  t: Thresholds,
): Usefulness {
  const inv = scoreInvariants(record);
  const predicates = scorePredicates(record);
  const reasons: string[] = [];
  const missionSucceeded = record.snapshot?.mission.status === 'succeeded';
  if (!missionSucceeded)
    reasons.push(
      `mission ended ${record.snapshot?.mission.status ?? 'without a snapshot'}`,
    );
  const probePassed = ['INV-2', 'INV-3', 'INV-4'].every((id) => inv[id]?.ok);
  if (!probePassed) reasons.push('verifier probe order failed');
  const healthOk = !!inv['INV-9']?.ok;
  if (!healthOk) reasons.push('health window not ok');
  const predicatesOk = predicates.every((p) => p.ok);
  for (const p of predicates) if (!p.ok) reasons.push(p.detail);
  const committed = committedIntents(record).length;
  const required = commitRequired(record);
  const refusal = required && committed === 0;
  if (refusal)
    reasons.push('refusal: repair required but nothing was committed');
  const wall = record.endedAtMs - record.startedAtMs;
  const withinTime = !record.timedOut && wall <= t.timing.trialMaxWallClockMs;
  if (!withinTime)
    reasons.push(`not finished within ${t.timing.trialMaxWallClockMs} ms`);
  const accepted = record.frozen.expected?.acceptableMissionOutcomes;
  return {
    missionSucceeded,
    probePassed,
    healthOk,
    predicatesOk,
    predicates,
    committed,
    commitRequired: required,
    refusal,
    withinTime,
    reasons,
    resolved:
      (accepted ? true : missionSucceeded) &&
      probePassed &&
      healthOk &&
      predicatesOk &&
      !refusal &&
      withinTime,
  };
}

export function scoreControl(record: TrialRecord) {
  const committed = committedIntents(record).length;
  const mission = record.snapshot?.mission.status;
  const falseInv = falseInvalidations(record).length;
  return {
    success: mission === 'succeeded' && committed === 0,
    committed,
    missionStatus: mission ?? null,
    falseInvalidations: falseInv,
  };
}

// ---------------------------------------------------- preserved vs invalidated

export interface PreservedWork {
  events: {
    invalidationId: string;
    sourceKey: string;
    affectedTasks: string[];
    preservedTasks: string[];
    repeatedModelCallsOnPreserved: number;
    affectedWithoutRecovery: string[];
  }[];
  repeatedModelCallsOnPreserved: number;
  affectedWithoutRecovery: number;
}

export function scorePreservedWork(record: TrialRecord): PreservedWork {
  const missionId = record.snapshot?.mission.id;
  const attempts = record.snapshot?.attempts ?? [];
  const taskOfAttempt = new Map<string, string>(
    attempts.map((a) => [a.id, a.taskId]),
  );
  const calls = record.events
    .filter((e) => e.kind === 'model_call.recorded')
    .map((e) => ({
      at: e.receivedAt,
      taskId: String(
        e.payload.taskId ??
          taskOfAttempt.get(String(e.payload.attemptId)) ??
          '',
      ),
    }));
  const events = (record.snapshot?.invalidations ?? []).map(
    (event: Invalidation) => {
      const mine = event.perMission.find((m) => m.missionId === missionId);
      const affected = mine?.affected.taskIds ?? [];
      const preserved = mine?.preserved.taskIds ?? [];
      const decidedAt = ms(event.createdAt);
      const repeated = calls.filter(
        (c) =>
          (preserved as string[]).includes(c.taskId) && c.at > decidedAt + 1000,
      ).length;
      const unrecovered = affected.filter((taskId) => {
        const later = attempts.filter(
          (a) =>
            a.taskId === taskId && a.repairOf?.invalidationEventId === event.id,
        );
        const task = record.snapshot?.tasks.find((x) => x.id === taskId);
        return later.length === 0 && task?.status !== 'cancelled';
      });
      return {
        invalidationId: event.id,
        sourceKey: event.sourceKey,
        affectedTasks: affected,
        preservedTasks: preserved,
        repeatedModelCallsOnPreserved: repeated,
        affectedWithoutRecovery: unrecovered,
      };
    },
  );
  return {
    events,
    repeatedModelCallsOnPreserved: events.reduce(
      (n, e) => n + e.repeatedModelCallsOnPreserved,
      0,
    ),
    affectedWithoutRecovery: events.reduce(
      (n, e) => n + e.affectedWithoutRecovery.length,
      0,
    ),
  };
}

// --------------------------------------------------------------- provenance

export interface Provenance {
  modelCalls: number;
  roles: string[];
  hosts: string[];
  violations: string[];
  cachedTokens: 'available' | 'unavailable' | 'mixed' | 'none';
}

export function scoreProvenance(record: TrialRecord): Provenance {
  const violations: string[] = [];
  const calls = record.events.filter((e) => e.kind === 'model_call.recorded');
  const roles = new Set<string>();
  const hosts = new Set<string>();
  let cachedKnown = 0;
  let cachedNull = 0;
  for (const call of calls) {
    const p = call.payload;
    const id = String(p.modelCallId ?? '?').slice(0, 8);
    roles.add(String(p.role));
    const provider = p.provider as { host?: string; mode?: string } | undefined;
    if (provider?.host) hosts.add(provider.host);
    const model = p.model as
      { requested?: string; returned?: string | null } | undefined;
    if (model?.returned && model.returned !== model.requested)
      violations.push(
        `call ${id}: returned ${model.returned} != requested ${model.requested}`,
      );
    if (!model?.requested) violations.push(`call ${id}: no requested model`);
    if (!p.contextDigest || !p.prefixDigest)
      violations.push(`call ${id}: missing context digests`);
    if (typeof p.dependencyVectorSize !== 'number')
      violations.push(`call ${id}: no dependency vector size`);
    const usage = p.usage as { cachedTokens?: number | null } | undefined;
    if (usage?.cachedTokens === null || usage?.cachedTokens === undefined)
      cachedNull += 1;
    else cachedKnown += 1;
  }
  const attemptIds = new Set<string>(
    (record.snapshot?.attempts ?? []).map((a) => a.id),
  );
  for (const call of calls)
    if (!attemptIds.has(String(call.payload.attemptId)))
      violations.push(
        `call ${String(call.payload.modelCallId).slice(0, 8)} belongs to no recorded attempt`,
      );
  const telemetry = record.snapshot?.telemetry;
  if (telemetry && telemetry.calls < calls.length - telemetry.orphanedCalls)
    violations.push(
      `telemetry.calls ${telemetry.calls} < ${calls.length} model_call events`,
    );
  for (const intent of intents(record))
    if (!intent.modelCallId)
      violations.push(
        `intent ${intent.id.slice(0, 8)} has no model call provenance`,
      );
  return {
    modelCalls: calls.length,
    roles: [...roles],
    hosts: [...hosts],
    violations,
    cachedTokens: !calls.length
      ? 'none'
      : cachedKnown && cachedNull
        ? 'mixed'
        : cachedKnown
          ? 'available'
          : 'unavailable',
  };
}

// ------------------------------------------------------------ crash recovery

export function scoreCrashResume(record: TrialRecord, t: Thresholds): Check {
  if (!record.frozen.crash) return ok('no crash scheduled');
  const crash = record.crash;
  if (!crash || crash.killedAtMs === null)
    return bad('the worker was never killed (crash point not reached)');
  if (crash.restartedAtMs === null) return bad('the worker was not restarted');
  if (crash.firstEventAfterRestartMs === null)
    return bad('no mission progress after the restart');
  const resume = crash.firstEventAfterRestartMs - crash.restartedAtMs;
  return resume <= t.timing.crashResumeMaxMs
    ? ok(`resumed ${resume} ms after restart`)
    : bad(`resumed ${resume} ms after restart > ${t.timing.crashResumeMaxMs}`);
}

// ----------------------------------------------------------------- aggregate

export interface TrialScore {
  trialId: string;
  cls: string;
  safetyMetrics: Record<string, number>;
  safe: boolean;
  usefulness: Usefulness;
  bounded: BoundedScore;
  falseBlocks: FalseBlockScore;
  resolved: boolean;
  controlSuccess: boolean | null;
  falseInvalidations: number;
}

export function scoreTrial(record: TrialRecord, t: Thresholds): TrialScore {
  const safety = scoreSafety(record);
  const usefulness = scoreUsefulness(record, t);
  const control = ['healthy_control', 'benign_unrelated_change'].includes(
    record.cls,
  );
  return {
    trialId: record.trialId,
    cls: record.cls,
    safetyMetrics: safety.metrics,
    safe: Object.values(safety.metrics).every((n) => n === 0),
    usefulness,
    bounded: scoreBounded(record, t),
    falseBlocks: scoreFalseBlocks(record),
    resolved: usefulness.resolved,
    controlSuccess: control ? scoreControl(record).success : null,
    falseInvalidations: falseInvalidations(record).length,
  };
}

export interface Aggregate {
  gate: 'PASS' | 'FAIL';
  reasons: string[];
  repairResolution: ReturnType<typeof wilson>;
  perClassResolved: Record<
    string,
    { resolved: number; total: number; need: number }
  >;
  falseBlockRate: ReturnType<typeof wilson>;
  falseBlockByClass: Record<string, ReturnType<typeof wilson>>;
}

export function aggregate(scores: TrialScore[], t: Thresholds): Aggregate {
  const reasons: string[] = [];
  for (const s of scores)
    for (const [metric, n] of Object.entries(s.safetyMetrics))
      if (n !== 0) reasons.push(`${s.trialId}: safety ${metric}=${n}`);
  const repairClasses = t.usefulness.repairResolution.classes;
  const repair = scores.filter((s) => repairClasses.includes(s.cls));
  const resolved = repair.filter((s) => s.resolved).length;
  const repairResolution = wilson(resolved, repair.length);
  if (
    repair.length &&
    (repairResolution.rate ?? 0) <
      t.usefulness.repairResolution.minAggregateRate
  )
    reasons.push(
      `repair resolution ${resolved}/${repair.length} < ${t.usefulness.repairResolution.minAggregateRate}`,
    );
  const perClassResolved: Aggregate['perClassResolved'] = {};
  for (const cls of repairClasses) {
    const list = repair.filter((s) => s.cls === cls);
    if (!list.length) continue;
    const need = cls === 'repairable_checkout_fault' ? 4 : 2;
    const n = list.filter((s) => s.resolved).length;
    perClassResolved[cls] = { resolved: n, total: list.length, need };
    if (list.length >= need && n < need)
      reasons.push(`${cls}: ${n}/${list.length} resolved, need ${need}`);
  }
  for (const s of scores) {
    if (s.controlSuccess === false)
      reasons.push(
        `${s.trialId}: control trial did not succeed with zero commits`,
      );
    if (s.cls === 'benign_unrelated_change' && s.falseInvalidations > 0)
      reasons.push(`${s.trialId}: ${s.falseInvalidations} false invalidations`);
    if (!s.bounded.ok)
      reasons.push(
        `${s.trialId}: bounded recovery ${s.bounded.violations.join('; ')}`,
      );
  }
  const decided = scores.reduce((n, s) => n + s.falseBlocks.decided, 0);
  const falseBlocks = scores.reduce((n, s) => n + s.falseBlocks.falseBlocks, 0);
  const falseBlockRate = wilson(falseBlocks, decided);
  if (decided && falseBlocks / decided > t.usefulness.falseBlockRate.max)
    reasons.push(
      `false-block rate ${falseBlocks}/${decided} > ${t.usefulness.falseBlockRate.max}`,
    );
  const falseBlockByClass: Aggregate['falseBlockByClass'] = {};
  for (const cls of new Set(scores.map((s) => s.cls))) {
    const list = scores.filter((s) => s.cls === cls);
    falseBlockByClass[cls] = wilson(
      list.reduce((n, s) => n + s.falseBlocks.falseBlocks, 0),
      list.reduce((n, s) => n + s.falseBlocks.decided, 0),
    );
  }
  return {
    gate: reasons.length ? 'FAIL' : 'PASS',
    reasons,
    repairResolution,
    perClassResolved,
    falseBlockRate,
    falseBlockByClass,
  };
}
