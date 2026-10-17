# NemoDots changed-evidence demonstration

This is a script for showing one behaviour: **a repair that rests on evidence that has since changed is not applied as written; the team notices, discards or re-does only the affected work, and an independent probe decides whether checkout works again.** Follow [SETUP.md](SETUP.md) first so the health check passes in live mode.

## What you will see, and what is staged

NemoDots runs a team of Nemotron agents (model `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` on Crusoe) against a small checkout app that this repository ships. A planner splits the goal into tasks; an investigator reads evidence and cannot change anything itself; only specialist roles can propose a configuration change. Every observation becomes a **receipt** in an evidence ledger, and every proposed change cites the receipts it rests on.

Three things are staged, and you should say so when you present it:

1. **The fault is injected.** A private injector changes one checkout configuration key (`cache.schema_version`) so that cached data no longer decodes and checkout fails.
2. **The dependent change is scenario-driven.** The scenario `dependent_change_after_proposal` has a second step that the injector performs **in reaction to the team's proposal**: when the proposal for `cache.schema_version` is announced, the injector advances that same key again. A real second change at that moment would be a coincidence. Here it is a script, so that the interesting case happens every time. It is not an emergent event, and nothing in the team is told about it.
3. **The mission waits before admitting the proposal.** `admission.minAgeMs` (the "Admission delay" field, 3 000 ms in this script) is the earliest time after a proposal that the system will try to admit it. It exists so the scripted change can land first. It does not make the outcome fixed.

What is **not** scripted: what the agents observe, whom they delegate to, what they propose, and how the system responds to the change (block, invalidate, repair, or commit-then-repair). That response is the thing being demonstrated.

## Before you start

- Stack up, migrated and seeded; server running in live mode; `GET /api/nemodots/health` shows `mode: "live"`, `postgres: "ok"`, `redis: "ok"`, checkout `ok`.
- Start from the healthy configuration: `npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts seed --reset-config`.
- Live runs make billed Crusoe calls. The client keeps at most 4 in flight.
- Do not set `NEMODOTS_TEST_HOOKS`. It adds race-test barriers that make a run no longer a live demonstration.

## Script

### 1. Confirm the mode

Open the app, choose **Missions** in the sidebar. Under the heading there are two badges. You want **Live** (hover it for the model and provider host) and, optionally, **Intelligence configured**. If it says **Blocked** it lists the missing environment variable names; if it says **Fixture**, stop: see [Telling live from fixture](#telling-live-from-fixture).

### 2. Create the mission

On **Missions**, in **New mission**:

- **Goal**: `Checkout is failing. Find out why, restore it, and show that orders work again.`
- **Constraints**: leave empty, or one per line.
- **Admission delay (minAgeMs, 0 to 60000)**: `3000`.

Press **Create mission**. The mission opens in state `created`; nothing runs until you press **Start**. The header shows **Provider host**, **Planner model**, **Worker model** and `admission.minAgeMs` = 3 000 ms. Further down, **System health** shows checkout `ok`.

### 3. Arm the scenario, then start

In **Scenario controls** on the mission page, use **Injector run**: type `dependent_change_after_proposal` in **Scenario class** and press **Run injector**. The page answers only with a run id; the injector never reports what it changed.

What happens: step 1 advances `cache.schema_version` at once (to 2 or 3), which makes the checkout's cache reads fail to decode. Step 2 waits, up to 300 seconds, for a proposal that targets `cache.schema_version`. If no proposal targets that key in that time, step 2 is skipped and the demonstration did not happen; the team may then legitimately repair another way (for example flushing the cache namespace).

Now press **Start** in the mission header.

### 4. Watch the team work

- **Task tree**: the planner's 2 to 6 root tasks, then child tasks. The investigator cannot propose an action, so a repair has to come from a specialist it **delegates** to (cache, database or routing specialist). That delegation is forced by capabilities, not by a prompt request. Select a task to filter **Findings** to it.
- **Evidence ledger**: one row per receipt: source (for example `checkout.health`, `checkout.metrics`, `redis.stats`, `checkout.config/cache.schema_version`), revision, trust, age. Look for the checkout metrics receipt that carries the expected and found schema versions.
- **Dependencies**: solid lines are scheduling edges between tasks, dashed lines are evidence edges from a receipt to the task or attempt that used it. This graph is what the system uses to decide what a change affects.
- **Actions**: when a specialist proposes `set_config` on `cache.schema_version` (or a cache flush), it appears here. Select it to open the **Action inspector**.

### 5. The change lands

When the proposal is announced, the injector advances `cache.schema_version` again (to 5 or 6) inside the 3 000 ms window. The **Evidence ledger** gets a new receipt for that key, marked as an external change (not the team's own write).

Now read the **Recovery timeline**, which lists events in order with these step labels: Evidence, Decision, Repair, Invalidation, Recovery, Resolved. Two honest outcomes are possible. The run records which one occurred; neither is hidden and you should not claim the one you hoped for.

**Outcome A: blocked before it commits.**

- Evidence: registered receipt for `cache.schema_version`, "external change", supersedes the earlier receipt.
- Invalidation: recorded, reason on that source, with counts: affected tasks, attempts, actions; **preserves N tasks**; closure depth.
- Decision: the action is **blocked**, stage Admission or Commit, block reason `stale_version` ("Block reason: Stale version").
- Action inspector, that stage: **Target version: expected V, live W (mismatch)**; the **Checked dependency vector** table shows the receipt rows the check used. At the Commit stage a **Dispatch fence** line shows the token and valid or invalid.
- Recovery: intent blocked, and a **Repair** event: "Repair attempt n started ... repairs attempt ... after invalidation ...; inherits k dependencies". The repair attempt reads fresh scoped evidence, not the old transcript, and its readset contains the new receipt.
- A new action is proposed on the new version, goes through Admission and Commit, and **Invalidation ... resolved** closes the loop.

**Outcome B: it commits first, then the change supersedes it.**

- Decision: the first action is **admitted** and **committed** (Action inspector shows "Committed: target version V to V+1").
- Then the injector's change lands on top: a second Evidence entry (external change), a second Invalidation, a Recovery "repair scheduled", a Repair attempt, and a final `set_config` that commits. The inspector for the first action shows its stages as they were, so you can see that the guard passed at the time and the later change was handled afterwards.

In both outcomes there is a final committed `set_config`, and the mission does not finish until the probe passes and no invalidation is open.

**Preserved work.** The invalidation entry says how many tasks were **preserved**: those with no evidence or inheritance path from the superseded receipt. The claim to check is that no new model calls were made for exactly that set (task tree attempts, **Telemetry** panel call counts). If the plan produced no such independent branch, the preserved set is empty and nothing should be claimed about it; the automated test reports that case as `NOT_MET` rather than forcing it.

### 6. The probe decides

When the team believes it is done the mission moves to awaiting acceptance and the independent acceptance probe runs. Read **Acceptance probe**: **Verdict** Pass or Fail, the receipt id, and a list of invariants.

What the probe does: it uses a different database role (`nemodots_verifier`) and the checkout API's probe header. It snapshots business-table hashes (excluding probe rows), places one order for a probe-only SKU, reads it back, checks inventory fell by exactly the ordered quantity and no other business row changed, then watches checkout `/health` every 2 seconds for `NEMODOTS_PROBE_WINDOW_MS` (20 s by default) and requires `ok` on every sample. It registers the result as a `checkout.acceptance` receipt with trust `probe`. The mission becomes `succeeded` only on a pass with zero open invalidations.

What it proves: at that moment, for that window, the checkout accepts an order that behaves correctly and reports healthy. It is not written by the agents and it does not read their output.

What it does not prove: that the agents' explanations were right, that nothing else drifted outside the window, or that the same fix holds under different load. Treat a Fail as a result, not a glitch.

## The freshness limit, stated plainly

- **Controlled sources** (configuration keys and the set of keys that exist) are checked exactly at commit: inside one PostgreSQL transaction, under row locks, the recorded version of every receipt the proposal rests on must equal the live version. That is why a change to `cache.schema_version` after the proposal cannot be overlooked at commit.
- **Observed sources** (health, metrics, Redis statistics, recent orders, inventory) are different. The system invalidates dependents when a newer observation differs, and admission requires a confirmation younger than a maximum age, but a change that nothing has observed yet cannot be detected. For these the guarantee is **freshness at admission** (and, for the Redis flush, freshness at dispatch), not freshness at the instant of effect.
- The Redis flush is an external effect and is not atomic with its database commit. A failure between effect and acknowledgement leaves the action in `outcome_unknown` until a reconcile step reads the marker back.

## Manual runs

You can drive the same pieces by hand.

**Manual source edit** (Scenario controls, **Manual source edit**): pick a source, a value type and a new value, and submit. It goes through the same version authority as any writer and requires the source's current version, so an edit made while another has landed is rejected with a conflict. Use it to make your own change land during the admission window.

**Injector scenarios from a terminal** (the injector role; secrets stay in `roles.env`):

```sh
npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts scenarios
npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts inject --scenario dependent_change_after_proposal --seed 1
npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts notify-proposed --key cache.schema_version
npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts probe
```

`inject` blocks until its steps settle or `--timeout-ms` (default 120 000) passes and prints a step summary. `notify-proposed` emits the notification the injector's second step waits for; use it to test a scenario without a model, never during a live demonstration. `--seed` selects which of a step's value choices is used.

Other scenarios to contrast: `cache_schema_mismatch` (the fault alone), `benign_change` (changes only `ui.banner_text`, which must not invalidate anything), `second_change_during_repair`, `stale_replica`, `pool_starvation`, `writes_disabled`. Reset to the healthy configuration between runs with the `seed --reset-config` command above.

## Telling live from fixture

A fixture run replays prerecorded model responses and can look identical on screen. Check all of:

- **Badge**: Live, Fixture or Blocked, on the missions list and the mission header. A fixture mission also shows the line "FIXTURE mission: model responses are scripted fixtures, not a live model."
- **Provider host**: the mission header's **Provider host** must be the host of your `OPENAI_BASE_URL` (for Crusoe, `api.inference.crusoecloud.com`) and the model names must be the Nemotron IDs you configured. Fixture missions do not show a live provider.
- **Telemetry**: a live mission has non-zero **Prompt tokens** and **Completion tokens**, **Time to first token** percentiles and per-model rows. **Cached tokens** reads `unavailable` when the model does not report them; that is not the same as zero.
- **Consistency**: a live mission cannot start on a server in fixture mode (the Start button explains why), and a request that names a mode other than the server's is rejected.
- **Outside the app**: your Crusoe usage dashboard shows the requests. The automated live test asserts that every recorded model call's provider host equals the host of `OPENAI_BASE_URL` and that the model returned equals the model requested.

If any of these disagrees with "live", do not present the run as live.

## After the demonstration

Reset the configuration (`seed --reset-config`), and stop what you started (`npm run nemodots:stack -- stop` for a dedicated instance). The automated version of this script is `npm run test:nemodots:live -- tests/nemodots/live/mission`, which also covers a killed worker and loss of Redis; it uses a dedicated instance and reports BLOCKED, with a non-zero exit, if the three `OPENAI_*` names are absent.
