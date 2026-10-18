# NemoDots source and decision ledger

Prepared 18 October 2026. Source inspection and documentation research inform this build kit; the NemoDots application has not yet been implemented or live-verified.

## Product and naming

**NemoDots** connects NVIDIA Nemotron with the OpenDots specialist workspace. Tagline: **When evidence changes, the team adapts.** Describe it as an independent project built on OpenDots using NVIDIA Nemotron through Crusoe Managed Inference. A brief search found no exact NemoDots GitHub repository match; this is a working name, not a trademark/domain clearance claim. Avoid NemoRelay: NVIDIA already maintains [NeMo Relay](https://github.com/NVIDIA/NeMo-Relay).

The differentiating experiment is operational provenance and selective repair under changing evidence, not generic shared chat, a new foundation model, or a claim to invent memory transactions.

## Authoritative public documentation

| Source | What it establishes | Application to this prompt |
| --- | --- | --- |
| [Recursive Agents Hackathon](https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon) | Goal-driven teams, delegation, memory, progress checks, recovery; Crusoe inference and Nemotron | Build actual autonomous planning and recovery. No verified numeric judging rubric or guaranteed prize. |
| [Crusoe quickstart](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/) | OpenAI-compatible endpoint and Foundry key | Endpoint is `https://api.inference.crusoecloud.com/v1`; do not copy the old example's deprecated model. |
| [Crusoe available models](https://docs.crusoecloud.com/serverless-inference/available-models/) | Current model IDs | Core `nvidia/Nemotron-3-Super-120B-A12B`; optional evaluated Nano. Account access and actual tool calls still need smoke tests. |
| [Crusoe inference metrics](https://docs.crusoecloud.com/serverless-inference/inference-metrics/) | Project/model aggregate requests, tokens, cached input, latency; one-minute updates; monitoring API | Client traces supply per-run evidence; aggregate metrics corroborate. Separate inference/monitoring credentials. |
| [MemoryAlloy technical article](https://www.crusoe.ai/resources/blog/crusoe-memoryalloy-reinventing-kv-caching-for-cluster-scale-inference) | Distributed KV caching and cache-aware routing | Design reusable compatible prefixes and measure our workload. The article's speedups are not NemoDots results or semantic memory guarantees. |
| [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview) | Exact requested model ID `claude-opus-5` | Lead and critical reviews. Preserve user's exact selection even if a newer model exists. |
| [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) | Exact requested model ID `claude-sonnet-5-5` | Implementation and dependency roles. Verify actual per-role model after spawn. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | Interactive native teams, experimental enablement, definition reuse and limitations | Enable with env flag, actual named teammates/shared tasks. Plan requests are not independent review. |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | `.claude/agents` frontmatter, full model IDs and tool definitions | Eleven role files are provided; fallback is explicitly labeled subagents. |
| [Claude Code model configuration](https://code.claude.com/docs/en/model-config) | Effective-model precedence, overrides and model checks | Verify requested vs actual; do not silently change user overrides. |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Explicit success criteria, exploration, verification, fresh reviews | Frozen independent oracle; build and verify rather than stop at a plan. |
| [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html) | Lock lifetimes and transaction behavior | Short shared-authority commit transaction; no model/network wait under lock. |
| [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html) | Queue-oriented uses and limitations of SKIP LOCKED | Queue claiming is not evidence consistency. |
| [Redis XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/) | Pending-message ownership/redelivery | PostgreSQL leases and idempotency remain authoritative. |

Claude docs were read by an independent reviewer through Firecrawl. Crusoe/event pages were freshly fetched; local cache under the outer repository's `.firecrawl/nemodots/`. Installed CLI was inspected without sending a Claude API request: version **2.1.302**. Exact model IDs are documented; this preparation did not authenticate live model access or run a native team.

## Actual starter execution paths

OpenDots commit: `ab39f2508f3fd23a949837622456f3d61a108e9a`.

- [package.json](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/package.json): Node >=24, npm scripts and lockfile. Keep existing stack and tests.
- [README](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/README.md), [setup](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/docs/SETUP.md), [.env.example](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/.env.example): separate Intelligence conversation dependency, stable owner identity, configured model endpoint. Do not run generic onboarding over this template.
- [DotAgent](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/dot-agent.ts#L332): compatible Chat Completions adapter; role/content/time mixed early in prompt; multiple tool families assembled separately. Context compiler and full lineage are new work.
- [ComputerService.action](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/computer-service.ts#L324): real validation, permissions, audit and revocation seam; no built-in operational fact semantics.
- [ConnectionService](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/connections.ts#L281), [approval routes](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/connection-routes.ts#L110), [Composio tools](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/composio-tools.ts): separate execution and delayed approval paths must be gated if enabled.
- [Page writes](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/pages.ts#L202): SQLite document revision protection, not downstream fact invalidation.
- [Runner](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/runner.ts): existing background scheduling needs a new concurrent leased coordinator.
- [Computer setup](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/docs/COMPUTERS.md), [pinned service build](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/deployment/computers/README.md): reuse only optional OpenBot computer/supervisor services, preserving pin `b6932d31a8d6e7896c15139dfc27a6c6911deb27` and HMAC hardening.
- [MIT license](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/LICENSE): retain notice and attribution.

OpenBot reference checkout HEAD: `12c3a69406b2ca32bcb117c0329c9c6d9359565d`. This is a source reference, not permission to replace the supported service build pin or adopt the entire OpenBot application.

## Close research and limits from the earlier full-folder review

- [MemTX](https://arxiv.org/html/2607.23929): transactional shared memory, gates and repair are close prior art. Inspect exact action-input binding and provenance assumptions rather than claiming these ideas do not exist.
- [CoAgent](https://arxiv.org/abs/2606.15376): coordination, declared footprints, notifications and selective incident repair are close prior art. Compare with a strong dependent-task restart strategy.
- [Dependency rollback](https://arxiv.org/abs/2608.10502): dependent rollback and independent support preservation; source diagnosis and external reversibility have boundaries.
- [Graphiti documentation](https://help.getzep.com/graphiti/getting-started/overview): temporal/provenance memory is an existing capability. A weak vector-store-only baseline is insufficient.
- [Self-authored verification](https://arxiv.org/abs/2607.24300), [verifier validity](https://arxiv.org/abs/2610.11464): independent protected acceptance matters; another LLM's agreement cannot manufacture ground truth.

These research observations were method/limitations audits of relevant passages and saved sources, not a claim that every linked PDF was read cover to cover. The outer repository retains the original research guides and `.firecrawl` corpus.

## Guarantees we must earn

Supported controlled PostgreSQL configuration commits can validate a complete relevant version vector atomically under a common authority. Redis/API adoption remains eventual and independently verified. Unknown remote effects remain unknown until reconciled. Receipt lineage is conservative provenance, not perfect semantic causality. Unobserved world changes and arbitrary shell effects are outside the strong guarantee. Baseline results and cache speedups are measurements to obtain, not statements to prefill.
