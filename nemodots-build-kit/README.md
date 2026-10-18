# NemoDots build kit

**NemoDots — When evidence changes, the team adapts.**

An independent project built on OpenDots, using NVIDIA Nemotron through Crusoe Managed Inference. The target product is a persistent incident team whose shared evidence governs its decisions: source changes block stale controlled actions and trigger selective repair while independent valid work continues.

This kit contains the implementation assignment, acceptance/repair assignment, concrete sandbox protocol, verified sources, Claude role definitions, source clones and launcher. **It prepares the build; it does not claim NemoDots has been implemented or live-verified.**

## Read or copy the prompts

| File | Purpose |
| --- | --- |
| [BUILD_PROMPT.md](BUILD_PROMPT.md) | Full implementation assignment: product, eleven roles, contracts, architecture, phased tasks, integration, test gates and final evidence |
| [TEST_PROMPT.md](TEST_PROMPT.md) | Separate independent verification and repair assignment with race, provenance, bypass, live provider, application and UI gates |
| [SANDBOX_SPEC.md](SANDBOX_SPEC.md) | Concrete real Node API/PostgreSQL/Redis failure modes and configuration commit/reconciliation protocol |
| [SOURCES.md](SOURCES.md) | Official docs, pinned code paths, research limits and naming decision |
| [COPYPASTE_PROMPT.md](COPYPASTE_PROMPT.md) | Short instruction for Claude Code to read the full prepared files and execute them |
| [SOURCE_MANIFEST.json](SOURCE_MANIFEST.json) | Exact upstream revisions, service pin, model split and installed asset hashes |

The full build prompt uses explicit XML sections, exact roles/models, source grounding, frozen contracts, staged dependencies, executable acceptance and evidence-based completion. It does not rely on a model name alone to make a large build reliable.

## Launch the prepared build

From the outer research repository:

```bash
python3 nemodots-build-kit/prepare.py
bash nemodots-build-kit/launch-claude.sh
```

The first command is safe to rerun for unchanged installed assets. It refuses to overwrite an unrecognized/user-edited asset and never resets an existing checkout. If a project already has different CLAUDE.md or `.claude/settings.json` files, merge those manually after inspection instead of forcing replacement.

The launcher opens an **interactive** Claude Code session in `NemoDots/`, enables the experimental native-team feature and requests **`claude-opus-5` with high effort**. It uses no permission bypass, automatic model fallback or noninteractive `-p` mode. Claude must verify requested/effective models and actual team support. Team availability and account access are not established by these files alone.

To run independent verification after implementation:

```bash
bash nemodots-build-kit/launch-claude.sh verify
```

Native agent teams are preferred. If the installed/account configuration genuinely cannot create them, the prompt requires an explicitly labeled persistent-subagent fallback with the same role/model split. It does not pretend configuration files alone created a live team.

## Engineering team versus product models

| Work | Model/service |
| --- | --- |
| Lead, architect, independent verifier and three devil's advocates | Claude Opus 5: `claude-opus-5` |
| Five implementation specialists and dependency auditor | Claude Sonnet 5.5: `claude-sonnet-5-5` |
| Finished product's planner, specialists and recovery reasoning | Nemotron Super: `nvidia/Nemotron-3-Super-120B-A12B`, served by Crusoe |

Eleven reusable role files are installed in `NemoDots/.claude/agents/`; the main Claude session is the lead. Dispatch roles in bounded waves, with distinct file ownership and independent oracle/test ownership. Verify actual models after spawning because environment/account policy can change the effective selection.

The application clone is at `NemoDots/` on `codex/nemodots`, starting from OpenDots `ab39f2508f3fd23a949837622456f3d61a108e9a`. Its remote is named `upstream`; no personal remote or publication has been created. OpenBot is cloned read-only by convention at `.references/OpenBot`, reference revision `12c3a69406b2ca32bcb117c0329c9c6d9359565d`. The supported optional OpenBot computer services remain pinned to **`b6932d31a8d6e7896c15139dfc27a6c6911deb27`**, not that reference HEAD.

The outer repository ignores these nested checkouts so they are not accidentally committed as embedded repositories. The canonical build-kit files are in the outer repository; preparation copies prompt/config assets into the application checkout. Editing the installed status document during implementation is expected.

## What implementation must prove

```text
Goal → real Nemotron plan → dynamic team/delegation → source observations
  → changed source/version → stale controlled intent rejected
  → affected branch re-read/replan → independent branch preserved
  → actual application recovery → independent order/data-integrity acceptance
```

The concrete demo uses actual PostgreSQL queries, a real connection pool and Redis cache contracts. Supported authoritative configuration mutations share their transaction boundary with evidence/version authority. API configuration adoption and Redis effects are eventual and require readback. A configuration receipt is not proof the incident is resolved.

Crusoe runs planning, specialist reasoning and repair, with actual provider traces and compatible reusable prefixes. Cache savings, recovery improvements and comparisons must be measured. No speedup, live completion or winning outcome is prefilled.

## External setup the build will need

- Node >=24 and npm, Docker/Compose and usable PostgreSQL/Redis services.
- Claude Code authentication and actual account access to the requested Opus 5/Sonnet 5.5 IDs.
- Crusoe inference credentials and access to the configured Nemotron model.
- A separate CopilotKit Intelligence connection for real OpenDots conversations: hosted project or documented licensed local evaluation. A Crusoe key alone does not configure this service.
- Optional separate Crusoe monitoring token/project ID for aggregate metrics corroboration.

Preparation performed no dependency installation, account login, paid service provisioning, inference calls, deployment or Git push. The prompt instructs Claude to finish independent work when an external dependency is missing and report the remaining live gate as BLOCKED.

## Preparation checks

```bash
python3 nemodots-build-kit/validate.py
bash -n nemodots-build-kit/launch-claude.sh
bash nemodots-build-kit/launch-claude.sh --dry-run
```

These check the generated frontmatter subset, exact requested model split, prompt structure, script syntax and installed asset hashes. They do not prove Claude loaded the roles, created native teammates, accessed a model, or built/tested NemoDots. Use interactive `/agents`, `/status`, `/tasks` and the actual application test gates during execution.
