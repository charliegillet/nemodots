# NVIDIA research for Ratchet (Nemotron + NeMo)

Written 2026-10-17 ~12:45 PDT for the Crusoe "Recursive Agents" hackathon. Everything marked **VERIFIED** was tested live against Crusoe Managed Inference from this machine today; everything else comes from the linked NVIDIA docs/model cards.

## TL;DR

1. **Reasoning off is one line and Crusoe honors it (VERIFIED on all 3 Nemotron models):**
   `extra_body={"chat_template_kwargs": {"enable_thinking": False}}`. Without it Lightning spends the whole `max_tokens` budget in `message.reasoning` and `content` is empty/null.
2. **Tool calling works (VERIFIED):** standard OpenAI `tools=[...]` on Lightning and Super 120B returns `finish_reason="tool_calls"` with proper `tool_calls[]`, with thinking on or off.
3. **The ONE NeMo component to integrate: NeMo Evaluator (`pip install "nemo-evaluator[stats]"`, CLI `nel`).** Its BYOB (`@benchmark` + `@scorer`) runs Ratchet's holdout set against Crusoe, and `nel compare BASELINE CANDIDATE --strict --max-drop ...` is *literally Ratchet's gate step*: paired per-task flip analysis (regressions = baseline right, candidate wrong), McNemar significance, CIs, markdown regression report. **VERIFIED end to end today** against Crusoe with a 4-task holdout and two playbook versions (see "Proof" below). Under an hour to wire in.
4. Kickoff-note name decoding: "NeMoPro 3.5" = **Nemotron 3.5** (Lightning 30B-A3B / Super VL 120B); "NeMoSwitch" = **NeMo Switchyard** (agent model router, `pip install nemo-switchyard`); "LoopMock" = **NemoClaw** (NVIDIA Open Agent Safety Platform / OpenShell runtime, open source); "Nimble (50% agentic accuracy gain)" is most likely **Nemotron 3.5 Lightning** itself (NVIDIA's claims: "4x faster output", "30% faster agentic task completion"; coverage of the launch also quotes "50% faster responses" for the Switchyard router). No NVIDIA product named "Nimble" exists.
5. **RTX 5090 prize:** every public source (Cerebral Valley event page, Crusoe tweets, the hackathon guide) only says "$25,000 in cash prizes and an NVIDIA RTX 5090". No published "Best use of NeMo" rubric. Assume judges want a *real* NeMo library in the loop plus Nemotron as the models. NeMo Evaluator + Nemotron workers/reviewer covers both.

---

## 1. Nemotron model cards (the models Ratchet uses)

All are OpenAI-compatible via Crusoe. Model IDs below are the Crusoe IDs verified live in CONTEXT; the HF/NIM names differ slightly (e.g. `NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`).

| Role | Crusoe model ID | Arch | Context | Reasoning default | Notes |
|---|---|---|---|---|---|
| Workers | `nvidia/Nemotron-3.5-Lightning-30B-A3B` | Hybrid Mamba-2 + MoE + attention, 30B total / 3B active, MTP layers, NVFP4 | up to 1M (256K on 1xH100) | **ON** | Released 2026-08-11. Rec. sampling T=1.0, top_p=0.95 (we used 0.2 fine). Langs: EN + code, ES, FR, DE, IT, JA |
| Reviewer | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | LatentMoE Mamba-2 + MoE + attention + MTP, 120B / 12B active, FP8 | up to 1M (Crusoe lists 262K) | **ON** | Released 2026-03-11. "Use temperature=1.0 and top_p=0.95 across all tasks". Has `low_effort` mode |
| Bug planter | `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | Nemotron 3 Nano 30B-A3B LLM + CRADIO-v4 vision + Parakeet audio encoders | 256K | **ON** | Released 2026-04-28. Thinking mode: T=0.6, top_p=0.95; instruct mode: T=0.2, top_k=1. Also takes image/audio/video |
| Overflow worker | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 30B / 3B active | 256K | ON | Cheapest; same price as Lightning on Crusoe |
| (available) | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | 120B-A12B VL, released 2026-10-15 | 1M | ON | Newest; multimodal; not needed for Ratchet |

### Reasoning control (chat template kwargs) — VERIFIED on Crusoe

The documented control for all Nemotron 3 / 3.5 models is a chat-template kwarg, passed through the OpenAI SDK's `extra_body`:

```python
# Reasoning OFF (what Ratchet workers should use for cheap, deterministic code)
client.chat.completions.create(
    model="nvidia/Nemotron-3.5-Lightning-30B-A3B",
    messages=[...],
    max_tokens=2000,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)

# Reasoning ON (default) — the trace comes back in message.reasoning, final answer in message.content
# Super 120B also supports a cheap middle setting:
extra_body={"chat_template_kwargs": {"enable_thinking": True, "low_effort": True}}
```

Live results (2026-10-17, `max_tokens=60`, prompt "Return exactly the text: OK"):

| Model | enable_thinking | finish | completion tokens | content | reasoning |
|---|---|---|---|---|---|
| Lightning | default (on) | `length` | 60 | `''` | `"Here's a thinking process: ..."` (budget exhausted) |
| Lightning | `false` | `stop` | 2 | `OK` | – |
| Super 120B | `false` | `stop` | 2 | `OK` | – |
| Nano Omni Reasoning | `false` | `stop` | 3 | `\nOK` | – |
| Super 120B | `true` + `low_effort` | `tool_calls` | 42 | `''` | `"We need to run tests for task t-17."` |

Notes:
- Crusoe returns reasoning in a separate `message.reasoning` field (not inline `<think>` tags), so a parser is unnecessary; just read `.content`.
- Other documented kwargs: `force_nonempty_content: true` ("for coding agents", both Lightning and Super cards) — accepted by Crusoe (VERIFIED, harmless). `reasoning_budget` + `thinking_token_budget` (Nano Omni card; vLLM-side budget control) — not tested on Crusoe.
- The Super card's `/think` system-prompt token appears only in its OpenCode example with a custom `ThinkingBudgetClient`; the kwarg is the primary documented mechanism. No `/no_think` is documented for these models.
- Sampling: Lightning and Super cards say T=1.0/top_p=0.95 for everything; Nano Omni says T=0.2/top_k=1 in instruct mode. For a deterministic gate, low temperature + repeats is fine.

### Tool calling — VERIFIED on Crusoe

Standard OpenAI function calling works. Server-side the NVIDIA recipes are `--tool-call-parser qwen3_coder --reasoning-parser nemotron_v3` (Lightning/Nano) or `super_v3` (Super), which Crusoe evidently runs.

```
[Lightning, thinking off]  finish=tool_calls  tool_calls=[{"function":{"name":"run_tests","arguments":"{\"task_id\":\"t-17\"}"}}]  29 completion tokens
[Lightning, thinking on]   finish=tool_calls  same call, reasoning="We need to run tests for task t-17..."  54 tokens
[Super 120B, thinking off] finish=tool_calls  same call  29 tokens
```

So You.com search can be exposed to workers/reviewer as a normal `tools=[...]` function.

### Prefix cache / token accounting on Crusoe (observed)

- Super 120B responses include `usage.prompt_tokens_details.cached_tokens` (0 in our short probes). Lightning and Nano Omni returned `prompt_tokens_details: None`, even on a repeated 1,585-token identical prefix, so **cached-token reporting may not be surfaced for the 30B models**; track cost per version from `prompt_tokens`/`completion_tokens` and treat `cached_tokens` as optional.
- Rate limit: hit one HTTP 429 at 30 RPM during a parallel NeMo Evaluator run; its proxy retried automatically. Keep `max_concurrent` around 4 per model.

---

## 2. The NeMo family relevant to agents (what is real, what it costs to adopt)

| Name (real) | Kickoff garble | What it is | Install | Fit for Ratchet today |
|---|---|---|---|---|
| **NeMo Evaluator** 0.3.0 (`nel`) | – | Benchmark runner + BYOB + `nel compare`/`nel gate` statistical regression gating; Apache-2.0; needs Python >=3.12 (we have 3.13) | `uv pip install "nemo-evaluator[stats]"` (26 s) | **Best.** See section 3 |
| **NeMo Switchyard** 0.3.0 | "NeMoSwitch" | Open-source agent model router (Rust core, Python bindings `switchyard.libsy`). Algorithms: `auto`/`stage_router` (tool-result signals -> efficient vs capable), `llm_classifier`, `escalation`, `composite`, prefill router. Standalone OpenAI-compatible proxy is `cargo install switchyard-server` (Linux-validated only). Released 2026-08-11 with Lightning | `uv pip install nemo-switchyard` (7 s; imports fine on macOS arm64) | Good second integration (route workers Nano-vs-Lightning-vs-Super per task), but the Python embedding API is "Beta, will change" and you own the model calls. 1-2 h |
| **NemoClaw / Open Agent Safety Platform** | "LoopMock" | Open reference stack: OpenShell sandbox runtime (kernel-level sandbox, deny-by-default network, YAML policy) running OpenClaw with Nemotron; announced 2026-09-28 together with Anthropic collaboration | Docker/Linux-oriented | Not today |
| **NeMo Agent Toolkit (NAT)** 1.9.0 | – | Framework-agnostic agent toolkit: YAML workflows, `nat eval`, profiler, MCP, `llms: {_type: openai, base_url, api_key}` | `pip install "nvidia-nat[eval]"` (heavy, LangChain-based) | Wrapping Ratchet as a NAT workflow is >1 h; skip unless time remains |
| **NeMo Guardrails** 0.24.1 | – | Colang rails; `engine: openai` + `parameters.base_url` works with any OpenAI-compatible endpoint | `pip install nemoguardrails` | Weak fit (we have no chat surface). Skip |
| **NeMo Gym** 0.7.0 | – | RL environments library for evaluating/improving agents; `nel eval run --bench gym://host:port` | needs Python >=3.13.14 | Only for the pitch ("Ratchet's holdout could become a Gym env") |
| **NeMo RL / fine-tuning** | – | Crusoe offers Lightning fine-tuning at $0.40/1M tokens | – | Pitch material only |
| **Nemotron 3.5 Lightning** | "NeMoPro 3.5" / probably "Nimble" | The worker model. NVIDIA: 4x faster output, ~30% faster agentic task completion, 86% PinchBench, 52.8 SWE-bench Verified | – | Already in use |
| **NVIDIA AI Blueprints** | – | build.nvidia.com/blueprints: AI-Q Research Agent, Deep Researcher (built on NAT 1.8), RAG, "always-on agents installed with a single command" (NemoClaw) | – | Reference only |

---

## 3. Recommendation: integrate NeMo Evaluator as Ratchet's "Prove + Gate" engine

**Why this one:** Ratchet's gate ("candidate playbook must beat incumbent by a margin AND regress no task the incumbent passes, each task run 2-3x") is exactly what `nel compare` computes: paired `(problem_idx, repeat)` records, flip lists (Regressions / Improvements / Stable), McNemar exact test, CI overlap, `--max-drop` threshold, `--strict` exit codes (0 pass, 1 BLOCK, 2 WARN/INCONCLUSIVE), plus a markdown regression report per version that can be shown in the demo. Ratchet's playbook is just the `system_prompt`, so versioning = re-running the same benchmark with a new system prompt.

### Proof (ran today, ~5 minutes total)

```
# scratch files are in the session scratchpad (nelproof/); results reproduced here
nel validate -b ./ratchet_bench.py --model-id nvidia/Nemotron-3.5-Lightning-30B-A3B -s 2   # 2/2 correct
nel eval run gate_base.yaml   # PLAYBOOK v1, 4 tasks x 2 repeats -> pass@1=1.0
nel eval run gate_cand.yaml   # PLAYBOOK v2                       -> pass@1=1.0
nel compare out/base out/cand --show-flips --verbose --no-strict
# -> VERDICT: PASS (4 paired samples; Regressions 0, Improvements 0; McNemar p=1.0)
# -> regression_report.md written next to candidate bundle
```

### Minimal integration (copy/paste)

`ratchet/holdout_bench.py` — the holdout set as a BYOB benchmark; scorer = run hidden tests, pass only on exit code 0:

```python
import json, os, re, subprocess, sys, tempfile
from nemo_evaluator import benchmark, scorer, ScorerInput

HOLDOUT = os.environ.get("RATCHET_HOLDOUT", "data/holdout.jsonl")   # rows: {"id","spec","tests"}

def _code(resp):
    m = re.findall(r"```(?:python)?\n(.*?)```", resp, re.S)
    return "\n".join(m) if m else resp

@benchmark(name="ratchet_holdout",
           dataset=lambda: [json.loads(l) for l in open(HOLDOUT)],
           prompt="{spec}\nRespond with only a single ```python code block.",
           target_field="tests")
@scorer
def score(sample: ScorerInput) -> dict:
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "sol.py"); open(p, "w").write(_code(sample.response) + "\n\n" + sample.target)
        try:
            r = subprocess.run([sys.executable, "-I", p], capture_output=True, text=True, timeout=10)
            return {"correct": r.returncode == 0, "stderr": r.stderr[-300:]}
        except subprocess.TimeoutExpired:
            return {"correct": False, "stderr": "timeout"}
```

`ratchet/gate.yaml` — rendered per candidate (system_prompt = playbook text, output dir = version id). `${VAR}` env expansion works in the YAML; the key never touches disk:

```yaml
services:
  worker:
    type: api
    url: ${CRUSOE_BASE_URL}/chat/completions
    protocol: chat_completions
    model: nvidia/Nemotron-3.5-Lightning-30B-A3B
    api_key: ${CRUSOE_API_KEY}
    generation: {temperature: 0.2, max_tokens: 1500}
    proxy:
      extra_body: {chat_template_kwargs: {enable_thinking: false}}   # merged into every request
      max_retries: 3
      max_concurrent_upstream: 4                                      # stay under 30 RPM
benchmarks:
  - name: ./ratchet/holdout_bench.py
    repeats: 3
    max_concurrent: 4
    solver: {type: simple, service: worker, system_prompt: "<PLAYBOOK vN+1 TEXT>"}
output: {dir: ./runs/v{N+1}}
```

Gate call from Python (or shell):

```python
import subprocess
rc = subprocess.run(["nel", "compare", f"runs/v{n}", f"runs/v{n+1}", "--strict", "--max-drop", "0.0",
                     "--show-flips", "--format", "json", "-o", f"runs/v{n+1}/gate.json"]).returncode
accept = (rc == 0)   # 1 = BLOCK (regression), 2 = WARN/INCONCLUSIVE -> treat as reject
```

Or in-process: `from nemo_evaluator.engine.comparison import compare_runs` -> `compare_runs(baseline_bundle, candidate_bundle, min_effect=0.0)["verdict"]` and read `flips` for the per-task regression list. Bundles are `runs/vN/ratchet_holdout/eval-*.json`; per-sample records are `results.jsonl` (`problem_idx`, `repeat`, `reward`, `model_response`, `expected_answer`). `model_traffic.jsonl` gives per-call `usage` + latency for the cost-per-version chart.

"Beats incumbent by a margin": `nel compare` guards against *regression*; for the improvement margin read `score_deltas.pass@1` from the JSON report (or `report["benchmark"]["scores"]`) and require `delta >= MARGIN` in Ratchet's own code. `nel gate -p policy.yaml` adds per-benchmark `max_drop`/tiers (GO / NO-GO / INCONCLUSIVE) if a multi-suite story is wanted later.

Caveats:
- `nel eval run` quick mode (`-b ./file.py --model-url --model-id --system-prompt --repeats`) has no `extra_body`, so reasoning stays on; use the YAML path above (or give a big `max_tokens`).
- Bug-planter "test the tests" step stays in Ratchet code; the BYOB dataset callable can simply filter out tasks whose suites were marked weak.
- `code_sandbox(sample)` (Docker-hardened, used by NVIDIA's own humaneval) is available if we want sandboxing without writing it; the subprocess scorer above was faster to prove.

---

## 4. Secondary option: NeMo Switchyard (if time remains)

`switchyard.libsy.algorithms.stage_router(picker="efficient_first", confidence_threshold=0.5)` is the "auto" preset. You drive `algorithm.run_stream(request, {"efficient": [...], "capable": [...]})`, get `Step.CallModel(call)` with `call.models[0]`, perform the Crusoe call yourself and `call.respond(LlmResponse.Agg({...}))`, then `Step.Done(outcome)` gives `outcome.selected_model_ids`. Request format is Switchyard's normalized one (content as `[{"type":"text","text":...}]`). Fit: route Ratchet workers between Nano/Lightning (efficient) and Super (capable) per task from tool-result history. Risk: Beta API, extra translation code; keep it to a stretch goal. Docs: https://github.com/NVIDIA-NeMo/Switchyard (README, `examples/libsy.py`, `docs/routing_algorithms/stage_router_routing.md`).

---

## 5. Sources

- Lightning model card: https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 (and NIM ref https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b)
- Super 120B model card: https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard
- Nano Omni Reasoning model card: https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard
- Nemotron 3.5 tech report: https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3.5-Super-and-Lightning-Technical-Report.pdf
- NeMo Evaluator: https://github.com/NVIDIA-NeMo/evaluator , BYOB https://docs.nvidia.com/nemo/evaluator/tutorials/byob , compare https://docs.nvidia.com/nemo/evaluator/tutorials/compare , CI gate https://docs.nvidia.com/nemo/evaluator/deployment/ci-regression , quality gate https://docs.nvidia.com/nemo/evaluator/tutorials/quality-gate
- NeMo Switchyard: https://github.com/NVIDIA-NeMo/Switchyard , blog https://developer.nvidia.com/blog/route-ai-agent-workloads-across-models-with-nvidia-nemo-switchyard/
- NeMo Agent Toolkit: https://docs.nvidia.com/nemo/agent-toolkit/latest/ (install, LLM providers, evaluate)
- NeMo Guardrails: https://github.com/NVIDIA-NeMo/Guardrails ; NeMo Gym: https://github.com/NVIDIA-NeMo/Gym
- Open Agent Safety Platform / NemoClaw: https://nvidianews.nvidia.com/news/open-agent-safety-platform
- Nemotron 3.5 Super VL launch (2026-10-15): https://blogs.nvidia.com/blog/nemotron-3-5-super-vl/
- Hackathon page (prize text only): https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon
- Blueprints: https://build.nvidia.com/blueprints
