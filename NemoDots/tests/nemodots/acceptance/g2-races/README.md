# Gate 2 acceptance suite (admission and races)

Ports 4640 (checkout) and 4641 (app) are reserved for this suite; it drives services in-process and opens none. Databases `acc2_<rand>` on 55432, Redis db 3 on 56379 with a random key prefix. Run:

`npx vitest run --config tests/nemodots/acceptance/vitest.config.ts tests/nemodots/acceptance/g2-races` (stack up, role URLs via `npm run nemodots:stack -- exec` or roles.env).

Case map: admission.test.ts G2-01..G2-08; leases-effects.test.ts G2-09..G2-12, G2-15; lifecycle.test.ts G2-13, G2-14, G2-16, G2-OUT (outside the guarantee).

## Production entry points depended on (all resolved at run time; missing means FAIL)

- `actions/index.ts#createActionAdmission({pool, redis, redisPrefix, dispatcherLeaseMs})` returning `ActionAdmissionPort` plus `reclaim(id, dispatcher)` and `compensate(id, attemptCtx)`.
- `actions/test-hooks.ts` : `setHook(point, async (ctx) => void)`, `clearHooks()`; barriers `after_preliminary_read`, `before_lock`, `after_lock_before_commit`, `after_commit_before_dispatch`, `after_effect_before_record`; hook errors propagate (crash simulation) and roll back the open transaction.
- `actions/dispatch.ts#cacheKey(prefix, namespace, name)` (Redis key layout for planting cache entries).
- `coordinator/test-support.ts` (requested): `seedRunningAttempt(pool, {role, missionId?})` -> AttemptContext & {modelCallId}, `expireAttemptLease`, `completeAttempt`, `cancelMission`, `staleOps(pool, ctx)` -> thunks `publish|delegate|renew` that use the stale token.
- `sandbox/version-authority.ts#advanceConfig(client, {key, value, expectedVersion, causedBy})`.
- `ledger/receipts.ts#registerObservation(client, input)`; `watcher/watcher.ts#createWatcher({pool, redis, redisPrefix})` with `pollOnce()`.
- Schema (SQL read by the verifier): `checkout.config_entries/config_versions`, `coordinator.action_intents/authorizations/result_receipts/outbox/missions/task_attempts`, `ledger.observation_receipts/sources/invalidation_events` with snake_case columns per ARCHITECTURE and IMPLEMENTATION_STATUS.
- Error names/messages: `DispatchFenceError`, `FenceError`, `stale_version`, `idempotency_conflict`, `payload_invalid`, `capability_denied`.
