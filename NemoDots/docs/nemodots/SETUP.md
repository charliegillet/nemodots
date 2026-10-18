# NemoDots setup and operation

This guide is for an operator who has not read the build documents. It covers a clean start of the local sandbox stack, the environment NemoDots needs, how to run the tests, and what does not work yet.

Every command below is marked with what was observed when it was run on 2026-10-18 on the machine this repository was built on (macOS, Homebrew PostgreSQL 16 and Redis, Node via nvm), against a throwaway instance named `ci-docs` on ports 55460 (PostgreSQL), 56460 (Redis) and 4560 (checkout). **PASS** means the command ran and exited 0 with the output described. **NOT_RUN** means it was not run, and the reason is given. Nothing marked NOT_RUN is known to work.

## 1. What runs where

| Part                                                       | Where                                      | Needs                                                         |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| OpenDots server and React app (upstream)                   | `npm run dev` / `npm start`, port 4310     | Node, SQLite (built in), an Intelligence key for chat         |
| NemoDots sandbox stack: PostgreSQL 16, Redis, checkout API | native processes under `.local/<instance>` | `postgres`, `initdb`, `pg_ctl`, `redis-server` on `PATH`      |
| NemoDots coordinator, ledger, watcher, routes              | inside the OpenDots server process         | the sandbox stack (composed by `createNemoDots`, mounted at `/api/nemodots`) |
| Extra NemoDots worker (optional)                           | `npm run nemodots:worker`, its own process | the sandbox stack and the three `OPENAI_*` names              |
| Nemotron reasoning                                         | Crusoe Managed Inference over HTTPS        | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`           |
| Voice calls (optional, upstream OpenDots feature)          | OpenAI realtime, `api.openai.com`          | `VOICE_API_KEY`, `VOICE_MODEL`; not Crusoe, not part of NemoDots |

The server starts the coordinator, the source watcher, the outbox and `NEMODOTS_WORKERS` in-process workers. A separate worker process is only needed to run more workers or to kill a worker without touching the server (section 8).

Docker is optional. The native stack above is the primary path and does not use Docker. Docker (Colima) is installed on the build machine, but nothing in the core NemoDots path starts a container. The optional per-Dot computer feature uses containers and is **NOT_RUN** for NemoDots.

## 2. Prerequisites

- **Node 24.13.1 or newer.** `package.json` says `>=24`, but Node 24.11.1 and 25.2.1 crash inside `node:internal/console` in `tests/telemetry.test.ts` (7 failures); 24.13.1 passes. If your default `node` is one of those, put a good one first on `PATH` for every command:

  ```sh
  export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH
  node -v    # v24.13.1
  ```

- **PostgreSQL 16 and Redis 8 binaries** (`initdb`, `pg_ctl`, `pg_isready`, `psql`, `postgres`, `redis-server`, `redis-cli`) on `PATH`. The scripts never touch an existing PostgreSQL on 5432 or Redis on 6379 and refuse those ports.
- `npm ci` installs the dependencies. **NOT_RUN** in this documentation pass (the repository's dependencies were already installed and installing is not part of verifying the commands).

## 3. Environment

Copy `.env.example` to `.env` (the file is git-ignored) and fill in values. Never paste a value into a command line, a log or a report; every script here prints variable names only.

| Name                                                   | Purpose                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                       | Crusoe inference key (used under this name because the adapter speaks OpenAI-compatible Chat Completions)                                                                                                                                                            |
| `OPENAI_BASE_URL`                                      | Crusoe endpoint, `https://api.inference.crusoecloud.com/v1`. **NemoDots code has no default for this.** `.env.example` ships it as an active line, but if the variable is unset in your environment live mode is `blocked` and `missingEnv` lists `OPENAI_BASE_URL`. |
| `OPENAI_MODEL`                                         | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`. The shorter `nvidia/Nemotron-3-Super-120B-A12B` that appears in the build prompt does not exist on Crusoe.                                                                                                               |
| `INTELLIGENCE_API_KEY` (or `CPK_INTELLIGENCE_API_KEY`) | CopilotKit Intelligence. Needed for chat conversations in the OpenDots UI. It is a separate service with a separate key; the Crusoe key does not work for it. Mission control itself does not call Intelligence.                                                     |
| `OWNER_TOKEN`                                          | Optional on loopback; required (24+ characters) if the server binds a non-loopback address                                                                                                                                                                           |
| `NEMODOTS_*`                                           | Instance, ports, Redis prefix, mode, limits. Non-secret defaults are in `.env.example`.                                                                                                                                                                              |

Live mode needs all three of `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`. With any missing, `POST /api/nemodots/missions` answers 503 with the missing variable names, never values.

**Modes** (`NEMODOTS_INFERENCE_MODE`): `live` calls Crusoe; `fixture` replays recorded provider responses from the file named by `NEMODOTS_FIXTURE_PATH` and needs no key; `blocked` refuses to run models. The mode is shown as a badge on every mission, every model call is stamped `live` or `fixture`, and fixture output is never presented as live evidence.

To write the non-secret `NEMODOTS_*` block for an instance into a file without touching secrets:

```sh
node scripts/nemodots/write-env.mjs --instance ci-docs --file /tmp/ci-docs.env --mode blocked
```

PASS (exit 0): it wrote `NEMODOTS_INSTANCE`, `NEMODOTS_PG_HOST`, `NEMODOTS_PG_PORT`, `NEMODOTS_PG_DATABASE`, `NEMODOTS_REDIS_PORT`, `NEMODOTS_REDIS_URL`, `NEMODOTS_REDIS_PREFIX`, `NEMODOTS_CHECKOUT_PORT`, `NEMODOTS_CHECKOUT_URL` and `NEMODOTS_INFERENCE_MODE`, and printed only those names. Without `--file` it edits `.env`.

## 4. Clean start of the sandbox stack

Choose an instance name and ports. The defaults are instance `dev`, PostgreSQL 55432, Redis 56379, checkout 4510. If those are taken (the build machine's Colima forwarder holds 55432 and 56379), set the ports through environment variables for **every** command, or pass flags to `init`. The ports are recorded at `init`; a later command asking for different ports is refused.

```sh
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH
export NEMODOTS_INSTANCE=ci-docs NEMODOTS_PG_PORT=55460 NEMODOTS_REDIS_PORT=56460 NEMODOTS_CHECKOUT_PORT=4560

npm run nemodots:stack -- init
npm run nemodots:stack -- start
npm run nemodots:stack -- status
npm run nemodots:migrate
npm run nemodots:migrate -- --check
npm run nemodots:seed
```

Observed:

| Command                             | Result                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `nemodots:stack -- init`            | PASS, exit 0: `instance ci-docs ready (postgres 55460, redis 56460, checkout 4560); roles.env generated (0600)`                          |
| `nemodots:stack -- start`           | PASS, exit 0: PostgreSQL, Redis and the checkout API started on 127.0.0.1                                                                |
| `nemodots:stack -- status`          | PASS, exit 0: `accepting connections`, `PONG`, checkout running                                                                          |
| `nemodots:migrate`                  | PASS, exit 0: `7 applied, 0 already applied` (0001 to 0007)                                                                              |
| `nemodots:migrate -- --check`       | PASS, exit 0: `up to date (7 applied, 0 pending)`                                                                                        |
| `nemodots:seed`                     | PASS, exit 0: `24 listed products, 25 inventory rows, 200 orders; config inserted 7, restored 0`                                         |
| `curl http://127.0.0.1:4560/health` | PASS, HTTP 200: `{"status":"ok","checks":{"postgres":true,"redis":true,"config_parse":true,"writes":true,"cache":true,"pool":true},...}` |

Order matters: **seed after `start`**, and run `migrate` before `seed`. Seeding writes the healthy configuration through the same version authority every later change uses. Running a mission against an unseeded database was not tested. `seed` restores the healthy configuration and can be repeated.

Stop and reset:

```sh
npm run nemodots:stack -- stop
npm run nemodots:stack -- reset --yes     # deletes .local/<instance> and runs init again
```

`stop` was run at the end of this pass (PASS: checkout, Redis and PostgreSQL reported stopped, `status` then exited 1, and ports 55460, 56460 and 4560 were closed). It stops only processes whose pid file it wrote. A second `nemodots:seed` before the stop was also PASS and reported `config inserted 0, restored 0`, so seeding is repeatable. `reset --yes` was run on a second throwaway instance (`ci-docs-b`, ports 55461/56461/4561 given as `init` flags) and removed its directory (PASS).

Several instances can run side by side. Use a different instance name and three different ports each; for example `npm run nemodots:stack -- init --instance ci-b --pg-port 55433 --redis-port 56380 --checkout-port 4511` (PASS for `ci-docs-b` as above). Tests use `ci-*` instances so they never touch `dev`.

Everything for an instance lives under `.local/<instance>/` (git-ignored): the PostgreSQL cluster, Redis directory, logs and `stack/roles.env` (mode 0600, role URLs and the acceptance probe secret). See `STACK.md` for the layout, the roles and the migration runner.

## 5. Which process holds which database role (finding I3)

| Process                                                | Receives                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout API                                           | only its own role URL (`NEMODOTS_PG_URL_CHECKOUT`), the Redis URL and prefix, its port and the probe secret; never the parent environment, never other role URLs |
| `stack.mjs exec` / `run` (migrate, seed, test runners) | the parent environment plus every URL in `roles.env`                                                                                                             |
| The OpenDots server (once bootstrap lands)             | the app, injector and verifier role URLs, read from `roles.env` by `config/roles-file.ts` and not exported to child processes                                    |

The rule that control data (fault schedules, scenario manifests, the probe secret) never reaches model context is enforced by code review and payload-scan tests, not by PostgreSQL grants alone. Do not describe it as a database-level guarantee.

## 6. Incident Dots: `NEMODOTS_INCIDENT_DOT_IDS` (finding I4)

OpenDots' ordinary Dots keep their upstream tools and approvals. A Dot you want treated as part of an incident (so it cannot use the capabilities that bypass NemoDots' evidence checks) is listed by id:

1. Create the Dot in the app, or `POST /api/dots`, and copy its id from the response.
2. Set `NEMODOTS_INCIDENT_DOT_IDS=<id>[,<id>...]` in the server's environment and restart the server.

With the list empty, none of the incident restrictions are active and upstream behaviour is unchanged. For a listed Dot, memories, research tools, Composio, computer tools, connected-service tools and learned skills are not offered or are refused; page reads work; `edit_space_page` is refused; creating a page is allowed only into a projection Space (none is configured by default, so it is refused); an approval created for a connected-service tool is revalidated against its evidence and stored request before it can run. The restrictions are checked by `tests/nemodots/interception` (fixture tests) and one live turn, and are defence in depth: the guarantee for controlled commits does not depend on them. The full table is `TOOL_COVERAGE.md`.

## 7. Running the tests

All of these use the instance chosen by `NEMODOTS_INSTANCE` and its ports.

| Command                                                          | What it needs                  | Observed                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                       | nothing running                | PASS (112 files, 1752 tests at the last full run before this document)                                                                                                                                                                                     |
| `npm run build`                                                  | nothing running                | PASS, exit 0                                                                                                                                                                                                                                               |
| `npm run typecheck`, `npm run lint`                              | nothing running                | **FAIL at the time of writing** (typecheck exit 2 with 10 errors, lint exit 1 with 2 unused-import errors), all in other packages' files that were being changed (watcher, ledger tests, race harness). They were green earlier in the build. Re-run them. |
| `npm run test:nemodots:db -- tests/nemodots/integration/stack`   | the stack running and migrated | PASS on `ci-docs` (5 files, 17 tests)                                                                                                                                                                                                                      |
| `npm run test:nemodots:db`                                       | same                           | the whole database suite; run on `dev` during development. Not repeated here.                                                                                                                                                                              |
| `npm run nemodots:stack -- reset-test`                           | the stack running              | PASS: drops leftover `nemodots_test_*` databases and `nemodots:test:*` Redis keys                                                                                                                                                                          |
| `npm run test:nemodots:live -- tests/nemodots/live/inference`    | Crusoe variables in `.env`     | PASS earlier on `dev` (10 passed, 1 skipped); not repeated here because it makes billed calls                                                                                                                                                              |
| `npm run test:nemodots:live -- tests/nemodots/live/interception` | Crusoe and Intelligence keys   | PASS earlier on `dev`. It creates a real conversation thread on CopilotKit Intelligence.                                                                                                                                                                   |
| `npm run test:nemodots:e2e`                                      | a browser                      | NOT_RUN                                                                                                                                                                                                                                                    |
| `npm run test:nemodots:acceptance`                               | the verifier's frozen suite    | NOT_RUN here; owned by the independent verifier                                                                                                                                                                                                            |
| `npm run nemodots:evals`, `npm run nemodots:report`              | later waves                    | NOT_RUN; they exit 2 until delivered                                                                                                                                                                                                                       |

Live suites never skip silently: with a key missing they print `BLOCKED: <names> missing` and fail. They keep at most two Crusoe requests in flight and write a redacted results file under `.local/<instance>/live/` that contains no secret value. A 429 from the provider is retried with backoff and shows up in that file.

## 8. Running the app

```sh
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH
npm run build
npm start          # http://127.0.0.1:4310 (set PORT to use another)
```

Observed with `PORT=4390` and a scratch SQLite path on an empty environment: PASS, `npm run build` exit 0; the server printed its listening line, `GET /api/state` answered 200 with `configured: false`, and the server stopped cleanly. For development use `npm run dev` (Vite on 5173, API on 4310): NOT_RUN here.

The mission screen is at `#/missions` in the app (nav item "Open missions").

## 9. What does not work yet (read this before demoing)

- **`GET /api/nemodots/health` is not reachable.** The route code and tests exist (`src/server/nemodots/routes/`), but nothing mounts them in `src/server/app.ts` or `index.ts` yet. That composition step (W5.1 bootstrap: coordinator, watcher, worker host, ledger-backed revalidation, injector wiring) is not done. Observed against the running server: `GET /api/nemodots/health` answers 404 `{"error":"Not found."}`. The "start a mission from the UI" path is therefore **NOT_RUN**. Until bootstrap lands, check the sandbox directly with `curl http://127.0.0.1:<checkout port>/health` (section 4).
- The `nemodots:evals` and `nemodots:report` commands do not exist yet.
- No evaluation results exist. See `DEMO.md` for the placeholders.
- Docker-based computers, voice, Slack and Automatic Learning are disabled in the core demo and were not exercised.

## 10. Troubleshooting

| Symptom                                                                    | Cause and fix                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postmaster became multithreaded during startup`                           | Homebrew PostgreSQL 16 on macOS needs a C locale. `stack.mjs` sets `LC_ALL=C` and `LANG=C` for every `initdb`/`pg_ctl`/`psql`/`pg_isready` it runs; if you run those by hand, set them too. |
| `tests/telemetry.test.ts` fails with 7 errors from `node:internal/console` | You are on Node 24.11.1 or 25.2.1. Use 24.13.1 or newer (section 2).                                                                                                                        |
| A command refuses port 5432 or 6379                                        | By design. Pick other ports with `NEMODOTS_PG_PORT`, `NEMODOTS_REDIS_PORT`, `NEMODOTS_CHECKOUT_PORT` or the `init` flags.                                                                   |
| A later command is refused for asking different ports                      | The instance remembers the ports it was created with. Use the same values, or `reset --yes` and `init` again.                                                                               |
| Default ports 55432/56379 are busy                                         | Another process (on the build machine, Colima's forwarder) holds them. Use a different instance with its own ports; do not stop the other process.                                          |
| `stack.mjs` refuses a very long path                                       | The PostgreSQL unix socket path must stay under 103 bytes. Use a shorter instance name or checkout path.                                                                                    |
| Live mode shows `blocked` with `OPENAI_BASE_URL` in `missingEnv`           | The variable is unset in the process environment. NemoDots has no default host.                                                                                                             |
| `404 model_not_found` from Crusoe                                          | The model id is wrong. Use `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`.                                                                                                                      |
| `429` during live runs                                                     | Provider rate limit. The adapter retries with jittered backoff; keep concurrency at two or fewer. A 429 is recorded in the telemetry, not hidden.                                           |
| Chat shows "Setup required"                                                | Intelligence needs its own key (`INTELLIGENCE_API_KEY` or `CPK_INTELLIGENCE_API_KEY`). Mission control does not depend on it.                                                               |
| Leftover `nemodots_test_*` databases after a crashed test run              | `npm run nemodots:stack -- reset-test`.                                                                                                                                                     |

## 11. Cleanup of this documentation pass

The `ci-docs` instance was stopped after the commands above. Its directory `.local/ci-docs` is git-ignored; remove it with `npm run nemodots:stack -- reset --yes` (which re-creates an empty instance) or by deleting the directory when the instance is stopped.
