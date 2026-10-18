# NemoDots browser end-to-end suite (W6.2)

These suites drive the real mission page in system Google Chrome, against the **built** server and a dedicated `ci-e2e` PostgreSQL, Redis and checkout stack. They use the Playwright **library** (`playwright`, `chromium.launch({ channel: 'chrome' })`): no `@playwright/test` and no browser download. If Chrome cannot be launched the run prints `BLOCKED: Google Chrome not found` and exits non-zero.

## Run it

```sh
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH
export NEMODOTS_INSTANCE=ci-e2e NEMODOTS_PG_PORT=55480 NEMODOTS_REDIS_PORT=56480 NEMODOTS_CHECKOUT_PORT=4580

npm run build
npm run nemodots:stack -- init          # first time only
npm run nemodots:stack -- start
npm run nemodots:migrate
npm run nemodots:seed

npm run test:nemodots:e2e               # all suites, one live smoke when the Crusoe key is present
NEMODOTS_E2E_LIVE=0 npm run test:nemodots:e2e   # everything except the paid smoke (reported as skipped)
npm run test:nemodots:e2e -- tests/nemodots/e2e/populated-views.test.ts   # one file

npm run nemodots:stack -- stop          # stop what you started
```

The instance must be named `ci-*` and use ports other than 5432, 6379, 55432 and 56379; the global setup refuses anything else. Each suite starts its own copy of the built server (`node dist/server/server/index.js`) on a free port with its own SQLite file and its own `OWNER_ID`, so one suite never sees another's missions. Servers get an explicit minimal environment (the stack's `NEMODOTS_*` values, `DO_NOT_TRACK=1`) and only the secrets a scenario needs, read from `.env` and never printed. Every server is stopped when its suite ends.

Preconditions the global setup checks: a `ci-*` instance, `dist/` built, the runbook markdown present in the build output (`dist/server/server/nemodots/team/runbooks/*.md`), and a launchable Chrome.

## What each suite proves

| Suite                           | Server                                                                       | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup-and-protections.test.ts` | locked with `OWNER_TOKEN`, no provider variables (inference `blocked`)       | unlock screen and wrong token; token never in a URL; **BLOCKED** label with every missing name; disabled create form; empty, loading and error states; unknown mission; keyboard reach; `/api` protections (401 without or with a wrong token, 403 for a foreign origin and for cross-site, 415 for non-JSON writes, 404 for unknown or malformed ids, 503 with names only while blocked, non-controlled source refused)                                                                                                                                                                                |
| `fixture-lifecycle.test.ts`     | fixture mode, no workers                                                     | **FIXTURE** label (never Live) and what it means; create from the form with goal, constraints and `minAgeMs`; Start, Pause, Resume, Cancel with enabled/disabled state and the reason a control is unavailable; refresh keeps the state; list with the Fixture marker; **reconnect**: the server is killed (SIGKILL), the page says Reconnecting, the server returns, the page reopens its stream from the last event id, catches up once and shows no duplicate rows; rebuild from the snapshot after a refresh; start with the keyboard alone; telemetry `unavailable`; every status has a text label |
| `fixture-failed.test.ts`        | fixture mode with a worker and a fixture file with **no** recorded responses | a **failed fixture mission** produced by the production worker (fixture mode never improvises, so the planner call has no entry; the test reads the attempt's `failure_reason` from storage to confirm "no fixture for key"); FIXTURE badge, failure reason shown as text, failed planner task, disabled controls with reasons, honest empty states, persists across a refresh                                                                                                                                                                                                                          |
| `populated-views.test.ts`       | fixture mode, no workers; a seeder plays the model                           | task tree, findings labelled as claims, dependency view (scheduling vs evidence), evidence ledger with `lastConfirmedAt` that advances, action inspector (stage, decision, block reason, checked vector freshness), recovery timeline, **the changed-evidence sequence** (below), a **succeeded fixture mission** with the real acceptance probe verdict, telemetry `unavailable`, the "Save evidence page" projection with a receipt id and revision per line                                                                                                                                          |
| `chat-intelligence.test.ts`     | fixture mode with the Intelligence and provider variables from `.env`        | the upstream chat view renders as set up (`SELF-HOSTED`, not `SETUP REQUIRED`), Intelligence is reported separately on the mission page, Scheduled & activity and Memories stay reachable. It sends no prompt and creates no thread.                                                                                                                                                                                                                                                                                                                                                                    |
| `live-smoke.test.ts`            | live mode with the Crusoe variables from `.env`                              | one real mission through the UI: **Live** badge with the configured host and model, the persisted plan appears, a model call is recorded, then the person cancels; every call of the mission used the configured host and model. Missing variables print `BLOCKED: <names> missing` and fail. `NEMODOTS_E2E_LIVE=0` skips it and prints `NOT_RUN`.                                                                                                                                                                                                                                                      |

### The changed-evidence sequence (`populated-views`)

The built server runs the outbox, watcher, action admission loop and acceptance probe. The seeder (`support/seed.ts`) claims and runs tasks through the **real** coordinator, ledger and action boundary against the same PostgreSQL, standing in only for the model: a database specialist reads `db.pool_max` and proposes raising it, with an admission delay of 45 s. In the browser the person then edits the same setting through the page's manual source edit. Everything after that is production code: the receipt is superseded, the proposal is blocked (`stale_version`, expected N, live N+1), the dependent work is invalidated, recovery is scheduled, and the recovery timeline shows the events in order with ascending event ids. A refresh rebuilds the same facts from the snapshot without duplicating entries.

What is authored (and therefore fixture content, shown under a FIXTURE badge): the plan, finding and handoff text, the proposal's rationale and the model-call records. Token usage in those records is left unknown (null), so no number is invented.

## Evidence and secrets

Screenshots go to `.local/<instance>/e2e/screens/` (`.local/ci-e2e/e2e/screens/`). Next to each `.png` the suite saves the page's rendered text (`.txt`) and DOM (`.html`), so the scan covers what a person can read and not only the pixels. Server logs are in `.local/<instance>/e2e/*.server.log`.

After the last suite, the global teardown searches every file under that directory for any secret value this run could have held: the provider and Intelligence keys and other secrets from `.env`, and the passwords, URLs and probe secret from the instance's `roles.env`. It prints the number of files scanned and the number with a hit, never a value, and fails the run if any file has one.

## Findings from building the suite

1. **The built server cannot run a mission.** `npm run build` does not copy `src/server/nemodots/team/runbooks/*.md` into `dist/server/server/nemodots/team/runbooks/`; the planner attempt fails with `ENOENT .../runbooks/acceptance.md` and the mission fails. This only works under `tsx`. The global setup stops with `BLOCKED: build output is missing runbooks/...` until the build copies them. For the recorded runs the five files were copied into `dist/` by hand.
2. **A terminal mission did not show why it ended** until a refresh: the `mission.status` event carries the new status, not the stored `failureReason` or `acceptanceReceiptId`. Fixed in `src/client/nemodots/use-mission.ts` (a status event now re-reads the snapshot). Unit test: "reads the failure reason from storage when a status event moves the mission to failed" in `tests/nemodots/ui-page/page.test.tsx`.
3. **`lastConfirmedAt` went stale while the stream was open.** The server emits no `receipt.confirmed` events, and the page only polled when the stream was down, so the ledger kept saying "last confirmed 2 minutes ago" while the watcher confirmed the source every second. Mitigated in `use-mission.ts` with a 30 s reconciliation read while the stream is open. The better fix is for the server to emit (throttled) `receipt.confirmed` events.
4. **Unmeasured usage is shown as `0`.** When a model call's usage is unknown, telemetry shows `Prompt tokens 0` and `Completion tokens 0` (cached tokens and time to first token correctly say `unavailable`). The server aggregates unknown as 0.
5. **A failed mission shows only `task <id> failed`.** The attempt's failure text (for example "no fixture for key ...") is not part of the snapshot contract, so the page cannot say why.
6. **"Admission not before: unknown"** on a freshly loaded proposed action, because the value is only in the `action.proposed` event, not in the snapshot's intent; it could be derived from `proposedAt` plus the mission's `admission.minAgeMs`.
7. Transient: right after an invalidation the mission pill can read `Awaiting acceptance` while tasks are already `Runnable`, until the coordinator's evaluation moves it back to `Running`. The acceptance probe panel shows the verdict of a probe that did run, even for a mission that is not accepted.
8. The server's SIGTERM shutdown printed `Shutdown deadline exceeded` in several runs.
