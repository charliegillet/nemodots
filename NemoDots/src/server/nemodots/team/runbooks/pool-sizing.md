# Database pool sizing semantics

## `db.pool_max`

- The maximum number of simultaneous PostgreSQL connections the API opens. Requests that cannot get a connection wait, then fail with `pool_timeout` (HTTP 503).
- Value domain: integer; the bounds are returned as `valueDomain` when you observe `checkout.config/db.pool_max`.
- A pool smaller than the concurrent demand makes requests wait for a connection and then fail. The failure is reported as an error class in `checkout.health` and `checkout.metrics`.

## `db.statement_timeout_ms`

- How long one SQL statement may run before PostgreSQL cancels it. A statement that waits for a connection and then needs a long time compounds pool starvation.
- Value domain: integer; the bounds are returned as `valueDomain` when you observe `checkout.config/db.statement_timeout_ms`.
- Very low values cancel legitimate statements; very high values let slow statements hold connections.

## Limits

- PostgreSQL has its own connection limit, so the top of the pool's domain is not free: every connection the API opens counts against it.
