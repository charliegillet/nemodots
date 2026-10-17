# Crusoe Managed Inference smoke (Phase 0, pre-build)

- Auditor: Phase 0 auditor (crusoe), Claude Code workflow subagent (Fable 5.1), 2026-10-17.
- Endpoint: `https://api.inference.crusoecloud.com/v1`. Configured runtime model: `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`.
- Mode: **LIVE**. Every number below comes from real HTTP calls made today by `.local/smoke/crusoe-smoke.mjs` (plain Node 25 `fetch`, no SDK, no mocks). Two full runs: 20:08Z (run 1, values quoted from stdout) and 20:12Z (run 2, persisted in `.local/smoke/results/`).
- Concurrency: sequential, except item 7b which deliberately held exactly 2 requests in flight (`max_in_flight_observed: 2`). A guard throws above 2.
- Secrets: the key was read inside the Node process from `NemoDots/.env`; a post-run scan confirmed it does not appear in any file under `.local/smoke/results/` (`secret leak in results: false`). It is not printed in this report.

## Setup

| Item | Status | Evidence |
|---|---|---|
| `NemoDots/.env` created from `.env.example` structure with `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` (mapped from worktree-root `CRUSOE_API_KEY`), Intelligence keys left empty, mode 0600 | PASS | `.local/smoke/write-env.mjs` (never echoes the value; prints only `key_present: true`). Ignored by both `NemoDots/.gitignore` (`.env`) and worktree-root `.gitignore` (`.env`, `.local/`). |

Note: I ran one read-only `git check-ignore` to confirm ignore status before remembering the no-git rule; nothing was staged, committed or changed. Integrator can re-confirm with `git status --ignored` if wanted.

## Results (per item)

| # | Item | Status | Key measurements |
|---|---|---|---|
| 1 | `GET /v1/models` | PASS | HTTP 200, 13 models, 5 Nemotron IDs (below); configured model present. |
| 2a | Text completion, reasoning off (`reasoning_effort: "none"`) | PASS | Returned model `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` (== requested). Content `pong`, `finish_reason=stop`, 30 in / 3 out tokens. Latency 457 ms (run 1), 3261 ms (run 2). |
| 2b | Text completion, default reasoning, `max_tokens: 40` | PASS (behavior recorded; see quirk) | Run 1: `content: null`, `finish_reason=length`, 161 chars in `message.reasoning`, all 40 completion tokens spent on reasoning. Run 2: `content: "\n\npong"`, `finish_reason=stop`, 90 reasoning chars, 29 tokens. The empty-content failure is real but **non-deterministic**; the reasoning text comes back in `message.reasoning` (not `reasoning_content`). |
| 3a | Typed read-only tool call (`get_order(order_id)`, `tool_choice: "auto"`, reasoning off) | PASS | `finish_reason=tool_calls`, id `chatcmpl-tool-…`, `arguments` is a JSON string `{"order_id": "ord_4711"}`, parsed and type-checked. 337 in / 30 out. 1129 ms / 3698 ms. |
| 3b | Tool-result continuation (assistant msg with `tool_calls` + `role:"tool"` msg) | PASS | Final answer `The status of order ord_4711 is payment_failed.`, no extra tool calls, `finish_reason=stop`. 421 in / 16 out. 842 ms / 4133 ms. |
| 4a | Structured output `response_format: {type: "json_object"}` | PASS | Valid JSON `{"severity":"high","component":"checkout"}` (run 2: `"Checkout"`), parsed and validated client-side. 1642 ms / 2220 ms. |
| 4b | Structured output `json_schema` with `strict: true` (enum + number bounds + `additionalProperties:false`) | PASS | `{"severity":"high","component":"checkout","confidence":0.95}`, exactly the 3 required keys. 1110 ms / 3186 ms. |
| 5a | Streaming (`stream: true`, `stream_options.include_usage`) with time to first **non-empty content** delta | PASS | Headers at 316 ms / 1178 ms; first non-empty content at **320 ms (run 1) / 1584 ms (run 2)**; 216-218 chunks, ~215 content deltas, `finish_reason=stop`; final chunk carried `usage` (30 in / 214-216 out, `prompt_tokens_details.cached_tokens: 0`). Total 3536 / 3948 ms. |
| 5b | Client-side cancellation (AbortController after 5 content deltas) | PASS | Aborted at 764 ms / 816 ms wall after 6 chunks; no `finish_reason`, no `usage` chunk received (as expected when the client cancels). Server-side billing of the cancelled remainder is **unknown** (no receipt is returned; console usage would be the only check). |
| 6 | Usage incl. `cached_tokens` (identical ~5.3k-token system prefix, two different user questions) | PASS (available) | `usage.prompt_tokens_details.cached_tokens` is present on Super. Run 1: call 1 `cached_tokens: 0`, call 2 `cached_tokens: 4608` of 5336 prompt tokens (3218 ms -> 866 ms). Run 2 (~4 min later): both calls `4608` (cache persisted across runs). `multimodal_tokens: null`. Answers correct (`120`, `1`). |
| 7a | Provider error shape (unknown model) | PASS | HTTP **404** `{"code":"model_not_found","message":"Model not found: nvidia/does-not-exist","error_id":"…"}`. Error body uses `code`/`message`/`error_id`, not OpenAI's `error.{type,code}` envelope. |
| 7b | Two requests in flight simultaneously | PASS | Both 200, no 429, no retries (749/1572 ms; 272/518 ms). |
| — | Rate-limit headers | observed ABSENT | No `x-ratelimit-*` or `retry-after` header on any response (only Cloudflare headers, `server: cloudflare`). Throttle client-side. |
| — | 429/503 backoff path | NOT_RUN | No 429/503 occurred in either run (18 requests, mostly sequential). The retry branch in the script (jittered 1s/2s/4s, cap 30s, 3 retries) exists but was not exercised live. Prior research hit `429 max_requests_limit (orchestrator)` with 6 parallel requests. |

Overall: **PASS** for all requested items. No BLOCKED items. Approximate spend for both runs: < $0.02 (about 24k prompt tokens, mostly the cache test, and < 1.5k completion tokens).

## Exact Nemotron model IDs (live `GET /v1/models`, 2026-10-17 20:12Z)

Case-sensitive; copy exactly. All report `context_length: 262144`, `is_billed_by_token`, and `top_provider.max_completion_tokens: 262144` (Lightning: 262143). Prices are USD per 1M tokens as strings in `pricing`.

| id | prompt | completion | `input_cache_reads` | tags |
|---|---|---|---|---|
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 0.30 | 2.40 | 0.15 | text to text |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.05 | 0.20 | 0.03 | text to text |
| `nvidia/Nemotron-3.5-Lightning-30B-A3B` | 0.05 | 0.20 | 0.03 | text to text |
| `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | 0.30 | 1.83 | 0.30 (no cache discount) | text to text, image text to text |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | 0.10 | 0.40 | 0.08 | text to text, image text to text, tool calling |

Other live IDs (not Nemotron, do not use for the runtime): `deepseek-ai/DeepSeek-V4-Pro`, `deepseek-ai/DeepSeek-V4.1-Flash`, `deepseek-ai/Deepseek-V4-Flash`, `zai-org/GLM-5.3`, `zai-org/GLM-5.3-Flash`, `Qwen/Qwen3.8-27B`, `openai/gpt-oss-120b`, `google/gemma-4-31b-it`. No Nemotron Ultra. BUILD_PROMPT's `nvidia/Nemotron-3-Super-120B-A12B` (without `NVIDIA-`) does **not** exist; LEAD_NOTES is right.

`supported_parameters` on all Nemotron records include: `tools`, `tool_choice`, `parallel_tool_calls`, `max_tool_calls`, `response_format`, `structured_outputs`, `chat_template_kwargs`, `reasoning`, `reasoning_effort`, `thinking`, `seed`, `prompt_cache_key`, `cache_salt`, `max_completion_tokens`, `logprobs`, `top_logprobs`, `stop`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, plus Responses-API-style names (`instructions`, `previous_response_id`, `conversation`, `background`, `store`, `metadata`, `service_tier`, `truncation`). Full records: `.local/smoke/results/models.json`.

## Facts the adapter and runtime engineers must build on

1. **Model ID**: `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`; the response `model` field echoes it exactly, so "requested == returned" can be asserted in telemetry.
2. **Reasoning is on by default** and is returned in `message.reasoning` (chat) / `delta.reasoning` (stream). With small `max_tokens` the model may spend the whole budget reasoning and return `content: null` + `finish_reason: "length"` (seen in run 1, not in run 2). For tool loops and structured output use `reasoning_effort: "none"` (verified here; `chat_template_kwargs: {enable_thinking: false}` is the documented equivalent). When reasoning is wanted, give `max_tokens >= 1024` and persist `message.reasoning` separately from `content`.
3. **Tool calling**: OpenAI `tools` + `tool_choice: "auto"` works; `arguments` is a JSON string to parse and validate; tool-call ids look like `chatcmpl-tool-<hex>`. The continuation must include the assistant message carrying `tool_calls` before the `role: "tool"` message. Avoid `tool_choice: "required"` (prior research: 500 on Lightning, duplicate-call loop on Super).
4. **Structured output**: both `json_object` and strict `json_schema` returned schema-conforming JSON with reasoning off. Still validate client-side (the `json_object` run capitalised `component` differently between runs; temperature 0 is not deterministic).
5. **Streaming**: standard SSE `data:` lines, `[DONE]` terminator, `usage` only in the final chunk when `stream_options.include_usage` is set. Measure TTFT on the first **non-empty** `delta.content` (reasoning deltas may precede it when reasoning is on). AbortController cancellation works immediately; after cancel there is no usage receipt, so cancelled attempts must be recorded with `tokens: null`, not 0.
6. **Usage**: `usage.prompt_tokens_details.cached_tokens` **is reported on Super** (0 on cold, 4608/5336 on a warm identical prefix; block granularity looks like 256 tokens; the cache survived at least ~4 minutes). `multimodal_tokens` is null. Per LEAD_NOTES, Lightning/Omni return `prompt_tokens_details: null`: record as unavailable, never as 0. Cost formula: `prompt*p_in + cached*(p_cached - p_in) + completion*p_out` using `/v1/models` pricing.
7. **Latency envelope (Super, reasoning off)**: small completions 0.3–3.7 s; headers 0.3–1.2 s; a 5.3k-token cold prompt 3.2 s vs 0.6–0.9 s warm. Latency varied ~3–7x between the two runs minutes apart; budget timeouts generously (>= 60 s for planner turns) and treat timing as per-attempt telemetry, not a stable SLO.
8. **No rate-limit headers.** Keep <= 4 in flight per model (this audit used <= 2), add jittered exponential backoff on 429/503 and distinguish "retry inference" from "retry a mutating tool" (never automatic for the latter).
9. **Error envelope** is Crusoe-specific: `{"code": "...", "message": "...", "error_id": "..."}` with the HTTP status carrying the class (404 `model_not_found`). Do not assume OpenAI's `{"error": {...}}` shape when classifying provider errors; handle both.
10. **Credentials**: `NemoDots/.env` now carries the live key as `OPENAI_API_KEY` (gitignored twice). Server-side only; the OpenDots adapter already reads `OPENAI_*`, so no new env names are needed. Intelligence keys are empty on purpose (BLOCKED per LEAD_NOTES).

## Blockers and gaps

- None blocking for the Crusoe path. Items not exercised live today: 429/503 retry behaviour (no limit was hit at <= 2 in flight), cheaper Nemotron profiles (only Super was called; Lightning/Nano claims come from prior research in `.references/research/crusoe.md`), and billing of cancelled streams.
- Not part of this audit: the smoke was run with a standalone script, not through OpenDots' adapter. Gate 5 requires repeating items 2–5 through the app's real adapter once it exists (Phase 1 provider smoke suite).

## Artifacts

- `/Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots/.local/smoke/write-env.mjs` — env writer (no echo).
- `/Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots/.local/smoke/crusoe-smoke.mjs` — the smoke script (re-runnable: `cd NemoDots && node .local/smoke/crusoe-smoke.mjs`).
- `/Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots/.local/smoke/results/models.json` — raw `/v1/models` response.
- `/Users/charlie/hackathons/crusoe-hackathon-nemodots/NemoDots/.local/smoke/results/smoke-results.json`, `run.log` — run 2 per-item records (run 1 values are quoted above from its stdout; its log was overwritten by run 2).
- No processes were left running; the script exits after writing results.
