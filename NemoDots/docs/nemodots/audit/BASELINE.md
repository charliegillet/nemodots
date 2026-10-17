# Upstream baseline (Phase 0 audit)

- Auditor: Phase 0 auditor (baseline), Claude Code workflow subagent (Fable 5.1), 2026-10-17 (~20:05-20:18 UTC).
- Subject: the unmodified OpenDots import at `NemoDots/` (CopilotKit/OpenDots `ab39f2508f3fd23a949837622456f3d61a108e9a`, squashed subtree; lockfile sha256 `355564cd…f641c4066`, recorded by the dependency auditor in `lockfile.sha256`).
- Environment: macOS arm64 (Darwin 27.0.0), 10 CPUs, Node v25.8.0, npm 11.11.0, no Docker daemon. `package.json` declares `engines.node >= 24`; upstream CI (`.github/workflows/ci.yml`) uses Node 24 on ubuntu.
- Mode: every number below comes from commands I ran today in `/Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots`. Raw logs: `NemoDots/.local/baseline/*.log` (gitignored). Nothing in `src/`, `tests/` or config was edited. No git commands were run.
- Note: a separate Phase 0 dependency auditor ran the same gates in parallel at ~20:13-20:15 UTC and left `baseline-*.log` files beside this report; their results agree with mine (see cross-check below).

## Gate results

| #   | Command                                          | Exit | Wall time | Result                                       | Notes                                                                                                                                                                                                            |
| --- | ------------------------------------------------ | ---- | --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | `npm ci --no-audit --no-fund`                    | 1    | 4m45s     | FAIL (transient)                             | Cold cache. ~450 `tarball data … seems to be corrupted. Trying again` / `TAR_ENTRY_ERROR ENOENT` warnings, then fatal `ENOENT: Cannot cd into node_modules/type-graphql/node_modules/semver`. See excerpt below. |
| 1b  | `npm ci --no-audit --no-fund` (retry)            | 0    | 8.4s      | PASS                                         | `added 1030 packages in 8s`; `node_modules` = 972 MB. 3 deprecation warnings (`hast@1.0.0`, `lodash.get@4.4.2`, `node-domexception@1.0.0`). `npm ls --depth=0` exit 0, no invalid/missing/extraneous.            |
| 2   | `npm run typecheck`                              | 0    | 4s        | PASS                                         | `tsc --noEmit` over `src`, `tests`, `vite.config.ts` (tsconfig.json `include`).                                                                                                                                  |
| 3   | `npm run lint`                                   | 0    | 1s        | PASS                                         | `eslint src tests vite.config.ts`; flat config, `typescript-eslint` recommended (non type-aware), unused vars with `^_` ignored.                                                                                 |
| 4   | `npm test`                                       | 0    | 9s        | PASS                                         | `cross-env DO_NOT_TRACK=1 vitest run`: **54 files, 344 tests passed**, vitest duration 6.99s. One Vite warning (below).                                                                                          |
| 5   | `npm run build`                                  | 0    | 4s        | PASS                                         | `vite build` (1.50s) + `tsc -p tsconfig.server.json` -> `dist/client/` and `dist/server/{server,browser,shared}/`. Chunk-size warning (below).                                                                   |
| 6   | `npm run check-format`                           | 1    | 2s        | FAIL (NemoDots docs only; upstream is clean) | Prettier flags only `docs/nemodots/BUILD_PROMPT.md`, `docs/nemodots/TEST_PROMPT.md`, `docs/nemodots/audit/CRUSOE_SMOKE_PRE.md` (parallel run also saw `audit/FRONTEND.md`).                                      |
| 6b  | same prettier command with `"!docs/nemodots/**"` | 0    | 2s        | PASS                                         | "All matched files use Prettier code style!" — i.e. the **upstream tree passes `check-format`**; the failure is introduced by files this project added.                                                          |

Gates 2, 3 and 6 ran concurrently; 4 and 5 ran concurrently; durations are wall-clock under that contention (all are short enough that it does not matter).

### 1a excerpt (pre-existing/transient, not a source defect)

```
npm warn tarball tarball data for semver@https://registry.npmjs.org/semver/-/semver-7.8.5.tgz (sha512-…) seems to be corrupted. Trying again.   (x8)
npm warn tar TAR_ENTRY_ERROR ENOENT: no such file or directory, lstat '…/node_modules/js-tiktoken/dist'   (x5)
npm error code ENOENT
npm error syscall chdir
npm error path /Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots/node_modules/type-graphql/node_modules/semver
npm error enoent ENOENT: Cannot cd into '…/node_modules/type-graphql/node_modules/semver'
```

Interpretation: the npm debug log shows registry fetches taking 34-68 s per tarball on the cold run (cache misses) while extraction raced ahead; the immediate retry with a warm cache succeeded in 8 s. The dependency auditor's independent `npm ci` (their `baseline-npm-ci.log`) showed the same "seems to be corrupted" warnings but completed. Treat this as a flaky-network/npm-extraction issue; any clean-install script should retry `npm ci` once before declaring failure. Not a code problem; nothing to fix in source.

### Warnings that are pre-existing (do not count them as regressions later)

- vitest and vite build: `(!) Your Vite config uses features that are unsupported by configLoader: 'native' … import "./src/build/dark-theme" without a file extension (vite.config.ts:3:27)`. Cosmetic; silence with `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` or leave as is.
- vite build: `(!) Some chunks are larger than 500 kB after minification` (`index-*.js` 2.75 MB / 796 kB gzip; several shiki language chunks, cytoscape, wasm).

### Cross-check with the parallel dependency auditor's logs (`docs/nemodots/audit/baseline-*.log`)

Their run (20:13-20:15Z): typecheck exit 0, lint exit 0, test exit 0 with the identical `54 passed / 344 passed`, build exit 0, check-format exit 1 on the same NemoDots-added docs (+ `FRONTEND.md`). Consistent with this report.

## Test-suite inventory

- Runner: **vitest 4.1.11**, invoked as `cross-env DO_NOT_TRACK=1 vitest run`. **There is no `vitest.config.*` or `vitest.workspace.*`**; vitest picks up `vite.config.ts` (react plugin + dark-theme PostCSS plugin) and default include `**/*.{test,spec}.?(c|m)[jt]s?(x)`. Default environment is `node` for every file: there is **no jsdom/happy-dom** in the lockfile; the 9 `.tsx` tests render with `react-test-renderer` (6 files import it directly).
- Files: 54 test files in `tests/` (44 `.ts`, 9 `.tsx`, 1 `.js`: `computer-deployment.test.js`), flat, no subdirectories besides `tests/fixtures/`.
- Fixtures: `tests/fixtures/README.md`, `learning-skills.zip` (synthetic Intelligence skill snapshot `fixture-v1`, SHA-256 in its manifest), `model-stream.ts`. Tests build the Hono app in-process (`createApp({...})` + `app.request(...)`, `new Store(':memory:')`), use `mode: 'sample'` research config and `*.invalid` / `*.example` base URLs. **No network credentials are needed**; `.env` is not loaded by vitest (no `--env-file` in the test script) and the suite passed before `NemoDots/.env` existed.
- Playwright: `playwright@^1.63.0` is a **runtime** dependency used only by `src/browser/index.ts` (the isolated read-only browser service, `chromium.launch`). It is **not used by any test** and `@playwright/test` is **not installed** (0 hits in the lockfile). Upstream has no browser/UI end-to-end suite; `.gitignore` already ignores `playwright-report/` and `test-results/`. Local Playwright CLI reports 1.63.0 and `~/Library/Caches/ms-playwright` already holds `chromium-1208`, `chromium-1223`, `chromium_headless_shell-1223/1248` — any NemoDots Playwright UI suite must still verify the exact browser revision 1.63.0 expects (`npx playwright install chromium`), as a separate, explicit command (TEST_PROMPT: separate deterministic suites, unit suite stays network-free).
- CI gate order upstream: `check-format`, `lint`, `typecheck`, `test`, `build` (`.github/workflows/ci.yml`, Node 24). Preserve all five (BUILD_PROMPT §Testing).

## Boot without Intelligence configured

Procedure (`.local/baseline/boot.sh`, built artifact `dist/server/server/index.js`, cwd `NemoDots` so `./dist/client` resolves): start with `env -i` plus only `PATH HOME HOST=127.0.0.1 PORT NODE_ENV=production DO_NOT_TRACK=1 DATABASE_PATH=.local/baseline/boot-<mode>/opendots.sqlite`, poll `/api/state` until a real HTTP status, probe, `SIGTERM`, wait. Two modes:

| Mode    | Port | Env                                                                                                                 | Ready after | `/api/state.configured` | `/api/workspace.setup`                                                                                                                                                                                | SIGTERM exit / time |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `clean` | 4399 | no `.env`, no keys at all                                                                                           | 705 ms      | `false`                 | `intelligence:false, model:false, browser:false, voice:false, composio:false, slack:"not_configured", missing:["INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY)","OPENAI_API_KEY","OPENAI_MODEL"]` | 0 / 324 ms          |
| `env`   | 4398 | `node --env-file=.env` (Crusoe key as `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`; Intelligence keys empty) | 705 ms      | `true`                  | `intelligence:false, model:true, …, missing:["INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY)"]`                                                                                                   | 0 / 330 ms          |

Both boots: PASS — the server starts, logs `OpenDots template listening on http://127.0.0.1:<port>`, creates the SQLite file (WAL mode: `.sqlite`, `-shm`, `-wal`) at the given `DATABASE_PATH`, seeds a default Space "Everyday" and Dot "Dot", and shuts down cleanly on SIGTERM. No `data/` directory was created in the repo. `platform.start()` makes no outbound calls without an Intelligence key (Channels only initialize behind the handler) and `DO_NOT_TRACK=1` disables telemetry. The processes were stopped; ports 4398/4399 are free and no server processes remain.

Endpoint behavior observed (identical in both modes unless noted):

| Request                                       | Status         | Body                                                                                                                                                                                                  |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/state`                              | 200            | `{"settings":{…},"tasks":[],"memories":[],"mode":"live","configured":<see table>}`                                                                                                                    |
| `GET /api/workspace`                          | 200            | spaces, dots, conversations, **`setup`** (the setup-status object above), calls                                                                                                                       |
| `GET /api/health`, `GET /healthz`             | 404 / 200 html | **There is no health endpoint upstream.** `/api/*` unknown -> `{"error":"Not found."}`; non-API unknown paths -> SPA fallback `index.html` (so `/healthz` returning 200 HTML is NOT a health signal). |
| `GET /` and `/index.html`                     | 200            | built SPA; CSP `connect-src 'self' wss://realtime.intelligence.copilotkit.ai`, `frame-ancestors 'none'`, nosniff, no-referrer                                                                         |
| `GET /api/copilotkit`, `POST /api/copilotkit` | 503            | `{"error":"Setup required: INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY)."}` (platform.handle without a handler)                                                                                 |
| `POST /api/conversations` (json)              | 503            | `Setup required: <missing list>. ` (requireReady)                                                                                                                                                     |
| `POST /api/tasks` (json)                      | 503            | same `Setup required` list                                                                                                                                                                            |
| `POST /api/conversations` without JSON        | 415            | `{"error":"Use application/json."}`                                                                                                                                                                   |

Where the state comes from: `src/server/platform-config.ts::setupStatus()` computes `missing` from `intelligenceKey`, `apiKey`, `model`; `Platform.requireReady()` throws `Setup required: … Conversations require CopilotKit Intelligence.`; `src/server/app.ts` maps that to 503 on write routes; the client reads `GET /api/workspace .setup` to render the setup state. `research.ts::configured()` (used by `/api/state`) only needs `OPENAI_API_KEY` + `OPENAI_MODEL` (+ parallel/browser provider), not Intelligence — hence `configured:true` in `env` mode while conversations stay blocked.

## Key facts for later engineers

1. **Upstream is green**: typecheck, lint, test (54/344), build all pass on Node 25.8.0; `check-format` fails only because of NemoDots-added Markdown under `docs/nemodots/` (prettier's `docs` glob includes it). Either run `npx prettier --write docs/nemodots` on every new doc (BUILD/TEST prompts included, if the integrator agrees) or add `docs/nemodots/**` to `.prettierignore`; otherwise upstream gate 6 stays red.
2. **No health endpoint exists**; `GET /api/*` unknown returns 404 JSON, any other unknown path returns the SPA. NemoDots must add its own explicit health/readiness routes (checkout sandbox and mission control) and must not treat a 200 HTML as health.
3. **Setup state without Intelligence is fully usable for read-only work** and honest: `GET /api/workspace .setup.missing` names what is absent; every conversation/task write returns 503 `Setup required`. Mission control must be reachable and functional in exactly this state (LEAD_NOTES: Intelligence BLOCKED).
4. **`.env` loading is explicit**: only `npm run dev`, `npm start`, `browser`, `browser:start` pass `--env-file-if-exists=.env`; `node dist/...` directly and vitest do not. Process env wins over `.env` for the same name (Node semantics), which is how the boot test overrode `PORT`/`DATABASE_PATH`.
5. **Ports**: app 4310, Vite 5173 (strictPort, proxies `/api` -> 127.0.0.1:4310), browser service 4311. All free on this machine, as are NemoDots' 55432/56379/4510. External `HOST` binding requires a 24+ char `OWNER_TOKEN` or the server throws at start.
6. **SQLite is `node:sqlite` (`DatabaseSync`)**, WAL mode, no native npm module; `DATABASE_PATH` default `data/opendots.sqlite` (gitignored `data/`, `*.sqlite*`). Store and WorkspaceStore both open the same file.
7. **Tests are in-process Hono + `:memory:` SQLite, node environment, no jsdom, no network, no Playwright.** New NemoDots unit tests should follow this pattern and keep the default `npm test` network-free; DB/Redis/live-Crusoe/Playwright suites need their own explicit commands and modes.
8. **Playwright**: runtime dep only (browser service). No `@playwright/test`; UI e2e is greenfield for NemoDots.
9. **`npm ci` can fail transiently on a cold cache** (tarball corruption retries + ENOENT chdir). Retry once; the warm-cache install takes ~8 s and 972 MB.
10. **Pre-existing warnings** (Vite config-loader extension warning, >500 kB chunks) are baseline; do not report them as NemoDots regressions.

## Blockers

- None for the baseline itself. Upstream gates PASS except `check-format`, whose only failures are NemoDots-added docs (owner: integrator/lead decides formatting vs. ignore; see fact 1).
- Carried from LEAD_NOTES, not re-tested here: CopilotKit Intelligence unavailable (conversation persistence BLOCKED); no Docker daemon (Docker-based gates BLOCKED).

## Files produced by this audit

- `docs/nemodots/audit/BASELINE.md` (this report).
- `.local/baseline/{npm-ci,npm-ci-retry,typecheck,lint,test,build,check-format}.log`, `.local/baseline/boot.sh`, `.local/baseline/boot-clean/`, `.local/baseline/boot-env/` (server logs, response bodies, headers, SQLite files). `.local/baseline/boot-clean.sh` is a first, buggy draft of the boot script (ready-check matched curl's `000`), kept for honesty; its results were discarded.
