// The independent acceptance probe (ARCHITECTURE.md section 9.5). An LLM saying
// "fixed" is not acceptance: the probe places exactly ONE tagged PROBE-SKU
// order through the real checkout API, reads it back, checks the data
// invariants with separate read access (role nemodots_verifier), and observes
// /health across a window.
//
// Invariants (names appear in the verdict; the first failing ones name the
// violated property):
//   order_created                 POST /orders -> 201
//   order_readback                GET /orders/:id returns the order that was placed
//   inventory_decremented_exactly authority stock fell by exactly the ordered quantity
//   inventory_view_consistent     the API's inventory view equals the authority
//   no_negative_inventory         no inventory row below zero (no oversell)
//   business_data_unchanged       products, other inventory and every non-probe
//                                 order/item are byte-identical before and after
//   health_window_ok              /health was `ok` on every sample in the window
//
// The probe assumes no other business writes while it runs (it is run against a
// quiescent checkout); a concurrent customer order would show up as
// business_data_unchanged = false, which is the honest outcome.
//
// Probe runs are SERIALIZED: within a process by a queue, across processes
// (the CLI probe next to an in-process run, two missions) by a session-level
// advisory lock on a dedicated verifier connection. Two overlapping runs would
// otherwise each see the other's PROBE-SKU decrement and both fail on a
// healthy checkout.
//
// Every probe request (POST /orders, GET /orders/:id, GET /inventory/...)
// carries the authenticated probe header, so the checkout keeps them out of its
// metrics windows: running the acceptance probe never changes the normalized
// `checkout.metrics` value (ARCHITECTURE 9.4, finding D2).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { MissionId } from '../contracts/ids.js';
import type { ObservationReceipt } from '../contracts/observation.js';
import type { ProbePort } from '../contracts/ports.js';
import { PROBE_SKU } from './constants.js';
import { probeHeaderValue } from './probe-auth.js';

export const PROBE_INVARIANTS = [
  'order_created',
  'order_readback',
  'inventory_decremented_exactly',
  'inventory_view_consistent',
  'no_negative_inventory',
  'business_data_unchanged',
  'health_window_ok',
] as const;
export type ProbeInvariantName = (typeof PROBE_INVARIANTS)[number];

export interface ProbeResult {
  verdict: 'pass' | 'fail';
  invariants: { name: ProbeInvariantName; ok: boolean }[];
  healthWindow: { samples: number; okSamples: number; allOk: boolean };
  /** Diagnostic detail for the operator; never part of the normalized value. */
  detail: Record<string, unknown>;
}

/** The normalized value of the `checkout.acceptance` receipt (no run id, no secret). */
export function acceptanceNormalizedValue(result: ProbeResult) {
  return {
    verdict: result.verdict,
    invariants: result.invariants,
    healthWindow: result.healthWindow,
  };
}

/** Advisory-lock key serializing probe runs across processes. */
export const PROBE_LOCK_KEY = 'nemodots.acceptance-probe';

export interface ProbeDeps {
  /**
   * SELECT on checkout.* (role nemodots_verifier). With `connect` (a Pool) the
   * probe also serializes across processes with an advisory lock.
   */
  verifier: Pick<pg.Pool, 'query'> & Partial<Pick<pg.Pool, 'connect'>>;
  checkoutUrl: string;
  probeSecret: string;
  /** NEMODOTS_PROBE_WINDOW_MS (default 20000). */
  windowMs: number;
  sampleIntervalMs?: number;
  fetch?: typeof fetch;
  /**
   * Registers the `checkout.acceptance` receipt (trust: probe). Supplied by the
   * bootstrap from the ledger; the sandbox never imports the ledger.
   */
  register?: (
    missionId: MissionId,
    result: ProbeResult,
  ) => Promise<ObservationReceipt>;
}

/** Tail of the in-process probe queue. */
let queue: Promise<void> = Promise.resolve();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createProbe(deps: ProbeDeps): ProbePort & {
  execute(): Promise<ProbeResult>;
} {
  const doFetch = deps.fetch ?? fetch;
  const interval = deps.sampleIntervalMs ?? 2_000;

  async function call(path: string, init?: RequestInit) {
    try {
      const response = await doFetch(`${deps.checkoutUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return {
        status: response.status,
        body: body as Record<string, unknown> | null,
      };
    } catch {
      return { status: 0, body: null };
    }
  }

  async function authorityQuantity() {
    const row = await deps.verifier.query<{ quantity: number }>(
      'SELECT quantity FROM checkout.inventory WHERE sku = $1',
      [PROBE_SKU],
    );
    return row.rows.length ? row.rows[0].quantity : null;
  }

  async function businessHash() {
    const row = await deps.verifier.query<Record<string, string>>(
      `SELECT
         md5(COALESCE((SELECT string_agg(sku||'|'||name||'|'||category||'|'||price_cents||'|'||listed, ';' ORDER BY sku)
                         FROM checkout.products), '')) AS products,
         md5(COALESCE((SELECT string_agg(sku||'|'||quantity, ';' ORDER BY sku)
                         FROM checkout.inventory WHERE sku <> $1), '')) AS inventory,
         md5(COALESCE((SELECT string_agg(o.id||'|'||o.status||'|'||o.customer||'|'||o.total_cents, ';' ORDER BY o.id)
                         FROM checkout.orders o WHERE o.probe_run_id IS NULL), '')) AS orders,
         md5(COALESCE((SELECT string_agg(i.order_id||'|'||i.sku||'|'||i.quantity||'|'||i.price_cents, ';' ORDER BY i.order_id, i.sku, i.id)
                         FROM checkout.order_items i JOIN checkout.orders o ON o.id = i.order_id
                        WHERE o.probe_run_id IS NULL), '')) AS items`,
      [PROBE_SKU],
    );
    return JSON.stringify(row.rows[0]);
  }

  async function execute(): Promise<ProbeResult> {
    const runId = `probe-${randomUUID()}`;
    const tag = {
      'x-nemodots-probe': probeHeaderValue(deps.probeSecret, runId),
    };
    const ordered = 1;
    const before = await authorityQuantity();
    const hashBefore = await businessHash();

    const created = await call('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tag },
      body: JSON.stringify({
        customer: 'nemodots-probe',
        items: [{ sku: PROBE_SKU, quantity: ordered }],
      }),
    });
    const orderId =
      created.status === 201 && typeof created.body?.id === 'string'
        ? created.body.id
        : null;
    const orderCreated = orderId !== null;

    let readbackOk = false;
    if (orderId) {
      const read = await call(`/orders/${orderId}`, { headers: tag });
      const items = Array.isArray(read.body?.items) ? read.body.items : [];
      readbackOk =
        read.status === 200 &&
        read.body?.id === orderId &&
        read.body?.status === 'confirmed' &&
        items.length === 1 &&
        (items[0] as Record<string, unknown>).sku === PROBE_SKU &&
        (items[0] as Record<string, unknown>).quantity === ordered;
    }

    const after = await authorityQuantity();
    const decrementedExactly =
      orderCreated &&
      before !== null &&
      after !== null &&
      before - after === ordered;
    const view = await call(`/inventory/${PROBE_SKU}`, { headers: tag });
    const viewConsistent =
      after !== null && view.status === 200 && view.body?.quantity === after;
    const negatives = await deps.verifier.query<{ n: string }>(
      'SELECT count(*) AS n FROM checkout.inventory WHERE quantity < 0',
    );
    const noNegative = Number(negatives.rows[0].n) === 0;
    const hashAfter = await businessHash();
    const unchanged = hashBefore === hashAfter;

    // Health window: a sample now, then one per interval across the window.
    const total =
      deps.windowMs <= 0 ? 1 : Math.floor(deps.windowMs / interval) + 1;
    let samples = 0;
    let okSamples = 0;
    for (let i = 0; i < total; i += 1) {
      const health = await call('/health');
      samples += 1;
      if (health.status === 200 && health.body?.status === 'ok') okSamples += 1;
      if (i < total - 1) await sleep(interval);
    }
    const healthOk = samples > 0 && okSamples === samples;

    const results: Record<ProbeInvariantName, boolean> = {
      order_created: orderCreated,
      order_readback: readbackOk,
      inventory_decremented_exactly: decrementedExactly,
      inventory_view_consistent: viewConsistent,
      no_negative_inventory: noNegative,
      business_data_unchanged: unchanged,
      health_window_ok: healthOk,
    };
    const invariants = PROBE_INVARIANTS.map((name) => ({
      name,
      ok: results[name],
    }));
    return {
      verdict: invariants.every((i) => i.ok) ? 'pass' : 'fail',
      invariants,
      healthWindow: { samples, okSamples, allOk: healthOk },
      detail: {
        orderStatus: created.status,
        orderError: created.body?.error ?? null,
        inventoryBefore: before,
        inventoryAfter: after,
        apiInventory: view.body?.quantity ?? null,
        apiInventorySource: view.body?.source ?? null,
      },
    };
  }

  // In-process queue: one run at a time per probe instance family (module level
  // so several createProbe() instances in one process also serialize).
  async function serialized(): Promise<ProbeResult> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let lock: pg.PoolClient | undefined;
    try {
      if (deps.verifier.connect) {
        lock = await deps.verifier.connect();
        await lock.query('SELECT pg_advisory_lock(hashtext($1))', [
          PROBE_LOCK_KEY,
        ]);
      }
      return await execute();
    } finally {
      if (lock) {
        try {
          await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [
            PROBE_LOCK_KEY,
          ]);
          lock.release();
        } catch (error) {
          // destroying the connection releases a session-level lock
          lock.release(error as Error);
        }
      }
      release();
    }
  }

  return {
    execute: serialized,
    async run(missionId: MissionId) {
      if (!deps.register)
        throw new Error(
          'probe: no receipt registrar wired (createProbe deps.register)',
        );
      return deps.register(missionId, await serialized());
    },
  };
}
