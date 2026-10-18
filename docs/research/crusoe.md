# Crusoe Managed Inference: research notes for Ratchet

Compiled 2026-10-17 ~12:45 PDT from docs.crusoecloud.com, crusoe.ai blog posts, the Crusoe developer-hub repo, and live probes against the API (key loaded from `.env`, never printed). Everything in the "Empirical" sections was observed today; everything else cites its source.

## TL;DR for the build

| Decision | Setting | Why |
|---|---|---|
| Base URL | `https://api.inference.crusoecloud.com/v1` (`CRUSOE_BASE_URL`) | Only current host; old hosts 404/429 |
| Worker model | `nvidia/Nemotron-3.5-Lightning-30B-A3B` | $0.05 in / $0.20 out / $0.03 cached per 1M; tool calling works |
| Reviewer model | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | $0.30 / $2.40 / $0.15; strongest Nemotron here; JSON mode works; reports `cached_tokens` |
| Bug-planter model | `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | $0.30 / $1.83 / cached $0.30 (no cache discount); tool calling works |
| Turn reasoning OFF | `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` **or** `reasoning_effort="none"` | Both verified on all three models. Nothing else works (see below) |
| Reasoning ON | leave default, give `max_tokens >= 1024`; read `message.reasoning` | Default is thinking ON for all three; a small `max_tokens` is spent entirely on reasoning and `content` is empty with `finish_reason="length"` |
| Concurrency | <= 4 in-flight requests per model, jittered exponential backoff on 429/503 | 6 parallel tiny requests -> 1 x `429 max_requests_limit (orchestrator)` even at trivial RPM |
| Cost tracking | `usage.prompt_tokens`, `usage.completion_tokens`, `usage.prompt_tokens_details.cached_tokens` (Super only; `null` on Lightning/Omni) | Multiply by the `/v1/models` `pricing` fields |
| Prefix caching | Put playbook + tool schema first, byte-identical; vary only the tail | MemoryAlloy cache-aware routing; Super showed 2304/2330 cached on the 2nd identical-prefix call |
| Rate-limit headers | Do **not** rely on them | Docs promise `x-ratelimit-*` headers; live responses carry none (Cloudflare headers only) |
| `tool_choice="required"` | Avoid | 500 on Lightning; Super looped emitting the same tool call until `max_tokens` |
| Skill file | installed at `.claude/skills/crusoe-recursive-agents-hackathon/SKILL.md` | Official Crusoe hackathon skill (see Section 7) |

## 1. Product map (docs.crusoecloud.com)

- **Intelligence Foundry** = the managed layer. **Managed Inference** has three flavors: Serverless Inference (per-token, shared, rate-limited: what we use), Self-Serve Deployments (dedicated GPUs, GPU-hour billing, no rate limits, supports LoRA adapters), Tailored Deployments (contact sales). **Serverless Fine-Tuning** does LoRA SFT from JSONL/Parquet (<= 3 GB) and deploys the checkpoint only to a Self-Serve Deployment. Serverless Inference serves base models only (no fine-tunes). Sources: https://docs.crusoecloud.com/serverless-inference/overview , https://docs.crusoecloud.com/self-serve-deployments/overview , https://docs.crusoecloud.com/serverless-fine-tuning/overview
- Serverless runs on Crusoe's own engine with **MemoryAlloy**: a cluster-wide KV-cache fabric (Rust, peer-to-peer across nodes, multi-rail RDMA) plus a KV-aware gateway that routes each request to the engine holding the most of its prefix and estimates TTFT per candidate. Blog claims 9.9x TTFT and 5x throughput vs vLLM multi-node. Practical implication: identical prefixes across many requests hit cache even across nodes, so stable playbook/system prompt + tool schema first, variable task last. Source: https://www.crusoe.ai/resources/blog/crusoe-memoryalloy-reinventing-kv-caching-for-cluster-scale-inference (local copy in `docs/research/raw/`).
- **Billing**: per 1M input / output / cached-input tokens; $5 free credits; hackathon credits need the form in the hackathon README plus a card on file. Usage page: https://console.crusoecloud.com/foundry/usage . Pricing: https://www.crusoe.ai/cloud/pricing

## 2. Rate limits (docs + observed)

Docs (https://docs.crusoecloud.com/serverless-inference/rate-limits): per project **per model**, TPM and RPM, reset each minute. No payment method: **500,000 TPM / 30 RPM** per model. Payment method on file: 2,000,000 TPM / 600 RPM. `429` = you exceeded TPM/RPM; `503` = shared endpoint under load; both transient, retry with 1s -> 2s -> 4s ... jittered, cap 30-60s.

Observed today:
- Rapid sequential calls (about 1 per 2 s) to Lightning produced `429 {"type":"rate_limit_error","message":"Too many requests. Reason: max_requests_limit (orchestrator)"}` on the 2nd call of a burst. A 2 s pacing with retry/backoff then ran cleanly for ~25 calls per model.
- 6 simultaneous tiny requests to Lightning: 5 x 200 (about 0.5 s each), 1 x 429. So treat the effective in-flight cap as ~4-5 per model and serialize beyond that.
- **No `x-ratelimit-*` headers** came back on any response (only `Server: cloudflare`, `CF-RAY`, `cf-cache-status`), contrary to the docs and the skill file. Throttle client-side by counting.
- Limits are per model: spreading worker / reviewer / planter across three different Nemotron IDs triples our aggregate RPM.

Design rule for Ratchet: a single `CrusoeClient` with a per-model semaphore (4), retry on 429/503 with jitter, and a global token/cost ledger keyed by playbook version.

## 3. Models (live `GET /v1/models`, 2026-10-17)

Live IDs (case-sensitive, copy exactly; the docs table spells several differently):

| ID | Context (`/v1/models`) | Price in/out/cached per 1M | Notes |
|---|---|---|---|
| `nvidia/Nemotron-3.5-Lightning-30B-A3B` | 262,144 (docs/pricing page say 1M) | $0.05 / $0.20 / $0.03 | hybrid Mamba-2/MoE, 3B active, "sub-agent workhorse"; extra params `verbosity`, `min_tokens`, `chat_template` |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 262,144 | $0.30 / $2.40 / $0.15 | 12B active; agentic/tool-use/RAG |
| `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | 262,144 | $0.30 / $1.83 / $0.30 | multimodal (image/video/audio in), text out |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262,144 | $0.05 / $0.20 / $0.03 | cheap text, same price as Lightning |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | 262,144 | $0.10 / $0.40 / $0.08 | multimodal, tagged `tool calling` |

Other live IDs: `Qwen/Qwen3.8-27B`, `deepseek-ai/DeepSeek-V4-Pro`, `deepseek-ai/DeepSeek-V4.1-Flash`, `deepseek-ai/Deepseek-V4-Flash` (lowercase s), `google/gemma-4-31b-it`, `openai/gpt-oss-120b`, `zai-org/GLM-5.3`, `zai-org/GLM-5.3-Flash`. Nemotron 3 Ultra is **not** in this project's list.

All five Nemotron records advertise `supported_parameters` including `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `structured_outputs`, `chat_template_kwargs`, `reasoning`, `reasoning_effort`, `thinking`, `seed`, `prompt_cache_key`, `cache_salt`, `max_completion_tokens`, `logprobs`; `top_provider.max_completion_tokens` = 262,144 (Lightning 262,143).

Deprecated (do not use): Llama 3.3 70B, DeepSeek V3, Qwen3 235B, GLM-5.1/5.2 (Sept 12 2026), Kimi K2.6 (Oct 2 2026). Many Crusoe examples (quickstart, dev-hub README, Cursor README) still show these.

## 4. Empirical: reasoning control (the `max_tokens` gotcha)

Probe: `{"role":"user","content":"Reply with exactly the word: pong"}`, `max_tokens=40`. Default behaviour on **all three** models: `finish_reason="length"`, `content=""`, ~145-170 chars in `message.reasoning`, all 40 completion tokens burned on reasoning. The reasoning text is returned in `message.reasoning` (not `reasoning_content`); read both defensively via `message.model_dump()`.

| Variant | Lightning | Super | Omni |
|---|---|---|---|
| `chat_template_kwargs={"enable_thinking": false}` | **works** (`pong`, 3 tokens, reasoning_len 0) | **works** | **works** |
| `reasoning_effort="none"` | **works** | **works** | **works** |
| `chat_template_kwargs={"thinking": false}` | no effect | no effect | no effect |
| `reasoning_effort="low"` | no effect (still length) | shorter reasoning (119 chars) then answered | no effect |
| system `/no_think` | no effect | shorter reasoning, answered | reasoning 5 chars, empty content (broken) |
| system `detailed thinking off` | no effect | no effect | no effect |
| system `/think off` | no effect | mostly no effect | no effect |

Extras from the NVIDIA model cards, verified: `chat_template_kwargs={"enable_thinking": true, "low_effort": true}` on Super gives a short reasoning trace (33 chars) and a correct answer in 14 tokens; `{"enable_thinking": false, "force_nonempty_content": true}` is accepted on Super and Lightning (cards suggest it for coding agents).

With the OpenAI Python SDK, pass these via `extra_body={"chat_template_kwargs": {...}}`; `reasoning_effort` is a first-class SDK kwarg.

Recommendation: workers run with `enable_thinking: False` for cheap deterministic tool loops (or ON with `max_tokens >= 2048` for an A/B); reviewer runs with thinking ON, `max_tokens` 4096-8192, since diagnosis benefits from it; bug planter thinking OFF with JSON output.

## 5. Empirical: tool calling

OpenAI `tools` param with one `run_python(code)` function, system + user message, no `tool_choice`:

| Model | thinking default | thinking off | second turn (tool result appended) | `tool_choice="required"` + thinking off |
|---|---|---|---|---|
| Lightning | tool_call emitted, 145 completion tokens (369-char reasoning), `finish_reason="tool_calls"`, ids `call_...` | tool_call, 31 tokens | correct final answer (`391`) | **HTTP 500** `server_error` |
| Super | tool_call, 54 tokens, ids `chatcmpl-tool-...` | tool_call, 32 tokens | correct | emitted 11 duplicate tool calls until `max_tokens` (`finish_reason="length"`) |
| Omni | tool_call, 171 tokens (598-char reasoning) | tool_call, 30 tokens | correct (`391`) | works (1 call) |

Notes: arguments come back as a JSON string (`{"code": "print(17*23)"}`); Lightning sometimes puts `"\n\n"` in `content` alongside tool calls; always append the assistant message (with `tool_calls`) before the `role: "tool"` messages or you get a 400 about ordering. Use `tool_choice="auto"` (default) and validate arguments.

Structured output: `response_format={"type":"json_object"}` on Super and strict `json_schema` on Lightning both returned valid JSON matching the schema with thinking off. Streaming with `stream_options.include_usage` works (final chunk carries `usage`).

## 6. Empirical: cached tokens in `usage`

- **Super** returns `usage.prompt_tokens_details = {"cached_tokens": N, "multimodal_tokens": null}`. With a ~2,300-token identical system prefix and a varying 1-line user message: call 1 `cached_tokens=0`, calls 2 and 3 `cached_tokens=2304` of 2330 prompt tokens (block granularity looks like 256 tokens).
- **Lightning** and **Omni** return `prompt_tokens_details: null` on every call, including repeated identical 2,300-token prefixes. So per-request cache proof is only available for Super; for the others, infer from TTFT or the console metrics (`inference_counter_cached_prompt_token`).
- Omni's cached price equals its input price ($0.30), so caching saves latency but not money there. Lightning cached is $0.03 vs $0.05.
- `prompt_cache_key` and `cache_salt` are listed in `supported_parameters` (vLLM-style); untested, optional.

Cost formula per call: `prompt_tokens * p_in + cached_tokens * (p_cached - p_in) + completion_tokens * p_out`, with prices from `/v1/models` `pricing` (strings, USD per 1M). Record per playbook version for the scoreboard.

## 7. The Crusoe hackathon skill file (exact URL)

- Repo path: `examples/hackathons/crusoe-cv-recursive-agents-hackathon/crusoe-cv-recursive-agents-hackathon-skill.md` in https://github.com/crusoecloud/crusoe-developer-hub
- Blob URL: https://github.com/crusoecloud/crusoe-developer-hub/blob/main/examples/hackathons/crusoe-cv-recursive-agents-hackathon/crusoe-cv-recursive-agents-hackathon-skill.md
- Raw URL: https://raw.githubusercontent.com/crusoecloud/crusoe-developer-hub/main/examples/hackathons/crusoe-cv-recursive-agents-hackathon/crusoe-cv-recursive-agents-hackathon-skill.md
- Hackathon README (credits form, key expiry advice): https://github.com/crusoecloud/crusoe-developer-hub/blob/main/examples/hackathons/crusoe-cv-recursive-agents-hackathon/README.md
- Installed locally as a Claude Code project skill: `/Users/charlie/hackathons/crusoe-hackathon/.claude/skills/crusoe-recursive-agents-hackathon/SKILL.md` (46 KB, frontmatter `name: crusoe-recursive-agents-hackathon`). It covers endpoint, model IDs, prices, rate limits, reasoning toggles, image input, tool calling, prefix caching, metrics, troubleshooting, and OpenCode/Pi/OpenClaw wiring. Two places where today's probes disagree with it: (a) it says every response carries `x-ratelimit-*` headers (none observed); (b) it lists Lightning's ID in lowercase `nvidia/nemotron-3.5-lightning-30b-a3b` (API id is `nvidia/Nemotron-3.5-Lightning-30B-A3B`) and Super as `nvidia/Nemotron-3-Super-120B-A12B` (API id has the `NVIDIA-` prefix).

## 8. Metrics / PromQL

Docs: https://docs.crusoecloud.com/serverless-inference/inference-metrics . Console charts at https://console.crusoecloud.com/foundry/metrics update every minute, no setup. Programmatic access needs a **monitoring token** from `crusoe monitoring tokens create` (Crusoe CLI, which needs an access key id + secret from Console > Security, not the inference key), then `GET https://api.cloud.crusoe.ai/v1/projects/<project-id>/metrics/timeseries?query=<PromQL>` with `Authorization: Bearer <token>`. Useful series: `inference_counter_chat_request`, `inference_counter_all_chat_request` (has `status_code`, shows 429s), `inference_counter_prompt_token`, `inference_counter_output_token`, `inference_counter_cached_prompt_token`, `inference_histogram_first_token_latency_bucket`, `inference_histogram_chat_latency_bucket`; labels `project_id`, `model_alias`, `status_code`, `is_streaming`. Prefix-cache hit rate = cached_prompt_token / prompt_token. Blocker: we do not have cloud access keys in `.env`, so the PromQL API is not usable today; track cost from `usage` instead.

## 9. CLI and MCP server

- **Crusoe CLI**: `brew install crusoecloud/cli/crusoe` (official tap, repo https://github.com/crusoecloud/cli). Installed today: `crusoe version v1.0.10` at `/opt/homebrew/bin/crusoe`. `crusoe whoami` fails ("failed to authenticate user") because it needs `CRUSOE_ACCESS_KEY_ID` / `CRUSOE_SECRET_KEY` (Console > Security > API keys) or `crusoe config init`; the inference API key is a different credential. Docs: https://docs.crusoecloud.com/installing-the-cli
- **Crusoe Cloud MCP** (`@crusoeai/cloud-mcp`, npm v0.1.6, source on GitLab `crusoeenergy/island/external/cloud-mcp`): `claude mcp add crusoe-cloud -- npx -y @crusoeai/cloud-mcp`. Read-only infra tools (VMs, disks, VPCs, CMK clusters, quotas, GPU tracking, `get_resource_relationships`, `cluster_health_check`), 60 req/min client-side cap, Preview. Auth via `~/.crusoe/config` (same access key pair). Nothing about inference. Docs: https://docs.crusoecloud.com/reference/mcp-server/ ; blog: https://www.crusoe.ai/resources/blog/introducing-the-crusoe-cloud-mcp-server . Not installed: no cloud credentials, no value for Ratchet today.
- **langchain-crusoe** (PyPI 0.2.2, `ChatCrusoe`, source in dev-hub `integrations/langchain`): first-class LangChain provider with tool calling/structured output. Not needed; the plain `openai` SDK (installed 2.16.0; PyPI latest 3.33.0) is enough.
- Dev-hub `integrations/` also has LiteLLM, MLflow, Google ADK, Postman, HF Spaces, Cursor, Zed, Linkup configs; the Cursor/Zed READMEs just set OpenAI base URL to Crusoe (their model tables are outdated).

## 10. Crusoe blog takeaways relevant to the pitch

- Nemotron 3 Ultra + LangChain Deep Agents post: LangChain improved an agent by **harness engineering** (run evals, have an agent root-cause failures, edit prompts/tool descriptions, repeat until the score converges; the model never changed). Ratchet is exactly this loop with a sealed holdout gate; worth citing in the demo.
- Nano Omni post: Nemotron 3 Nano is positioned for "targeted individual steps in an agentic workflow: simple merge requests, single-step tool calls, classification"; Super for multi-step reasoning. Matches our worker / reviewer split.
- Hermes-agent post: "for agents that fan out parallel tool calls ... cache discipline and tail latency matter"; uses Nano Omni as the cheap auxiliary model.

## 11. Blockers and risks

1. Effective concurrency per model is ~4-5 in-flight; a 15-task x 3-run holdout = 45 worker calls per candidate version, each a multi-turn tool loop. At ~2 s pacing that is a few minutes per gate; budget for it and keep tasks tiny.
2. No rate-limit headers; must self-throttle. 429s even at low volume ("orchestrator" limit).
3. Lightning and Omni do not report `cached_tokens`; the "cached tokens per version" chart will be real only for Super (reviewer) unless we add the console metrics.
4. `/v1/models` says Lightning context is 262k, not the 1M the docs claim; irrelevant for us but do not advertise 1M.
5. `tool_choice="required"` is unsafe (500 on Lightning, loop on Super).
6. Cloud access keys (CLI/MCP/PromQL) are not available; only the inference key is. Reported as a blocker, not a problem for the core demo.
7. Hackathon README says free credits require a credit card on file and the Google form; that also lifts limits to 600 RPM. Someone on the team should check the billing page.

## 12. Probe artifacts

Scripts and raw JSONL results live in the session scratchpad (`probe.py`, `exp_reasoning.py`, `exp_tools_cache.py`, `*_reasoning.jsonl`, `*_tools.jsonl`, `*_cache.jsonl`). They read the key from `.env` and never print it. Each probe used `max_tokens` <= 600; total spend was well under $0.05.
