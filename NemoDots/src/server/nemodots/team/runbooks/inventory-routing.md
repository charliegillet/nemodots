# Inventory routing semantics

## `routing.inventory_source`

- Selects which data source answers inventory reads inside the order path.
- Value domain: one of two enum members, `primary` or `replica_stale`. One reads the authoritative database, the other a replica that lags behind and has stopped catching up.
- Reading a lagging replica makes the quantity the API sees differ from the database quantity. Orders can then still succeed, `/health` can stay `ok`, and stock can be oversold.

## How the symptom shows

- `checkout.inventory/<sku>` reports `consistent: false` when the database quantity and the API quantity differ. Check several SKUs; a single SKU may agree by chance.
- Oversold stock is visible as an inventory quantity that fell below what orders allow.

## Remedy

- Route reads to the authoritative database source. Changing the key does not repair stock that is already wrong; it only stops new reads from using the lagging replica.
- Confirm afterwards by observing `checkout.inventory/<sku>` for more than one SKU.
