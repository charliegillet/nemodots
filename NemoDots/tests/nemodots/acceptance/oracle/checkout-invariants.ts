// Checkout data-integrity invariants checked by the verifier with its own
// `nemodots_verifier` connection and its own HTTP requests (TEST_PROMPT gate
// 6; ARCHITECTURE 3, 9.1, 9.5). Nothing here uses the production probe:
// the production probe is itself under test.

export const BUSINESS_TABLES = [
  'checkout.products',
  'checkout.inventory',
  'checkout.orders',
  'checkout.order_items',
] as const;

export const CONFIG_TABLES = [
  'checkout.config_entries',
  'checkout.config_versions',
  'checkout.config_collection',
] as const;

/**
 * Business hash definition (H). For each business table, select every row,
 * drop volatile columns, exclude probe-tagged rows (orders with a non-null
 * `probe_run_id` and their order_items), sort by primary key, canonical-JSON
 * encode (keys sorted), and SHA-256 the array of per-table digests in the
 * order of BUSINESS_TABLES. For `checkout.inventory`, the quantity of every
 * SKU is normalized by adding back the quantities of probe-tagged order
 * items for that SKU, so a probe order leaves H unchanged.
 */
export const BUSINESS_HASH = {
  volatileColumns: ['updated_at', 'created_at', 'reserved_at', 'last_read_at'],
  probeColumn: 'probe_run_id',
  inventoryNormalization: 'add_back_probe_order_items',
} as const;

export interface InvariantSpec {
  id: string;
  title: string;
  phase: 'read_only' | 'probe' | 'repair' | 'window';
  rule: string;
}

export const CHECKOUT_INVARIANTS: readonly InvariantSpec[] = [
  {
    id: 'INV-1',
    title: 'read-only phase leaves business data untouched',
    phase: 'read_only',
    rule:
      'H(before) == H(after) across any number of GET /health, /ready, /products, /inventory/:sku, /metrics, /orders/:id requests and every agent observation; raw row counts of all four business tables unchanged',
  },
  {
    id: 'INV-2',
    title: 'one fresh probe order creates exactly one order',
    phase: 'probe',
    rule:
      'after POST /orders for {sku: PROBE-SKU, quantity: q} tagged with the verifier run id: exactly +1 row in checkout.orders with probe_run_id = run id; exactly +1 row in checkout.order_items for that order with the same sku and quantity q; zero other new or changed rows in orders/order_items',
  },
  {
    id: 'INV-3',
    title: 'inventory decrements by exactly the ordered quantity',
    phase: 'probe',
    rule:
      'inventory(PROBE-SKU).quantity after == before - q; every other inventory row byte-identical (ignoring volatile columns); products byte-identical',
  },
  {
    id: 'INV-4',
    title: 'the order reads back',
    phase: 'probe',
    rule:
      'GET /orders/:id returns 200 with the same id, sku and quantity; a second GET returns the same body; H unchanged by the reads',
  },
  {
    id: 'INV-5',
    title: 'the probe order does not move observed evidence',
    phase: 'probe',
    rule:
      'the normalized values of checkout.orders.recent and checkout.inventory/<sku> are identical before and after the probe (probe rows excluded); no invalidation event cites them',
  },
  {
    id: 'INV-6',
    title: 'only permitted configuration changes',
    phase: 'repair',
    rule:
      'every checkout.config_versions row created during the trial is either an injected step of the scenario (caused_by_actor injector) or caused by a committed action intent on a key in the scenario allowedMutationKeys; keys outside that set equal their pre-trial values at the end',
  },
  {
    id: 'INV-7',
    title: 'no commit under an obsolete version',
    phase: 'repair',
    rule:
      'for every config_versions row with caused_by_action_id X: row.version - 1 == intent(X).expectedTargetVersion, and every controlled entry of intent(X).dependencyVector had live version == recorded revision at the row commit (checked from history: no other config_versions row on those keys between the recorded revision and the commit)',
  },
  {
    id: 'INV-8',
    title: 'agents never write business tables',
    phase: 'repair',
    rule:
      'apart from probe-tagged rows and the verifier load generator (read-only GETs), H at trial end == H at trial start',
  },
  {
    id: 'INV-9',
    title: 'health stays ok over the window',
    phase: 'window',
    rule:
      'GET /health sampled every 2000 ms by the verifier for windowMs returns status ok on every sample; sample count >= floor(windowMs / 2000)',
  },
];

/** Verifier probe parameters: the SKU is fixed by ARCHITECTURE 9.5. */
export const PROBE = {
  sku: 'PROBE-SKU',
  header: 'X-NemoDots-Probe',
  sampleIntervalMs: 2000,
  defaultWindowMs: 20_000,
} as const;
