# NemoDots operator setup

This page takes you from a fresh checkout to a running NemoDots with a passing health check. It assumes you have not read the build documents. NemoDots is the `NemoDots/` directory of this repository: the OpenDots application plus a mission-control layer that runs a team of NVIDIA Nemotron agents (on Crusoe Managed Inference) against a local, deliberately breakable checkout app. Upstream OpenDots setup is in [../SETUP.md](../SETUP.md) and is unchanged.

All commands run from the `NemoDots/` directory.

## What is BLOCKED in the reference environment

Stated first so you do not look for it.

- **Docker is not available** on the machine this was built and tested on (the Docker CLI is installed, there is no daemon, no Docker Desktop, no OrbStack). Nothing in NemoDots needs Docker. The upstream `Dockerfile`, `compose*.yml`, the OpenBot computers service and the local CopilotKit Intelligence evaluation (`npx copilotkit local setup`) all need it. They are present but were **not run or verified** here, and NemoDots does not use them.
- Because of that, PostgreSQL and Redis run as **native binaries** started by `scripts/nemodots/stack.mjs`, not as containers.
- Disabled for the incident scope: Composio connected apps, voice, Slack, Automatic Learning, the browser worker, and computers.
- CopilotKit Intelligence (conversations with a Dot) is optional for NemoDots. Mission control, the evidence ledger, the coordinator and the mission page work without it and say so. See [Intelligence](#copilotkit-intelligence-optional).

## Prerequisites

| Need                     | Notes                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 or newer, npm | The reference machine uses Node 25.8.0 and npm 11.11.0.                                                                          |
| PostgreSQL 16 binaries   | `initdb`, `pg_ctl`, `postgres`, `psql`, `pg_isready` on `PATH` or in `/opt/homebrew/bin`. Tested with Homebrew PostgreSQL 16.13. |
| Redis 8 binary           | `redis-server` (tested with Homebrew Redis 8.6.2).                                                                               |
| macOS or Linux           | Tested on macOS arm64 only. Unix socket paths must stay under 103 bytes, so keep the checkout path and instance name short.      |
| A Crusoe API key         | For live mode. The key is for `https://api.inference.crusoecloud.com/v1`.                                                        |

**Ports 5432 and 6379 are never used.** They are assumed to be your own PostgreSQL and Redis. Every NemoDots script and the server's config loader refuse those ports, including URLs that omit a port and would fall back to them. NemoDots uses its own instances on 55432 (PostgreSQL), 56379 (Redis) and 4510 (checkout API) by default.

## 1. Install

```sh
npm ci
```

If a cold npm cache makes `npm ci` fail once, run it again. Never run two `npm ci` or `npm install` at the same time in the same checkout.

## 2. Create the local stack

A stack instance is a directory `.local/<instance>/` (git-ignored) holding a PostgreSQL cluster, a Redis working directory, logs, and a generated `roles.env`. The default instance is `dev`.

```sh
npm run nemodots:stack -- init
npm run nemodots:stack -- start
npm run nemodots:stack -- status
```

`init` runs `initdb` and writes `.local/dev/stack/roles.env` (mode 0600) with one generated password per database role and a probe secret. `start` starts PostgreSQL and Redis, creates the roles and the `nemodots` database, and starts the checkout API on port 4510. `status` exits 0 when PostgreSQL accepts connections, Redis answers `PONG`, and the checkout process is running.

Nothing prints a value from `roles.env` or `.env`. Do not copy role URLs into `.env`.

## 3. Create `.env` without echoing secrets

```sh
cp .env.example .env
```

Set your Crusoe key without it appearing on screen, in shell history or in a process list (`read -s` does not echo; `printf` is a shell builtin):

```sh
read -rs -p 'Crusoe API key (hidden): ' KEY; echo
printf '%s' "$KEY" | node -e '
const fs = require("fs");
const key = fs.readFileSync(0, "utf8").trim();
let text = fs.readFileSync(".env", "utf8");
const line = /^OPENAI_API_KEY=.*$/m;
text = line.test(text)
  ? text.replace(line, () => "OPENAI_API_KEY=" + key)
  : text + "\nOPENAI_API_KEY=" + key + "\n";
fs.writeFileSync(".env", text, { mode: 0o600 });'
unset KEY
```

Then set the model and the run mode (these are not secret). On macOS `sed -i ''`; on Linux `sed -i`:

```sh
sed -i '' 's|^OPENAI_MODEL=.*|OPENAI_MODEL=nvidia/NVIDIA-Nemotron-3-Super-120B-A12B|; s|^NEMODOTS_INFERENCE_MODE=.*|NEMODOTS_INFERENCE_MODE=live|' .env
```

### The three required names, and no default base URL

Live mode needs **all three** of:

| Name              | Value                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | your Crusoe key                                                                                       |
| `OPENAI_BASE_URL` | `https://api.inference.crusoecloud.com/v1`                                                            |
| `OPENAI_MODEL`    | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` (the planner, specialists, verifier and repair all use it) |

**NemoDots has no default for `OPENAI_BASE_URL`.** If any of the three is missing or empty the mode becomes `blocked`, mission creation returns HTTP 503 with the missing **names** (never values), and nothing is sent to any provider. There is no silent fallback to another provider or host. `.env.example` ships `OPENAI_BASE_URL=https://api.inference.crusoecloud.com/v1` as an active line on purpose, so keep it: if you delete the line, upstream OpenDots (`src/server/index.ts`) falls back to `https://api.openai.com/v1` for Dot turns and would send your Crusoe key there.

Verify model IDs against the provider before relying on them: `GET https://api.inference.crusoecloud.com/v1/models` with your key (do this in a way that does not print the key). Other IDs seen live at the time of writing: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3.5-Lightning-30B-A3B`. Nemotron Ultra is not available. At boot and on each health request the server checks that `/v1/models` lists the configured model.

Provider behaviour that affects you: reasoning is on by default and small token budgets can come back empty; keep at most 4 requests in flight (`NEMODOTS_INFERENCE_MAX_IN_FLIGHT` is capped at 4); expect HTTP 429 under bursts, which the client retries with backoff; no `x-ratelimit-*` headers are returned, so throttling is client-side.

### Other run modes

| `NEMODOTS_INFERENCE_MODE` | Meaning                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`                    | Needs the three names above. Real Nemotron calls on Crusoe. If a name is missing the server reports `blocked` instead.                                          |
| `fixture`                 | Needs `NEMODOTS_FIXTURE_PATH`. Model responses are prerecorded scripts. Missions are labelled **FIXTURE** everywhere; they prove plumbing, not model behaviour. |
| `blocked`                 | Explicitly no inference. The page stays usable for past missions, evidence and health; new missions get HTTP 503.                                               |

`.env.example` ships `blocked`. A request body `mode` that disagrees with the server's mode is rejected with HTTP 400.

### A non-default instance

`.env.example` already holds the non-secret `NEMODOTS_*` values for the default `dev` instance. For another instance, change those lines by hand (or pass them in the shell, which wins over `.env`). `node scripts/nemodots/write-env.mjs --instance <name> --mode live [--file <path>]` appends a marked block of non-secret names, but it keeps any name you already set outside its block, so run it against a file that has no `NEMODOTS_*` lines. It never writes role URLs or the probe secret and prints only names.

## 4. Migrate and seed

```sh
npm run nemodots:migrate
npm run nemodots:migrate -- --check   # exit 0 when nothing is pending
npm run nemodots:seed
```

`migrate` runs as the `nemodots_admin` role under a PostgreSQL advisory lock and applies each pending migration in its own transaction. The server refuses to boot with pending or unknown migrations. `seed` inserts the healthy checkout baseline (products, inventory, 200 historical orders, the configuration entries); it is idempotent. To put the configuration back to the healthy values after a demo, run `npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts seed --reset-config`.

## 5. Run

```sh
npm run dev
```

This starts the API on `http://127.0.0.1:4310` and Vite on `http://127.0.0.1:5173`. Open the Vite address and choose **Missions** in the sidebar. The server reads the role URLs it needs from `.local/<instance>/stack/roles.env` itself (see [Which process holds which role URL](#which-process-holds-which-role-url)); `npm run dev` does not need to be wrapped in `stack.mjs exec`.

To run workers in a separate process (optional), set `NEMODOTS_WORKERS=0` for the server and start:

```sh
npm run nemodots:worker
```

The in-process worker host and the separate worker process use the same handler. With `NEMODOTS_WORKERS=2` (the default) you do not need the separate process.

A built app instead of the dev servers: `npm run build && npm start`, then open `http://127.0.0.1:4310`.

## 6. Health checks

```sh
npm run nemodots:stack -- status
curl -s http://127.0.0.1:4510/health
curl -s http://127.0.0.1:4310/api/nemodots/health
```

Expected, with the stack up, migrated, seeded and the server running in live mode:

- The checkout API returns `{"status":"ok","checks":{"postgres":true,"redis":true,"config_parse":true,"writes":true,"cache":true,"pool":true},"errors":[]}`.
- `/api/nemodots/health` returns an object with `postgres: "ok"`, `redis: "ok"`, `checkout: { "reachable": true, "status": "ok" }`, `mode: "live"`, `provider.host` equal to the host of your `OPENAI_BASE_URL`, `provider.modelListed: true`, `intelligence: "configured"` or `"blocked"`, `missingEnv: []`, and `incidentDotIds` (a count). With a name missing, `mode` is `blocked` and `missingEnv` lists the names. With the stack stopped, `postgres` is `down` while the rest of the app (`/api/state`) keeps serving.

The mission page header shows the same state as badges: **Live**, **Fixture** or **Blocked**, and **Intelligence configured** or **Intelligence blocked**.

## Incident Dots: `NEMODOTS_INCIDENT_DOT_IDS`

The Nemotron mission team is always governed by NemoDots' evidence and action rules. Separately, an OpenDots **Dot** (the chat agent) can also be made subject to those rules, so that its tools cannot write pages, call connected apps or run computers outside the evidence boundary. OpenDots Dots have no profile field that marks them, so the list is the mechanism:

```sh
NEMODOTS_INCIDENT_DOT_IDS=dot-id-1,dot-id-2
```

Use the Dot ids from the OpenDots UI or its API. Comma-separated, whitespace is trimmed. **With the list empty (the default) every one of these defence-in-depth hooks is inactive and upstream OpenDots behaviour is unchanged.** `/api/nemodots/health` reports only the count (`incidentDotIds`). `docs/nemodots/TOOL_COVERAGE.md` lists every model-visible tool and how each is treated for an incident Dot. Restart the server after changing the list.

## Which process holds which role URL

The database has five roles with separate passwords: `nemodots_admin`, `nemodots_app`, `nemodots_checkout`, `nemodots_injector`, `nemodots_verifier`. Their URLs and `NEMODOTS_PROBE_SECRET` live in `.local/<instance>/stack/roles.env`.

| Process                                                                            | Receives                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout API (`stack start`, `npm run nemodots:checkout`)                          | An explicit minimal environment: the checkout role URL, Redis URL and prefix, checkout port, probe secret, `LC_ALL`, `PATH`. Never the other role URLs, never the parent environment. |
| Anything run through `stack.mjs exec` / `run` (migrate, seed, test runners, evals) | The parent environment plus all of `roles.env` plus the instance's non-secret `NEMODOTS_*` values.                                                                                    |
| OpenDots server (`npm run dev`, `npm start`)                                       | Reads `roles.env` itself and holds the app, injector and verifier URLs (and admin in development, for `migrate --check` at boot). It does not export them to child processes.         |
| Separate worker (`npm run nemodots:worker`)                                        | Reads `roles.env` the same way; which roles it opens is decided in `src/server/nemodots/worker-main.ts`.                                                                              |

The honest limit: because the one server process holds the app, injector and verifier URLs, the rule that fault-injection and verifier data never reach model context is **code discipline plus payload-scan tests**, not PostgreSQL grants alone. The grants still matter (the checkout API and the app role cannot read injector control tables), but they do not isolate the server process from itself.

## Tests and modes

| Command                                              | Needs                             | What it covers                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`, `npm run lint`, `npm run build` | nothing running                   | Upstream gates.                                                                                                                                  |
| `npm run check-format`                               | nothing running                   | Prettier check over `src`, `tests`, `docs`, `README.md` and config files.                                                                        |
| `npm test`                                           | nothing running, no network       | Unit and component tests. Excludes `tests/nemodots/{integration,live,e2e,acceptance}`.                                                           |
| `npm run test:nemodots:db [-- <path>]`               | stack running and migrated        | Real PostgreSQL and Redis suites. Each creates a uniquely named `nemodots_test_<hex>` database and a random Redis prefix and removes only those. |
| `npm run test:nemodots:live [-- <path>]`             | stack, the three `OPENAI_*` names | Billed Crusoe calls; files run one at a time; at most 4 inference calls in flight. A missing key reports BLOCKED, it is not skipped.             |
| `npm run test:nemodots:e2e`                          | stack, built or dev server        | Browser tests, one file at a time.                                                                                                               |
| `npm run test:nemodots:acceptance`                   | stack                             | The independent verifier's suite (its config is owned by the verifier).                                                                          |
| `npm run nemodots:evals`, `npm run nemodots:report`  | stack                             | Scenario evaluation and the report.                                                                                                              |
| `node scripts/nemodots/notices.mjs --check`          | nothing running                   | `THIRD_PARTY_NOTICES.md` matches the lockfile.                                                                                                   |

`NEMODOTS_TEST_HOOKS` enables race-test barriers. **Never set it in a run you label live.** Run live suites on a dedicated instance so they cannot disturb a stack you are using.

## Concurrent isolated instances

Each instance has its own directory, ports and Redis key prefix, so several can run side by side (for example your `dev` instance and a `ci-b` test instance). Choose with `NEMODOTS_INSTANCE=<name>` or `--instance <name>`; names match `^[a-z0-9][a-z0-9-]{0,23}$`.

```sh
export NEMODOTS_INSTANCE=ci-b
npm run nemodots:stack -- init --pg-port 55433 --redis-port 56380 --checkout-port 4511
npm run nemodots:stack -- start
npm run nemodots:migrate
npm run nemodots:seed
npm run test:nemodots:db -- tests/nemodots/integration/stack
npm run nemodots:stack -- stop
```

The ports are recorded in `.local/ci-b/stack/instance.json`; a later command that asks for different ports is refused. To run a second **application** against another instance, also give it its own `PORT`, `DATABASE_PATH` and matching `NEMODOTS_*` values, and prefer `npm run build && npm start` over a second `npm run dev` (Vite wants 5173).

Stop what you start: `npm run nemodots:stack -- stop` signals only processes whose pid files it wrote and whose command line still matches. `npm run nemodots:stack -- reset --yes` stops the instance, **deletes its data** and runs `init` again. `npm run nemodots:stack -- reset-test` drops leftover `nemodots_test_*` databases and `nemodots:test:*` Redis keys on a running instance.

## CopilotKit Intelligence (optional)

Intelligence provides OpenDots conversation storage. Set `CPK_INTELLIGENCE_API_KEY` (or `INTELLIGENCE_API_KEY`) in `.env`; see [../SETUP.md](../SETUP.md#hosted-intelligence). The hosted service needs no Docker; the local evaluation does and is therefore BLOCKED in the reference environment. Without a key, `/api/nemodots/health` reports `intelligence: "blocked"` and Dot conversations are unavailable, but missions still run.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postmaster became multithreaded during startup`               | Homebrew PostgreSQL 16 needs a fixed locale. `stack.mjs` sets `LC_ALL=C` and `LANG=C` for every `initdb`, `pg_ctl`, `psql` and `pg_isready` call. If you run those tools by hand, run `export LC_ALL=C LANG=C` first. |
| `... is refused: 5432/6379 belong to the user's own ...`       | By design. Use other ports with `--pg-port` / `--redis-port` at `init`.                                                                                                                                               |
| `roles.env ... must have mode 0600`                            | Run `chmod 600 .local/<instance>/stack/roles.env`.                                                                                                                                                                    |
| `roles.env for instance "x" does not exist`                    | Run `npm run nemodots:stack -- init` for that instance, and check `NEMODOTS_INSTANCE`.                                                                                                                                |
| Socket path error from `stack.mjs`                             | The unix socket path must stay under 103 bytes. Use a shorter instance name or checkout path.                                                                                                                         |
| `stack.mjs` refuses an instance directory                      | It only manages directories that carry its own `instance.json` and a `pg/` marker with the same `stackId`. Do not copy or rename instance directories.                                                                |
| Server boot fails on migrations                                | Run `npm run nemodots:migrate`. Unknown migration ids in the database (from a newer checkout) also fail; use a fresh instance.                                                                                        |
| Mission create returns 503 with `missingEnv`                   | Live mode needs `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`. Names only are reported. Set them and restart the server.                                                                                        |
| Mission shows `blocked_provider`                               | The provider became unreachable while attempts were in flight. Fix connectivity or the key, then **Start** the mission again.                                                                                         |
| `postgres: down` in health but the app loads                   | The stack is not running. `npm run nemodots:stack -- start`.                                                                                                                                                          |
| Checkout `/health` is `degraded` or `down` right after `start` | Normal before `migrate` and `seed`. After them it should be `ok`. If an earlier demo left a fault in place, run `npm run nemodots:stack -- run src/server/nemodots/sandbox/cli.ts seed --reset-config`.               |
| 429 from the provider                                          | Too many requests in flight. The client retries with backoff; lower `NEMODOTS_INFERENCE_MAX_IN_FLIGHT` (maximum 4).                                                                                                   |
| Empty model replies with `finish_reason: length`               | Reasoning consumed the token budget. The NemoDots client sets budgets itself; this only appears in hand-made requests.                                                                                                |
