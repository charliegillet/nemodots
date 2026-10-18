# Inventory routing and order-write semantics

Inventory routing

- The routing setting chooses where the API reads stock from. One option reads the authority database. The other reads a replica snapshot that can lag behind; its option name ends with `_stale`.
- While reads go to the lagging replica, the API view of a product can disagree with the authority, orders can be accepted against stock that no longer exists and inventory can go negative. Health may still report ok. The per-product inventory source shows the authority value and the API value side by side and whether they agree.
- The authority option is named with the English word meaning "first in rank" (the leading node of a leader and follower pair).
- Customer data safety: never accept a repair that leaves reads on the lagging replica while orders are being placed.

Order writes

- A boolean setting enables or disables order creation. When writes are disabled the checkout answers order requests with a service-unavailable status and class `writes_disabled`, and health degrades. Reads keep working.
- Restoring writes means setting that boolean to the value that permits writes.

Value domains

- Inventory routing: one of the two option names described above.
- Order writes: a boolean.
