# Inventory routing semantics

## `routing.inventory_source`

- Selects which data source answers inventory reads inside the order path.
- Value domain: an enumeration. The members are returned as `valueDomain` when you observe `checkout.config/routing.inventory_source`.
- When the source the API reads from differs in content from the authoritative database row, the quantity the API sees differs from the database quantity. Orders can still succeed and `/health` can stay `ok` while the two quantities disagree.

## What the sources show

- `checkout.inventory/<sku>` reports the database quantity, the quantity the API reports and a `consistent` flag for one SKU. A single SKU may agree by chance; sample more than one.
- A change to this key affects which source future reads use. It does not rewrite stock that orders already consumed.
