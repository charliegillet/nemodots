# NemoDots concrete sandbox and commit protocol

This appendix supplies concrete implementation contracts for BUILD_PROMPT.md. It is a design specification; no sandbox or product implementation has been executed by preparation. Follow TEST_PROMPT.md for independent acceptance. Freeze final contracts with the architect and verifier before parallel edits.

## Controlled commits and effects

### 5.1 Source update
In one short PG transaction:
1. Lock an incident guard row or consistently ordered relevant scope rows.
2. Validate receipt ordering/integrity.
3. Append accepted/conflicting fact versions and update heads/scope revisions.
4. Append the ledger event and outbox row.
5. Mark directly known dependent artifacts/jobs/actions stale where cheap.

Commit before notifying Redis or updating page projections. Expensive graph traversal/repair scheduling may follow asynchronously.

Safety must not depend on that traversal finishing. The action validator rechecks its full base-fact/scope manifest against current heads; a stale action is refused even if the UI or invalidation worker is behind.

### 5.2 Worker results
Claim jobs using short PG transactions with database-clock leases and monotonically increasing generations. A result publication is a compare-and-set:
- job ID matches;
- owner/generation matches;
- lease remains active;
- input manifest remains current;
- job is in a publishable state.
Otherwise retain the output as stale/abandoned audit evidence, not the current answer.

All queued/retry/repair work receives a new or explicitly retained logical job identity. Multiple queue messages for one job do not create duplicate work. Use uniqueness on branch/input-manifest/version to coalesce repeated repairs.

SKIP LOCKED is acceptable for queue claims, not as an incident consistency mechanism. Do not keep a transaction or row lock open while waiting for a model or HTTP response.

### 5.3 Controlled action protocol
The model proposes a typed action; it does not supply trusted credentials, an eligibility verdict or a signed dependency manifest.

The server creates ActionIntent from the current decision and runtime dependencies, hashes canonical action-kind/target/params/manifest, and assigns a stable idempotency key. "Same logical action" means one immutable ActionIntent, not a freshly generated UUID on every retry.

Separate authority clocks: the originating worker must hold its job fence when publishing its decision/proposal. Once published, that immutable artifact can outlive the worker's completed job. The dispatcher acquires its own action-dispatch lease/generation. The effect transaction checks the current dispatch fence and the artifact/dependency validity; it must not require an already completed authoring job's lease to remain active. Preserve authoring_job/fence as provenance, not perpetual execution authority.

Dispatcher:
1. Claim the intent under a valid job/dispatch fence.
2. Revalidate dependencies and permissions in PG; reject stale/contested/expired inputs.
3. Record dispatch attempt and persist its exact immutable payload before sending.
4. Send the action ID, payload hash, idempotency key and expected resource version to the controlled adapter.
5. Do network I/O outside the ledger transaction.

For the controlled sandbox, the supported configuration target and its evidence/version authority must share the authoritative PG transaction boundary. Authenticate the dispatcher and validate resource/owner scope before disclosing any receipt. Then perform one short transaction:
- Serialize concurrent requests for the same idempotency key using a transactional key reservation/lock, in the globally reviewed lock order. Look up or recheck the in-scope receipt after acquiring that serialization authority, before validating a new mutation. Two initially simultaneous cache misses must still converge on the first committed receipt. Same key + same payload returns the prior historical receipt without a new effect, even if evidence has since changed. Same key + different payload returns 409. Returning a historical receipt is reconciliation, not a fresh authorization or proof the incident is currently resolved.
- Lock the incident guard and target resource in the same globally documented lock order as source updates.
- Re-read the ActionIntent, active decision, current dispatch lease/generation and required fact/scope versions. The originating job fence was checked at proposal publication and is now provenance.
- Compare the authoritative per-source/resource epoch vector and target configuration revision with the expected values. Use per-source/resource epochs, not a mission-global revision that invalidates unrelated branches.
- If any predicate fails, write a rejected-attempt outcome and apply zero configuration mutation.
- Otherwise update the authoritative PG configuration and its revision, append the configuration-change outbox event with server-authored causedByActionId and expected post-state identity, and insert its effect receipt atomically.
- Commit and then respond.

This gives a concrete transaction boundary for the configuration write only. Reconfiguring the API process, changing Redis keys/namespaces and observing health happen afterward; none is made atomic by the PG transaction. A committed configuration is CONFIG_COMMITTED, not EFFECT_VERIFIED or INCIDENT_RESOLVED, until independent readback and real API checks pass.

The successful mutation's expected revision change does not justify repeating the same action. Correlate the server-authored event with its immutable effect receipt and expected post-state; supersede the old precondition support and schedule fresh postcondition verification. A matching transition must not cancel itself as an unexpected invalidation or launch a repair storm. Concurrent/unexpected changes still invalidate affected future work. Retain the applied historical receipt regardless of later support validity.

Normal application configuration writes and the private fault injector must use this same version authority and epoch-incrementing mutation function. A privileged injector that updates a value without advancing its epoch makes the experiment invalid. Agents receive no raw PG credentials.

For a genuine remote API:
- Require provider idempotency and conditional-write/version support where available.
- A local dispatch fence only establishes local freshness at authorization.
- If a request times out or a connection breaks, set UNKNOWN and query by stable idempotency key/provider operation ID.
- Retry the exact same payload/key only under the provider's documented semantics.
- If reconciliation is unavailable, stop for review; do not fabricate "not applied".
- A replacement action receives a new logical ID only after the prior effect is known or an explicit conflict/compensation decision exists.

An effect that committed before an evidence update is an applied historical action. Mark its basis stale and consider compensation separately. Never rewrite its execution state to "blocked", and never claim to have prevented it.

Keep execution_state and basis_validity separate:
execution = proposed|queued|dispatching|applied|rejected|unknown|failed|cancelled
basis = current|stale|contested|expired
This avoids silently turning an unknown effect into an eligible retry.

### 5.4 Bypass prevention within the bounded product
Remediation workers receive only controlled read/write adapters. They cannot use a shell, arbitrary fetch, a generic connector, browser credentials or database credentials to reach the effect service. The dispatcher alone holds the write credential. The sandbox rejects unauthenticated writes.

If general browsing/computer tools are retained for investigation, isolate them from remediation credentials/network targets. Extend freshness enforcement across every granted write adapter; adding it only to ComputerService.action is insufficient.

Do not infer a guarantee from an instruction saying "always use the adapter". Enforce it through credentials, tool registration and reachable routes.

## Durable delivery and recovery

PG is authoritative. An accepted update and its outbox record commit together. The publisher can emit duplicate Redis messages if it crashes after publishing and before marking published. Consumers must deduplicate transactionally using PG event/job identities.

Redis can be Streams with consumer groups, but:
- ACK only after the corresponding PG state transition commits.
- Recover pending messages with a bounded reclaim policy.
- Reclaiming a message does not give a worker authority over a PG job; it must still claim a current PG lease/fence.
- Run a PG sweeper for unpublished outbox events and eligible/unleased jobs, so Redis flush or downtime does not permanently lose work.
- A dead-letter state is explicit and visible after bounded attempts.
- A browser SSE reconnect uses ledger sequence IDs to catch up, never an in-memory-only event buffer.

Restart guarantees:
- PG survives process/container restarts under persistent volumes.
- UI projections may lag, but expose their last applied event sequence and refresh from the ledger.
- Jobs with expired leases can be reclaimed; old generations cannot publish.
- Applied/unknown actions are reconciled by operation key.
- Missing provider responses do not become successful receipts.

No "exactly once Redis" wording. The actual controlled effect guarantee comes from idempotency/transaction checks in the effect handler.

## Real checkout incident sandbox

### 12.1 Authority and source epochs
Use one PG database with separate restricted schemas/roles for domain ledger, authoritative sandbox configuration and business data. Co-location is an explicit bounded-demo design choice. The effect handler holds permission to execute a narrow configuration-mutation function, not a general agent-accessible SQL endpoint.

Authoritative source keys include:
- api/db_pool_config;
- api/cache_contract;
- api/cache_config;
- api/remediation_policy;
- topology/api_dependencies;
- business/integrity_scope, if that source itself changes.

Each key has its own epoch. Relevant collection/absence reads carry a scope epoch. One cache-contract change does not increment db_pool_config or business/integrity_scope. An incident guard may serialize short transactions, but its event sequence is an audit cursor, not an eligibility precondition for every branch.

The API, normal configuration editor and private injector all invoke the same epoch-advancing mutation function. The injector's secret is held by the independent evaluator, never exposed in the agent runtime. A test specifically changes cache_contract after the agent reads it but before the proposed cache-config transaction. The transaction checks the authoritative source epoch even if the knowledge projection has not yet ingested the new receipt.

The action's trusted expected vector is constructed by the server from its recorded source reads and required action contract. Do not accept a model-supplied vector as authoritative. A PG transaction checks the expected vector, target config revision, current grant/fence and immutable payload hash, then updates config, receipt and outbox together. Under the idempotency serialization rule, an existing identical receipt is returned before treating later source changes as grounds to invent a new effect.

### 12.2 DB-pool failure with actual SQL/HTTP evidence
Run a real Node API using a real PG connection pool. Seed business tables with stable invoice/order records. Configure a bad bounded pool (for example max=1 and a very short acquisition timeout) and send a declared synthetic workload of concurrent business requests. Each request performs a real parameterized PG query and a bounded server-defined expensive query stage. A short pg_sleep in the sandbox load profile is acceptable as synthetic DB load, but the queries, connections, acquisition failures and HTTP responses must be real; never return a fixture's predetermined healthy boolean.

The repair adapter may propose only validated bounded fields such as max_connections and acquire_timeout_ms. It cannot execute arbitrary SQL, restart containers or kill queries. The authoritative config mutation is the committed effect.

The API's config watcher separately observes the new revision, creates/warms the replacement pool and retires the old pool after in-flight work drains. Failure to instantiate it is visible; it does not erase the PG commit. Expose desired_config_revision and applied_config_revision as distinct observations. Do not acknowledge a restart/reconfigure that has merely been placed on an outbox.

Independent acceptance:
1. Before repair, run the declared concurrent workload and observe real pool acquisition failures or the defined SLO failure.
2. After config commit, wait boundedly for applied_config_revision to equal the committed revision.
3. Run fresh concurrent business requests and require correct JSON values, successful actual SQL execution and the declared latency/error criteria.
4. Inspect PG connection/query evidence where useful, e.g. an application_name carrying the pool-config revision, rather than relying only on the API's reported health status.
5. During the read-only load/repair phase, compare business-table row counts and deterministic normalized row hashes before/after, excluding ledger/config/audit tables. Then run a separate fresh create/read checkout probe and verify its exact allowed order/inventory deltas plus preservation of all other seeded data. If trials allow concurrent writes, freeze an independent workload operation log and compute permitted deltas rather than demanding globally unchanged hashes. Keep these two acceptance phases explicit; a legitimate new order is not data corruption.

This demonstrates real application behavior under synthetic load, not an unrestricted claim about production incident recovery. Do not tune the acceptance thresholds after seeing the candidate's results.

### 12.3 Cache contract/config failure
The business API actually uses Redis for a versioned cache of query results. A cache contract states the response schema/version and key namespace rules. Seed an old namespace with actual stale/wrong-schema data. The cache repair changes the authoritative PG cache config to the current contract and a new namespace/version (or disables cache if policy permits). It does not atomically flush Redis.

After commit, a separate projector applies the new namespace/config to the API and writes optional Redis projection metadata. The projector uses an idempotent per-resource revision check so an older delayed message cannot overwrite a newer projection. If a Redis compare-and-set/Lua script is used, its atomicity is Redis-local; it does not make the earlier PG transaction atomic with Redis.

On a request, the API uses an applied configuration snapshot and contract-specific namespace together. A new namespace must not read old-schema entries. A malformed cached value produces the documented safe fallback or failure, not silent acceptance. If cache is optional, Redis unavailability falls back to a real PG read; if policy requires cache behavior, remain degraded until verified. Old namespace cleanup is separate bounded maintenance.

Independent acceptance:
- Read the actual business endpoint after repair and compare its values/schema against direct read-only PG ground truth.
- Assert the served contract version and applied cache-config revision match the authoritative committed config.
- Demonstrate old Redis entries remain harmless even before cleanup.
- Stop Redis/projector after PG commit: show CONFIG_COMMITTED plus APPLY_PENDING/DEGRADED, never falsely resolved.
- Restart and replay duplicate/out-of-order projector events: converge to latest per-resource revision, with no namespace regression and no business-data mutation.
- Mutate cache_contract through the private injector after read: stale cache-config commit is rejected; pool and independent integrity work retain current artifacts.

### 12.4 Completion state contract
Use explicit phases or observations:
PROPOSED -> CONFIG_COMMITTED -> APPLY_PENDING -> EFFECT_VERIFIED.
Transport UNKNOWN is an orthogonal unresolved attempt state. An incident becomes RESOLVED only when independent workload/schema/DB-integrity checks for every required branch pass against the actually applied revisions. A PG receipt alone proves configuration commitment; Redis acknowledgement alone proves neither API adoption nor incident resolution.

Keep the integrity branch logically independent by giving its worker only business-data receipts and the relevant integrity scope. Do not inject the whole changing incident ledger into that worker and then claim its conservative dependency list is selective. If a real shared policy changes, invalidating the integrity branch may be correct; the evaluator must specify that ground truth.

A configuration change committed before a later source update is historical reality. New facts may call for a compensating new configuration, but the UI must retain the original receipt and must not describe that earlier commit as prevented.

