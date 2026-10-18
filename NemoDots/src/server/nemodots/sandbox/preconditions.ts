// Scenario preconditions (injector finding: a fault whose symptom never
// appeared silently turned a fault trial into a no-fault trial; a cold cache
// holds nothing for a schema bump to mismatch).
//
// A manifest declares what must be true before a mission may start:
//
//   setup    actions that establish the fault's prerequisites through NORMAL
//            checkout reads (warm_cache: the catalogue and the health canary
//            are read so the cache holds entries under the baseline schema)
//   visible  symptoms that must show through the SAME readers an agent has
//            (checkout.health, checkout.metrics, checkout.inventory/<sku>,
//            redis.stats) once the initial steps have been applied
//
// Nothing here writes configuration or reads control.*/ledger.*/coordinator.*,
// and nothing here is shown to an agent: the symptom names live in the
// injector-private manifest, the readers return only what they always return.
import type { Scope } from '../contracts/ids.js';
import type { SourceReaderPort } from '../contracts/ports.js';
import type { Preconditions, SymptomKind } from './manifest.js';
import { CONFIG_CACHE_MS } from './checkout-db.js';
import { SCARCE_SKU } from './seed.js';

export type PreconditionStatus = 'verified' | 'failed' | 'unchecked';

export interface PreconditionReport {
  status: PreconditionStatus;
  /** why a report is `unchecked` */
  reason?: 'no_preconditions_declared' | 'no_verifier_configured';
  setup: { kind: string; ok: boolean; detail: string }[];
  visible: { symptom: SymptomKind; seen: boolean; detail: string }[];
  failure?: {
    phase: 'setup' | 'initial_steps' | 'visible';
    message: string;
    /** the caller cancelled the run while it was being verified */
    cancelled?: true;
  };
  elapsedMs: number;
}

export type SymptomReader = (key: string) => Promise<{
  normalizedValue: unknown;
}>;

export interface PreconditionDeps {
  /** A reader as the agents have it (readers.ts); fixtures may supply their own. */
  read: SymptomReader;
  checkoutUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll period while waiting for a symptom (default 250 ms). */
  pollMs?: number;
  /**
   * Pause before the first look (default: the checkout's configuration cache
   * plus a margin). The checkout serves the previous configuration until its
   * cache expires; a health read in that window would write the canary under
   * the OLD schema and so create the very mismatch the scenario is supposed to
   * establish by itself.
   */
  settleMs?: number;
  /** SKUs inspected for inventory_inconsistent, first match wins. */
  inventorySkus?: readonly string[];
}

/** Longer than the checkout's configuration cache, so the first look sees the injected configuration. */
export const CONFIG_VIEW_SETTLE_MS = CONFIG_CACHE_MS + 100;

/** Window in which every declared symptom must be seen (default). */
export const DEFAULT_SYMPTOM_WITHIN_MS = 15_000;

export class ScenarioPreconditionFailed extends Error {
  readonly code = 'scenario_precondition_failed';
  constructor(
    readonly scenarioId: string,
    readonly runId: string,
    readonly report: PreconditionReport,
  ) {
    super(
      `scenario_precondition_failed: ${scenarioId}: ${report.failure?.message ?? 'precondition not established'}`,
    );
    this.name = 'ScenarioPreconditionFailed';
  }
}

/**
 * Preconditions verified through the production readers. The checkout readers
 * ignore the scope, but the port requires one, so the caller supplies it.
 */
export function preconditionDepsFromReaders(
  readers: SourceReaderPort,
  scope: Scope,
  rest: Omit<PreconditionDeps, 'read'>,
): PreconditionDeps {
  return {
    ...rest,
    read: (key) =>
      readers.read(key as Parameters<SourceReaderPort['read']>[0], scope),
  };
}

export function uncheckedReport(
  reason: NonNullable<PreconditionReport['reason']>,
): PreconditionReport {
  return { status: 'unchecked', reason, setup: [], visible: [], elapsedMs: 0 };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
const hasError = (health: Record<string, unknown>, name: string) =>
  Array.isArray(health.errors) && health.errors.includes(name);
const checkOf = (health: Record<string, unknown>, name: string) =>
  asRecord(health.checks)[name];

type Probe = { seen: boolean; detail: string };

/** One look at the readers per symptom. Health is read first: it records a decode error into /metrics. */
async function look(
  symptom: SymptomKind,
  deps: PreconditionDeps,
): Promise<Probe> {
  const health = async () =>
    asRecord((await deps.read('checkout.health')).normalizedValue);
  switch (symptom) {
    case 'healthy': {
      const body = await health();
      return { seen: body.status === 'ok', detail: `health ${body.status}` };
    }
    case 'cache_decode_error': {
      const body = await health();
      const metrics = asRecord(
        (await deps.read('checkout.metrics')).normalizedValue,
      );
      const inHealth = hasError(body, 'cache_decode_error');
      const inMetrics = metrics.cacheDecodeError != null;
      return {
        seen: inHealth && inMetrics,
        detail: `health ${inHealth ? 'reports' : 'does not report'} the decode error, metrics ${inMetrics ? 'reports' : 'does not report'} it`,
      };
    }
    case 'pool_exhausted': {
      const body = await health();
      const seen = hasError(body, 'pool_exhausted');
      return {
        seen,
        detail: `health ${body.status}, pool_exhausted ${seen ? 'reported' : 'not reported'}`,
      };
    }
    case 'writes_disabled': {
      const body = await health();
      const seen =
        checkOf(body, 'writes') === false && hasError(body, 'writes_disabled');
      return {
        seen,
        detail: `health ${body.status}, writes check ${String(checkOf(body, 'writes'))}`,
      };
    }
    case 'inventory_inconsistent': {
      const skus = deps.inventorySkus ?? [
        SCARCE_SKU,
        'SKU-0001',
        'SKU-0002',
        'SKU-0003',
      ];
      for (const sku of skus) {
        const view = asRecord(
          (await deps.read(`checkout.inventory/${sku}`)).normalizedValue,
        );
        if (view.consistent === false)
          return {
            seen: true,
            detail: `${sku}: API view and authority disagree`,
          };
      }
      return {
        seen: false,
        detail: `${skus.join(', ')}: API view and authority agree`,
      };
    }
  }
}

async function get(deps: PreconditionDeps, path: string) {
  const doFetch = deps.fetch ?? fetch;
  try {
    return (
      await doFetch(`${deps.checkoutUrl}${path}`, {
        signal: AbortSignal.timeout(5_000),
      })
    ).status;
  } catch {
    return null;
  }
}

/** Runs the declared setup actions; one entry per action. */
export async function runSetup(
  declared: Preconditions,
  deps: PreconditionDeps,
): Promise<PreconditionReport['setup']> {
  const out: PreconditionReport['setup'] = [];
  for (const action of declared.setup ?? []) {
    // warm_cache: normal reads write the catalogue and canary entries under
    // the schema the checkout is configured with right now.
    const [products, health] = [
      await get(deps, '/products'),
      await get(deps, '/health'),
    ];
    const redis = asRecord((await deps.read('redis.stats')).normalizedValue);
    const schema = asRecord(
      (await deps.read('checkout.config/cache.schema_version')).normalizedValue,
    ).value;
    const counts = asRecord(redis.keyCounts);
    const suffix = `${String(redis.activeNamespace)}:v${String(schema)}`;
    const held = typeof counts[suffix] === 'number' ? counts[suffix] : 0;
    const ok =
      redis.reachable === true && (held as number) > 0 && products === 200;
    out.push({
      kind: action.kind,
      ok,
      detail:
        redis.reachable !== true
          ? 'redis.stats is unreachable: the cache cannot be warmed or checked'
          : `/products ${products ?? 'unreachable'}, /health ${health ?? 'unreachable'}, ${held as number} cache entries under ${suffix}`,
    });
  }
  return out;
}

/**
 * Polls until every declared symptom has been seen, or `withinMs` passes. The
 * symptoms are checked together: all must be visible in the same sweep, so the
 * mission starts in a world where they co-exist.
 */
export async function verifyVisible(
  declared: Preconditions,
  deps: PreconditionDeps,
  stop: () => boolean = () => false,
): Promise<PreconditionReport['visible']> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 250;
  const deadline = now() + (declared.withinMs ?? DEFAULT_SYMPTOM_WITHIN_MS);
  const wanted = [...new Set(declared.visible)];
  await sleep(deps.settleMs ?? CONFIG_VIEW_SETTLE_MS);
  for (;;) {
    const sweep: PreconditionReport['visible'] = [];
    for (const symptom of wanted) {
      let probe: Probe;
      try {
        probe = await look(symptom, deps);
      } catch (error) {
        probe = {
          seen: false,
          detail: `reader failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      sweep.push({ symptom, ...probe });
    }
    if (sweep.every((entry) => entry.seen) || now() >= deadline || stop())
      return sweep;
    await sleep(pollMs);
  }
}
