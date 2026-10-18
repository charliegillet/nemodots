# Database pool sizing semantics

## `db.pool_max`

- The maximum number of simultaneous PostgreSQL connections the API opens. Requests that cannot get a connection wait, then fail with `pool_timeout` (HTTP 503).
- Value domain: integer from 1 to 20.
- Too small a pool under concurrent load starves requests; the symptom is intermittent 503 errors while PostgreSQL itself is healthy. `checkout.health` then shows a degraded status with a pool-related error class and `checkout.metrics` shows the same error class.

## `db.statement_timeout_ms`

- How long one SQL statement may run before PostgreSQL cancels it. A statement that waits for a connection and then needs a long time compounds pool starvation.
- Value domain: integer from 50 to 30000.
- Very low values cancel legitimate statements; very high values let slow statements hold connections.

## Reasoning

- Raise the pool before touching the timeout when the error class is a pool timeout. Change one key at a time and re-observe `checkout.health` afterwards.
- Do not raise the pool to the top of its domain by default; PostgreSQL has its own connection limit. Choose a value you can justify from the evidence.
