# NemoDots build-kit preparation report

Prepared 18 October 2026. This report covers the prompt/source preparation, not the future NemoDots application.

| Check | Status | Evidence |
| --- | --- | --- |
| OpenDots clone and source revision | PASS | `NemoDots`, base `ab39f2508f3fd23a949837622456f3d61a108e9a`, branch `codex/nemodots` |
| OpenBot reference and service commit existence | PASS | `.references/OpenBot`, reference `12c3a69406b2ca32bcb117c0329c9c6d9359565d`; supported service pin `b6932d31a8d6e7896c15139dfc27a6c6911deb27` exists |
| Exact requested Claude IDs in current docs | PASS | SOURCES.md links Opus 5/Sonnet 5.5 and current Claude Code docs |
| Independent team/dependency/correctness reviews | PASS | Separate reviewers; concrete corrections incorporated and reviewed again |
| Eleven role definitions and requested model split | PASS | `python3 nemodots-build-kit/validate.py` |
| Prompt tags, fenced blocks, settings and installed hashes | PASS | Same static validator; 17 installed prompt/config assets |
| Shell syntax and launcher dry run | PASS | `bash -n nemodots-build-kit/launch-claude.sh`; `bash nemodots-build-kit/launch-claude.sh --dry-run` |
| Preparation rerun without resetting source | PASS | `python3 nemodots-build-kit/prepare.py` repeated successfully |
| Live Claude authentication, effective model and team creation | NOT_RUN | No Claude model request/session started |
| Application dependency installation/build/test | NOT_RUN | Source inspection only; npm dependencies not installed |
| NemoDots runtime, ledger, sandbox and UI | NOT_RUN | Implementation assignment is supplied in BUILD_PROMPT.md |
| Live Crusoe Nemotron and Intelligence integration | NOT_RUN | No credentials exercised or inference request sent |
| Autonomous recovery and baseline/cache results | NOT_RUN | Must be measured during implementation |

Preparation inspected local Node `v25.2.1`, npm `11.6.2`, Claude Code `2.1.302` and Docker server `28.4.0`. The prompt requires Node >=24 and recommends a documented compatible reproduction setup. The local version inventory does not establish dependency compatibility or live service health.

Important reviewed corrections: complete tool-family/approval coverage; authoritative source epochs govern eligibility before watcher projection; source versions and controlled target share a transaction boundary; asynchronous graph materialization remains safe behind immediate eligibility checks; independent oracle/fixtures frozen before tuning; authoring/dispatch leases separated; serialized concurrent idempotency; expected self-write transitions do not replay committed actions; legitimate checkout deltas are distinguished from data corruption.

No dependency install, live Claude team, Crusoe request, paid service provisioning, deployment, external message or Git push was performed. The optional `agent-reach check-update` CLI command was unavailable locally; GitHub source access and Firecrawl official-document research worked and supplied the required evidence.
