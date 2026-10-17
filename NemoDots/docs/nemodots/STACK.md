# NemoDots local stack (W1.2 local-stack)

Native PostgreSQL 16 and Redis 8 for NemoDots, without Docker. Everything lives under `NemoDots/.local/<instance>/` (gitignored) so several isolated instances can run side by side. The user's own PostgreSQL on 5432 and Redis on 6379 are never contacted: every script and `config/env.ts` refuse those ports, including URLs that omit a port and would fall back to them.

## Dependencies added

Installed once each with `DO_NOT_TRACK=1 SCARF_ANALYTICS=false`:

| Command                                                | Result                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `npm install --save-exact pg@8.23.1 redis@5.12.1`      | exit 0, added 20 packages                                          |
| `npm install --save-dev --save-exact @types/pg@8.23.1` | exit 0, added 1 package                                            |
| `package-lock.json` sha256 before (upstream)           | `355564cda5d1b2c452fe7870a0c9d2602c3e320e7680228853b38f9f641c4066` |
| `package-lock.json` sha256 after (recorded 2026-10-17) | `867d88b73fc07a7ad271f1c62ce82d389c615ab28a63fd95700dc4480ede962a` |

## Commands

| npm script                                   | What it runs                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run nemodots:stack -- init`             | creates `.local/<instance>/`, runs `initdb`, generates `roles.env`                                                            |
| `npm run nemodots:stack -- start`            | starts PostgreSQL and Redis, ensures roles (with passwords) and the `nemodots` database, spawns the checkout API when present |
| `npm run nemodots:stack -- status`           | `pg_isready`, Redis `PING`, checkout pid; exit 1 if PostgreSQL or Redis is down (or the checkout API exists but is not up)    |
| `npm run nemodots:stack -- stop`             | stops the checkout API, Redis and PostgreSQL that this script started                                                         |
| `npm run nemodots:stack -- reset --yes`      | stop, delete the instance directory, `init` again (same ports)                                                                |
| `npm run nemodots:stack -- reset-test`       | drops leftover `nemodots_test_*` databases and `nemodots:test:*` Redis keys on a running instance                             |
| `npm run nemodots:migrate [-- --check]`      | migration runner as `nemodots_admin`; `--check` exits 1 when anything is pending or unknown                                   |
| `npm run nemodots:seed`                      | `src/server/nemodots/sandbox/seed.ts`; exits 2 "not implemented yet" until W2 delivers it                                     |
| `npm run nemodots:checkout`                  | the checkout API in the foreground with its minimal environment; exits 2 until W2 delivers `sandbox/checkout-main.ts`         |
| `npm run test:nemodots:db [-- <path>]`       | `vitest run --config vitest.integration.config.ts` with the instance's role URLs                                              |
| `npm run test:nemodots:live`                 | `vitest.live.config.ts` (Crusoe; serial files)                                                                                |
| `npm run test:nemodots:e2e`                  | `vitest.e2e.config.ts` (browser; serial files)                                                                                |
| `npm run test:nemodots:acceptance`           | `tests/nemodots/acceptance/vitest.config.ts` (owned by the independent verifier)                                              |
| `npm run nemodots:evals` / `nemodots:report` | `src/server/nemodots/evals/cli.ts` / `scripts/nemodots/report.mjs`; exit 2 until those waves deliver them                     |

The instance is chosen with `NEMODOTS_INSTANCE` (default `dev`) or `--instance <name>`. Ports default to 55432 (PostgreSQL), 56379 (Redis) and 4510 (checkout) and can be set at `init` with `--pg-port`, `--redis-port`, `--checkout-port` or the matching `NEMODOTS_*_PORT` variables; they are recorded in `.local/<instance>/stack/instance.json` and a later command that asks for a different port is refused. Tests use `ci-*` instances, for example:

```sh
NEMODOTS_INSTANCE=ci-w1 npm run nemodots:stack -- init
NEMODOTS_INSTANCE=ci-w1 npm run nemodots:stack -- start
NEMODOTS_INSTANCE=ci-w1 npm run nemodots:migrate
NEMODOTS_INSTANCE=ci-w1 npm run test:nemodots:db -- tests/nemodots/integration/stack
NEMODOTS_INSTANCE=ci-w1 npm run nemodots:stack -- stop
npm run nemodots:stack -- init --instance ci-b --pg-port 55433 --redis-port 56380 --checkout-port 4511
```

`npm test` never needs the stack: `vitest.config.ts` merges `vite.config.ts` and excludes `tests/nemodots/{integration,live,e2e,acceptance}/**`.

## Layout of `.local/<instance>/`

| Path                  | Contents                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `stack/instance.json` | ownership marker (`createdBy`, random `stackId`), ports, database name                                    |
| `stack/roles.env`     | mode 0600: `NEMODOTS_PG_URL_{ADMIN,APP,CHECKOUT,INJECTOR,VERIFIER}` and `NEMODOTS_PROBE_SECRET`           |
| `pg/`                 | PostgreSQL cluster (`initdb --locale=C -U nemodots_super`), `nemodots-stack.json` marker, `nemodots.conf` |
| `redis/`              | Redis working directory (no RDB/AOF: `--save '' --appendonly no`)                                         |
| `run/` (0700)         | PostgreSQL unix socket, `redis.pid`, `checkout.json` (pid + entry)                                        |
| `logs/`               | `initdb.log`, `postgres.log`, `redis.log`, `checkout.log`                                                 |

`stack.mjs` refuses an instance directory that exists without its own `instance.json`, and a `pg/` cluster whose marker does not carry the instance's `stackId`. `stop` signals only processes whose pid file it wrote and whose command line still matches (`redis-server … :<port>`, the checkout entry path); PostgreSQL is stopped with `pg_ctl -D <own data dir>`.

## Facts about this machine

- `LC_ALL=C` (and `LANG=C`) is set for every `initdb`, `pg_ctl`, `psql` and `pg_isready` call. Without it Homebrew PostgreSQL 16.13 exits with `postmaster became multithreaded during startup`.
- The unix socket path must stay under 103 bytes; `stack.mjs` checks this before doing anything.

## Authentication and secrets

- `pg_hba.conf`: `local all all trust` (the socket directory is mode 0700, so only the owning user reaches it) and `host all all 127.0.0.1/32 scram-sha-256` / `::1/128`. `listen_addresses = '127.0.0.1'`.
- The bootstrap superuser `nemodots_super` has no password and is used only by `stack.mjs` over the socket. `nemodots_admin` is `LOGIN CREATEDB CREATEROLE` (not superuser) plus `pg_signal_backend` so test databases can be dropped `WITH (FORCE)`.
- `init` generates one 24-byte hex password per role and a 32-byte probe secret with `crypto.randomBytes` into `roles.env` (created with `wx`, mode 0600). `start` sends each role's password to PostgreSQL as a pre-computed SCRAM-SHA-256 verifier, so no plaintext password ever reaches the server or its log; `log_statement = 'none'` and `log_min_error_statement = panic` keep statements out of `postgres.log`.
- Nothing prints a value from `roles.env` or `.env`. Errors that could carry SQL or URLs pass through a redactor.
- `scripts/nemodots/write-env.mjs [--instance <name>] [--mode live|fixture|blocked] [--file <path>]` appends only non-secret names to `NemoDots/.env` (instance, host, ports, database, Redis URL and prefix, checkout URL, inference mode) inside a marked block that it replaces on re-run. It never writes `NEMODOTS_PG_URL_*` or `NEMODOTS_PROBE_SECRET`, keeps names the user already set outside the block, and prints only names.

## Which process holds which credential (finding I3, honest statement)

| Process                                                                                       | Receives                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checkout API (`stack.mjs start` / `nemodots:checkout`)                                        | an explicit env object with exactly `NEMODOTS_PG_URL_CHECKOUT`, `NEMODOTS_REDIS_URL`, `NEMODOTS_REDIS_PREFIX`, `NEMODOTS_CHECKOUT_PORT`, `NEMODOTS_PROBE_SECRET`, `LC_ALL`, `PATH`; never the parent env, never the other role URLs. On macOS the OS itself adds `__CF_USER_TEXT_ENCODING` to every process.                                                     |
| anything run through `stack.mjs exec` / `run` (migrations, seed, test runners, evals, report) | the parent environment plus all of `roles.env` plus the instance's non-secret `NEMODOTS_*` values                                                                                                                                                                                                                                                                |
| OpenDots server process (W5 bootstrap)                                                        | app, injector and verifier URLs (and admin in development, for `migrate --check` at boot). The "control data never reaches model context" rule is code discipline plus payload-scan tests, not PostgreSQL grants alone (ARCHITECTURE section 3). `src/server/nemodots/config/roles-file.ts` reads `roles.env` for that process without exporting it to children. |

## Database roles and grants (`db/migrations/0001_bootstrap.ts`)

One database `nemodots` (plus throwaway `nemodots_test_<hex>` databases), schemas `ledger`, `coordinator`, `checkout`, `control`, all owned by `nemodots_admin`. `PUBLIC` loses `CONNECT` on the database and all rights on the four schemas. Default privileges for tables that `nemodots_admin` creates later:

| Role                | Schema usage                  | Default table rights                                |
| ------------------- | ----------------------------- | --------------------------------------------------- |
| `nemodots_app`      | ledger, coordinator, checkout | DML on ledger and coordinator; `SELECT` on checkout |
| `nemodots_checkout` | checkout                      | `SELECT` (+ sequence `USAGE, SELECT`)               |
| `nemodots_injector` | checkout, control             | DML on control; nothing by default on checkout      |
| `nemodots_verifier` | all four                      | `SELECT` everywhere                                 |

Per-table rights beyond these defaults (checkout business-table DML for `nemodots_checkout`; `UPDATE` on `config_entries`/`config_collection` and `INSERT` on `config_versions` for `nemodots_app` and `nemodots_injector`) are granted by the migration that creates those tables (W2 `0004_checkout`). PostgreSQL has no LISTEN privilege: any role with `CONNECT` can `LISTEN`; app and injector are covered by an integration test.

## Migration runner (`src/server/nemodots/db/migrate.ts`)

Runs as `nemodots_admin` only (it checks `current_user`), takes a session `pg_advisory_lock` (per database), keeps `public.schema_migrations(id, applied_at)`, discovers `migrations/NNNN_name.{ts,js}` by listing the directory next to `import.meta.url` (so it works under `tsx` and from `dist/server/server/nemodots/db/`), sorts by name, imports each module (`export default { id, up(client) }`, `id` must equal the file name) and applies each pending one in its own transaction. Ids present in the database but unknown to the code fail the run and the check.

## Database helpers

- `db/pool.ts`: `createRolePool(role, url)` / `createRolePools(config, roles)`; `max` 4 (admin, injector, verifier) or 8 (app, checkout), `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 30 s, `application_name = nemodots-<role>`; idle-client errors are reported with the role and message only.
- `db/tx.ts`: `withTransaction(pool, fn, { isolation, readOnly, maxAttempts })` retries `40001` and `40P01` with full-jitter exponential backoff (10 ms base, 500 ms cap, 5 attempts). Never await non-database work (model calls, HTTP, Redis effects, timers) inside `fn`: it holds row locks and is re-executed on retry.
- `tests/nemodots/helpers/test-db.ts`: `withTestDatabase(async ({ urls: { admin, app, checkout, injector, verifier }, name }) => …)` creates `nemodots_test_<hex>` on the instance port (refusing 5432 and non-loopback hosts), migrates it, and drops it `WITH (FORCE)`.
- `tests/nemodots/helpers/test-redis.ts`: `withTestRedis(async ({ client, prefix, url }) => …)` with a random `nemodots:test:<hex>` prefix on the instance Redis; cleanup is `SCAN` + `UNLINK` of that prefix, never `FLUSHALL`/`FLUSHDB`.
- `tests/nemodots/helpers/barrier.ts`: `latch()`, `barrier(n)`, `withTimeout()` for deterministic race tests.
