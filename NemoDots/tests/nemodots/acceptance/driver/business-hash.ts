// Verifier-owned business hash H (oracle/checkout-invariants.ts BUSINESS_HASH).
// Uses only the `nemodots_verifier` connection and catalog introspection, so
// it does not depend on production readers or the production probe.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  BUSINESS_HASH,
  BUSINESS_TABLES,
} from '../oracle/checkout-invariants.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function columns(client: pg.ClientBase, table: string) {
  const [schema, name] = table.split('.');
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, name],
  );
  if (result.rowCount === 0)
    throw new Error(`Business table ${table} does not exist.`);
  return result.rows.map((row) => row.column_name);
}

async function primaryKey(client: pg.ClientBase, table: string) {
  const result = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
    [table],
  );
  if (result.rowCount === 0)
    throw new Error(`Business table ${table} has no primary key.`);
  return result.rows.map((row) => row.attname);
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface BusinessSnapshot {
  hash: string;
  perTable: Record<string, { rows: number; digest: string }>;
}

/**
 * Computes H. Probe-tagged orders (non-null probe_run_id) and their items
 * are excluded; inventory quantities get the probe items' quantities added
 * back. Column names for the add-back are discovered, and an ambiguous
 * schema throws instead of guessing.
 */
export async function businessSnapshot(
  client: pg.ClientBase,
): Promise<BusinessSnapshot> {
  const perTable: BusinessSnapshot['perTable'] = {};
  const orderCols = await columns(client, 'checkout.orders');
  if (!orderCols.includes(BUSINESS_HASH.probeColumn))
    throw new Error(
      `checkout.orders has no ${BUSINESS_HASH.probeColumn} column.`,
    );
  const orderPk = await primaryKey(client, 'checkout.orders');
  if (orderPk.length !== 1)
    throw new Error('checkout.orders needs a single-column primary key.');
  const itemCols = await columns(client, 'checkout.order_items');
  const fk = itemCols.find((c) => c === 'order_id');
  const skuCol = itemCols.find((c) => c === 'sku');
  const qtyCol = itemCols.find((c) => c === 'quantity' || c === 'qty');
  if (!fk || !skuCol || !qtyCol)
    throw new Error(
      'checkout.order_items needs order_id, sku and quantity columns for H.',
    );

  const probeItems = await client.query<{ sku: string; qty: string }>(
    `SELECT i.${ident(skuCol)} AS sku, SUM(i.${ident(qtyCol)})::text AS qty
       FROM checkout.order_items i JOIN checkout.orders o ON o.${ident(orderPk[0])} = i.${ident(fk)}
      WHERE o.${ident(BUSINESS_HASH.probeColumn)} IS NOT NULL GROUP BY 1`,
  );
  const addBack = new Map(
    probeItems.rows.map((row) => [row.sku, Number(row.qty)]),
  );

  for (const table of BUSINESS_TABLES) {
    const cols = (await columns(client, table)).filter(
      (c) => !(BUSINESS_HASH.volatileColumns as readonly string[]).includes(c),
    );
    const pk = await primaryKey(client, table);
    let where = '';
    if (table === 'checkout.orders')
      where = `WHERE ${ident(BUSINESS_HASH.probeColumn)} IS NULL`;
    if (table === 'checkout.order_items')
      where = `WHERE ${ident(fk)} NOT IN (SELECT ${ident(orderPk[0])} FROM checkout.orders WHERE ${ident(BUSINESS_HASH.probeColumn)} IS NOT NULL)`;
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${cols.map(ident).join(', ')} FROM ${table} ${where} ORDER BY ${pk.map(ident).join(', ')}`,
    );
    let rows = result.rows;
    if (table === 'checkout.inventory') {
      const invQty = cols.find(
        (c) => c === 'quantity' || c === 'qty' || c === 'on_hand',
      );
      const invSku = cols.find((c) => c === 'sku');
      if (!invQty || !invSku)
        throw new Error(
          'checkout.inventory needs sku and quantity columns for H.',
        );
      rows = rows.map((row) => ({
        ...row,
        [invQty]: Number(row[invQty]) + (addBack.get(String(row[invSku])) ?? 0),
      }));
    }
    perTable[table] = { rows: rows.length, digest: sha(canonical(rows)) };
  }
  return {
    hash: sha(canonical(BUSINESS_TABLES.map((t) => perTable[t].digest))),
    perTable,
  };
}
