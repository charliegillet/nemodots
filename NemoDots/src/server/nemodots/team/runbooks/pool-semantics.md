# Database pool and timeout semantics

- The pool setting is the maximum number of simultaneous database connections the checkout opens. Requests that cannot get a connection within a short wait fail with a `pool_timeout` error and a service-unavailable status.
- A pool that is too small shows up only under concurrent traffic: single requests succeed while several at once fail. Health reports a pool problem and the error class.
- Raising the pool restores concurrency, but each connection costs memory on the database server; change it by the smallest amount that removes the symptom.
- The statement timeout bounds how long one query may run, in milliseconds. A value that is too small aborts legitimate queries; one that is too large lets slow queries hold connections.

Value domains

- Pool size: an integer from 1 to 20.
- Statement timeout: an integer from 50 to 30000 milliseconds.

Diagnose with several concurrent observations of health and metrics, then compare the pool setting with the symptom before proposing any change.
