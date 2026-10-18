# NemoDots fast demo path (branch `nemodots-demo`)

This branch runs a working end-to-end mission in the browser. It reuses the full build's contracts, ledger, coordinator, sandbox, inference adapter, context compiler and mission page. It adds a simplified runtime in `src/server/nemodots/runtime/`: the action boundary, a source watcher, the Nemotron team, the routes with SSE, and the bootstrap. Every planner, worker and verifier decision is a live NVIDIA Nemotron 3 Super call on Crusoe Managed Inference.

## Start (two terminals, from `NemoDots/`)

One-time setup:

```bash
npm ci
cp ../../crusoe-hackathon-nemodots/NemoDots/.env .env   # secrets: OPENAI_BASE_URL/OPENAI_MODEL/OPENAI_API_KEY (never commit)
NEMODOTS_INSTANCE=demo2 npm run nemodots:stack -- init --pg-port 55460 --redis-port 56410 --checkout-port 4540
```

Terminal 1 starts the stack, migrates, resets the checkout to a healthy baseline, clears the cache, and runs the API on 4560:

```bash
scripts/nemodots/demo-server.sh
```

Terminal 2 runs the UI on 5180, proxied to 4560:

```bash
VITE_API_TARGET=http://127.0.0.1:4560 npx vite --port 5180 --strictPort
```

Open `http://127.0.0.1:5180/#/missions`. Restart terminal 1 before every run so the checkout starts from the baseline.

## Click path

1. **New mission**: set the goal to `Restore checkout availability while preserving customer data` and click **Create mission**. The header shows **LIVE**, `api.inference.crusoecloud.com` and `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`.
2. In **Injector run**, type `dependent_change_after_proposal` and click **Run injector**. This applies the F2 cache-schema mismatch now. It also arms a second change to `cache.schema_version` that fires the moment any action proposing that key is inserted (Postgres NOTIFY).
3. Click **Start**. The planner (Nemotron) creates 2 or more root branches. The investigator observes health, metrics and cache stats, then delegates to a `cache_specialist`, which delegates its own `verifier` child. The task tree and evidence ledger update live over SSE.
4. When the specialist proposes `set_config cache.schema_version`, the armed injector step advances that key. The watcher registers a new receipt, and the ledger closure invalidates only the attempts that read the old receipt. The queued action then reaches commit. Under `FOR UPDATE` it finds the version moved, so the action is **blocked: `stale_version`**. The check and the block are recorded in the same transaction that would have written the config.
5. The affected specialist gets a repair attempt: it re-reads the source and re-proposes. The customer-data branch is preserved and makes no new model calls. The recovery timeline shows the sequence.
6. The corrected action commits. The independent probe (fresh order create and read, inventory invariant, health window) runs, and the mission shows **succeeded**.

You can also trigger step 4 by hand: in **Edit source**, edit `checkout.config/cache.schema_version` while the action waits in the dispatcher queue (`NEMODOTS_COMMIT_DELAY_MS`, default 3000).

## Simplifications compared with the full design

- **Admission:** runs in the same transaction as the proposal insert. The mission's `admission.minAgeMs` is not applied, and there is no outbox-driven admission.
- **Commit:** happens after a fixed dispatcher delay. There is no dispatcher lease reclaim and no Lua fence. `flush_cache_namespace` UNLINKs keys directly after its commit.
- **Action edges:** actions are not written as ledger graph nodes. The closure therefore never blocks intents; the commit-time version check does.
- **Observed sources:** observed endpoints (`checkout.health`, `checkout.metrics`, `redis.stats`, orders and inventory) are recorded as context receipts without closure marks and are not part of read sets. Only controlled `checkout.config/*` receipts drive invalidation. Without this, every health re-read after the fix invalidated every branch.
- **Self-writes:** a write caused by our own committed action is registered as a self-write (`selfWrite: verified`). It settles the action's postcondition and does not invalidate the proposer.
- **Specialist capabilities:** a specialist delegated by an investigator keeps its role's propose capabilities (`coordinator/plan-validation.ts`). The full design intersects them with the parent's.
- **One specialist per role:** a mission has at most one live specialist per role. A second `delegate_task` for the same role returns the existing task, so two branches never fight over one key. Model-supplied `dependsOn` is ignored.
- **Other limits:** `replanCap` is 1. The watcher polls `checkout.config_entries` every 400 ms rather than using LISTEN. Missions left running by a previous server process are cancelled at boot. Inference is capped at 2 in-flight requests with `reasoning_effort: "none"`.
- **Runbooks** (`runtime/runbooks/*.md`) describe the system and the remediation policy, including "prefer a config restore over a cache flush". They contain no fault values.
