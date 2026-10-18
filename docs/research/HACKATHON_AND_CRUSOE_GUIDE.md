# The Recursive Agents Hackathon & Complete Crusoe Developer Guide

> **Crawled & Verified Sources**:
> - Event Page: `https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon/details` (`docs/research/raw/crawl.json`)
> - Event Markdown Endpoint: `https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon.md`
> - Pre-Hackathon Field Day: `https://luma.com/pcfayy36`
> - Crusoe Cloud Docs: `https://docs.crusoecloud.com/` (`docs/research/raw/crusoe-docs-crawl.json`)
> - Crusoe Pricing & OpenAPI Specs: `https://www.crusoe.ai/cloud/pricing`, `https://api.intelligence.crusoecloud.com/v1/swagger.json`

---

## Part 1: The Recursive Agents Hackathon — Complete Event Details

### 1.1 Overview & Core Metadata
| Field | Details |
| :--- | :--- |
| **Event Title** | **The Recursive Agents Hackathon** |
| **Tagline** | *"Build a team of agents you can walk away from."* |
| **Organizers / Hosts** | **Cerebral Valley** (`@cerebral_valley`) & **Crusoe** (`@crusoeai`), in partnership with **NVIDIA** |
| **Conference Tie-In** | Held during the **PyTorch Conference** in San Francisco |
| **Event ID & Slug** | ID: `69bf18be-99fd-49c8-acec-88541d664884` · Slug: `crusoe-recursive-agents-hackathon` |
| **Date** | **Saturday, October 17, 2026** |
| **Event Hours** | **9:00 AM – 10:00 PM PDT** (`2026-10-17T16:00:00.000Z` to `2026-10-18T05:00:00.000Z`) |
| **Project Submission Deadline** | **5:00 PM PDT on Saturday, October 17, 2026** (`2026-10-18 00:00:00 UTC`), with a **1-hour grace period** (`submissionDueDateGracePeriodHours: 1`) |
| **Location** | **San Francisco, CA** *(In-person only; exact venue address revealed upon host approval — Cerebral Valley SF hackathons are typically hosted at SHACK15 in the Ferry Building or partner venues in SoMa)* |
| **Team Size** | **Up to 4 people per team** (you can apply solo or with a team and form/finalize teams on Discord or at the event) |
| **Prizes** | **$25,000 in cash prizes** + an **NVIDIA RTX 5090** GPU |
| **Admission / Approval** | Application required (`approvalRequired: true`, `checkInEnabled: true`, `waiverRequired: true`). Enable Chat Apply is supported on Cerebral Valley. |
| **Age / Minor Policy** | Participants under 18 are welcome **only if accompanied by a legal guardian at all times**. Age/ID verification takes place at check-in. |

---

### 1.2 Theme, Technical Challenge & Judging Focus
The hackathon challenges builders to move beyond brittle "one-shot" prompt wrappers and single-turn tool-calling agents into **persistent, recursive multi-agent loops**:

1. **Autonomous Goal Decomposition & Planning**:
   - Agents take a high-level goal and run with it: formulate an execution plan, dynamically spin up specialized sub-agents, and delegate sub-tasks.
2. **Inter-Agent Communication & Recursive Delegation**:
   - Sub-agents can spawn further worker agents or critique/verification loops, pass structured state and context between peers, and coordinate parallel execution.
3. **Self-Verification, Error Recovery & Persistence**:
   - Agents check their own progress against acceptance criteria, recover automatically when tools, tests, or external APIs fail, maintain long-running memory, and keep operating after you walk away until the job is done.
4. **Core Infrastructure Requirement**:
   - Build on **Crusoe Managed Inference** (`https://api.inference.crusoecloud.com/v1`), putting leading open-weight models—specifically **NVIDIA's Nemotron family** (`Nemotron-3.5-Lightning`, `Nemotron-3-Super-120B`, `Nemotron-3-Nano`, `Nemotron-3-Nano-Omni-Reasoning`, `Nemotron-3-VoiceChat`)—into production on high-performance NVIDIA infrastructure powered by Crusoe's **MemoryAlloy™** distributed KV-cache engine.

---

### 1.3 Pre-Hackathon Companion Event: Crusoe Field Day
Before Saturday's coding marathon, Crusoe is hosting an outdoor community event:
- **Event**: **Crusoe Field Day: Build, Train, Deploy** (`https://luma.com/pcfayy36`)
- **Date & Time**: **Friday, October 16, 2026 · 1:00 PM – 5:00 PM PDT**
- **Location**: **Civil War Parade Ground (Main Parade Lawn), Presidio of San Francisco**, Graham St, San Francisco, CA (`37.8003382, -122.4568085`)
- **Hosts**: Ben Walters, Mary Lieu, Judy Wu, and Ian Kistner (Crusoe)
- **Format**: Zero laptops, zero code. Attendees are grouped into random teams to race through outdoor field-day games modeled after stages of the AI lifecycle—taking a model from "raw data" to "production"—followed by food trucks, drinks, and networking with hackathon participants and Crusoe engineers.

---

### 1.4 Cerebral Valley Application Questions
When applying at `https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon/details`, the registration form asks these exact 7 questions:
1. **What's your LinkedIn?** *(Required — URL)*
2. **What's your GitHub?** *(Required — URL)*
3. **What's your Twitter/X?** *(Optional)*
4. **What company do you work for?** *(Required — Company or University)*
5. **What is your current role?** *(Required)*
6. **What project do you plan to build at the hackathon (1 line)?** *(Required — tip: emphasize recursive sub-agent delegation + NVIDIA Nemotron on Crusoe Managed Inference)*
7. **Describe your experience level with Crusoe Managed Inference** *(Required — single-select: `Beginner`, `Intermediate`, or `Advanced`)*

---

### 1.5 Rules, IP Ownership & Legal Waiver Summary
From the official Hackathon Rules & Liability Waiver embedded in the registration flow:
- **IP Ownership**: **Entrants retain full ownership** of all intellectual and industrial property rights (including moral rights) in and to their Submission.
- **Organizer & Partner License**: As a condition of submission, Entrant grants the Hackathon Organizer (Cerebral Valley), its subsidiaries, agents, and partner companies (**Crusoe** and **NVIDIA**) a perpetual, irrevocable, worldwide, royalty-free, and non-exclusive license to use, reproduce, adapt, modify, publish, distribute, publicly perform, create derivative works from, and publicly display the Submission (e.g., for demos, marketing, and showcase materials).
- **Submissions**: All submissions must be received by `2026-10-18 00:00:00 UTC` (5:00 PM PDT on Oct 17, 2026; 1-hour grace period configured on platform) in English.
- **Originality**: Must be original work created by the Entrant/Team and must not infringe third-party IP, privacy, or publicity rights.
- **Data Sharing**: Registration data is shared with event partners including **NVIDIA** in accordance with NVIDIA's Privacy Policy.
- **Governing Law**: State of California (exclusive jurisdiction in San Francisco County courts).

---

## Part 2: Everything About Crusoe & Why It Excels for Recursive Agents

### 2.1 What is Crusoe?
**Crusoe** (`crusoe.ai`) is the vertically integrated **AI Factory company**:
1. **Clean Energy & Modular Data Centers**: Founded in 2018 by Chase Lochmiller and Cully Cavness, Crusoe pioneered **Digital Flare Mitigation®** (capturing stranded/wasted natural gas flare streams) and utility-scale clean/renewable energy generation to power massive AI data centers (including the flagship Abilene, Texas Lancium/Stargate campus, Hobbs New Mexico, Iceland, and Norway).
2. **Crusoe Cloud (IaaS)**: High-performance GPU & CPU cloud offering **NVIDIA GB200 NVL72**, **HGX B300**, **HGX B200**, **HGX H200**, **HGX H100**, **A100**, **L40S**, and **AMD MI355X / MI300X** interconnected with Quantum-2 InfiniBand / RoCE fabrics, **Crusoe Managed Kubernetes (CMK)**, high-speed shared/persistent disks, and **$0 network egress/ingress fees**.
3. **Crusoe Intelligence Foundry / Managed AI (PaaS)**:
   - **Serverless Inference**: Multi-tenant, OpenAI-compatible pay-per-token API (`https://api.inference.crusoecloud.com/v1`).
   - **Self-Serve Deployments**: Dedicated, reserved-capacity GPU endpoints (`Responsiveness`, `Throughput`, or `Balanced` profiles) launched in minutes without talking to sales, supporting both base models and custom LoRA adapters.
   - **Serverless Fine-Tuning**: Managed LoRA / rsLoRA supervised fine-tuning (`https://api.intelligence.crusoecloud.com/v1/fine_tuning/jobs`) with automatic hyperparameter selection, checkpointing, and direct one-click deployment to Self-Serve endpoints.
   - **Batch Inference & Files/Uploads API**: Asynchronous batch processing (`/v1/batches`) and multipart large-file uploads (`/v1/uploads` up to 16 GiB).

---

### 2.2 The Secret Weapon for Recursive Agents: MemoryAlloy™ & Cache-Aware Routing
Why is Crusoe hosting a **Recursive Agents** hackathon specifically around its Managed Inference engine?
- In traditional LLM serving (vanilla vLLM / TensorRT-LLM), a model's **KV cache** is trapped inside the HBM of a single GPU node. When a parent orchestrator agent spawns 5 sub-agents, or runs a 30-turn recursive loop, requests get load-balanced across different GPU replicas—forcing every node to **recompute the prefill** for the shared system prompt, tool definitions, and conversation history.
- Crusoe's proprietary inference engine combines two architectural breakthroughs:
  1. **MemoryAlloy™**: A distributed memory fabric that pools high-speed memory across the entire GPU cluster, decoupling KV-cache capacity from individual GPU HBM limits so massive multi-agent context histories are retained without eviction.
  2. **KV-Aware / Cache-Aware Routing**: Crusoe's intelligent routing layer inspects the token prefix of incoming requests and routes sub-agent and multi-turn requests to the exact compute nodes holding the warm KV cache in MemoryAlloy.
- **Measured Performance Impact**:
  - Up to **9.9× faster Time-To-First-Token (TTFT)** on long-context / multi-turn workloads compared to baseline vLLM.
  - Up to **5× higher total token throughput**.
  - **Massive Cost Savings**: Cached input tokens on Crusoe Serverless Inference are billed at **40% to 97% discounts** (e.g., `$0.03/1M` vs `$0.05/1M` on Nemotron 3.5 Lightning & Nano, `$0.15/1M` vs `$0.30/1M` on Nemotron 3 Super 120B, and `$0.007/1M` vs `$0.29/1M` on DeepSeek V4.1 Flash!).

> **Hackathon Architecture Tip**: Structure all your agents and sub-agents so that the **static prefix** (shared system instructions, tool schemas, codebase/repo context, and shared scratchpad history) appears **identically at the beginning of the `messages` array**, and only append the sub-agent's specific role/task at the very end. This maximizes **MemoryAlloy prefix cache hits**, giving your recursive agent swarm near-instant TTFT and slashing token burn!

---

## Part 3: Crusoe Managed Inference — Models, Pricing & Deprecations (October 2026)

### 3.1 Active Serverless Inference Models (`https://api.inference.crusoecloud.com/v1`)
Use these exact **API Model IDs** in the `model` parameter of your OpenAI SDK or HTTP calls:

| Model Family | Exact API Model ID | Type / Modality | Max Context | Quantization | Price per 1M Tokens (Input / Output / Cached) | Best Role in Recursive Agent Teams |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **NVIDIA Nemotron (Featured)** | `nvidia/nemotron-3.5-lightning-30b-a3b` | Instruct (MoE, 30B total / 3B active) | **1,000,000** | NVFP4 | **$0.05** / **$0.20** / **$0.03** | **High-speed Sub-Agent Worker & Long-Context Repo/Doc Reader** (1M context + ultra-fast NVFP4) |
| **NVIDIA Nemotron (Featured)** | `nvidia/Nemotron-3-Super-120B-A12B` | Instruct (MoE, 120B total / 12B active) | **262,144** | FP8 | **$0.30** / **$2.40** / **$0.15** | **Root Orchestrator, Planner & Complex Code/Tool Synthesizer** |
| **NVIDIA Nemotron (Featured)** | `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | Reasoning + Multimodal (Text, Image, Video, Audio) | **262,144** | FP8 | **$0.30** / **$1.83** / **$0.30** *(Audio cached: $0.50)* | **Verifier / Critic Agent, UI/Screenshot/Video Inspector & Deep Reasoner** |
| **NVIDIA Nemotron (Featured)** | `nvidia/Nemotron-3-Nano-30B-A3B` | Instruct (MoE, 30B total / 3B active) | **262,144** | FP8 | **$0.05** / **$0.20** / **$0.03** | **Fast Parallel Sub-Agent / Tool Router / Summarizer** |
| **NVIDIA Nemotron (Featured)** | `nvidia/Nemotron-3-VoiceChat` | Speech-to-Speech (11B) | **131,072** | BF16/FP8 | Custom / Credits | **Real-Time Voice Agent Interface** for live human-in-the-loop updates |
| **DeepSeek** | `deepseek-ai/DeepSeek-V4-Flash` | Instruct | **1,000,000** | — | **$0.14** / **$0.28** / **$0.03** | Fast 1M-context coding & tool-use worker (MIT License) |
| **DeepSeek** | `deepseek-ai/DeepSeek-V4.1-Flash` | Instruct | **1,000,000** | — | **$0.29** / **$1.20** / **$0.007** | Ultra-cheap cached-prefix ($0.007/1M!) iterative coding agent |
| **DeepSeek** | `deepseek-ai/DeepSeek-V4-Pro` | Instruct | **1,000,000** | — | **$1.74** / **$3.48** / **$0.15** | Frontier heavy-duty reasoning & synthesis (MIT License) |
| **Z.ai (GLM)** | `zai/GLM-5.3` | Instruct | **1,000,000** | — | **$1.40** / **$4.40** / **$0.26** | High-capability 1M-context agentic planner |
| **Z.ai (GLM)** | `zai/GLM-5.3-Flash` | Instruct | **1,000,000** | — | **$0.15** / **$0.50** / **$0.03** | Low-latency 1M-context agent worker |
| **OpenAI Open-Weight** | `openai/gpt-oss-120b` | Instruct | **128,000** | — | **$0.05** / **$0.25** / **$0.05** | Extremely cost-effective 120B open-weight model (Apache 2.0) |
| **Google Gemma** | `google/gemma-4-31b-it` | Instruct | **262,144** | — | **$0.14** / **$0.40** / **$0.14** | Dense 31B instruction-following & structured output model |
| **Qwen** | `qwen/Qwen3.8-27B` | Instruct | **256,000** | — | See console | Strong coding and multilingual instruction model (Apache 2.0) |

---

### 3.2 ⚠️ Deprecated Serverless Models (Do NOT Use in Serverless Code!)
Many older blog posts, third-party tutorials, and even legacy curl examples in documentation still reference `meta-llama/Llama-3.3-70B-Instruct` or `DeepSeek-V3`. **Those models have been deprecated on Crusoe Serverless Inference**:
- **Deprecated October 2, 2026**:
  - `Moonshot Kimi K2.6` → Migrate to `deepseek-ai/DeepSeek-V4-Flash` or `zai/GLM-5.3`
- **Deprecated September 12, 2026**:
  - `meta-llama/Llama-3.3-70B-Instruct` *(Deprecated on Serverless Inference; only available on Self-Serve Deployments & Fine-Tuning)*
  - `DeepSeek V3` → Migrate to `deepseek-ai/DeepSeek-V4-Flash` or `deepseek-ai/DeepSeek-V4-Pro`
  - `Qwen3 235B A22B` → Migrate to `qwen/Qwen3.8-27B` or `nvidia/Nemotron-3-Super-120B-A12B`
  - `Z.ai GLM-5.1` & `Z.ai GLM-5.2` → Migrate to `zai/GLM-5.3` or `zai/GLM-5.3-Flash`

---

## Part 4: Complete How-To Guide — Using Crusoe Managed Inference

### 4.1 Step 1: Account Setup & Getting Your Intelligence API Key
1. Sign up or log in at **[console.crusoecloud.com](https://console.crusoecloud.com/)**.
   - New accounts automatically receive **$5 in free Serverless Inference credits** (`https://console.crusoecloud.com/foundry/serverless-deployments`), plus hackathon participants receive event credits from Crusoe.
   - **Important Rate-Limit Tip**: Adding a payment method on file (even while spending free/hackathon credits) immediately upgrades your project rate limits from **30 RPM / 500K TPM** to **600 RPM / 2,000,000 TPM** per model!
2. Generate an **Intelligence API Key**:
   - In the left navigation bar, go to **Admin → Security → Intelligence API keys** (`https://console.crusoecloud.com/security/inference-api-keys`), OR go to **Intelligence Foundry → Models** (`https://console.crusoecloud.com/foundry/models`) and click **"Generate API Key"** in the top-right corner.
   - Copy the key immediately (it is shown only once) and export it in your shell:
     ```bash
     export CRUSOE_API_KEY="your_crusoe_intelligence_api_key_here"
     ```

---

### 4.2 Step 2: All Crusoe API Base URLs at a Glance
Crusoe uses distinct base URLs for different planes of the platform. Do not mix them up:

| Service Plane | Base URL | Auth Header | Primary Endpoints |
| :--- | :--- | :--- | :--- |
| **Serverless & Self-Serve Inference** (OpenAI-Compatible) | `https://api.inference.crusoecloud.com/v1` | `Authorization: Bearer $CRUSOE_API_KEY` | `POST /chat/completions`<br>`GET /models` |
| **Intelligence Foundry Management** (Fine-Tuning, Files, Uploads, Batches) | `https://api.intelligence.crusoecloud.com/v1` | `Authorization: Bearer $CRUSOE_API_KEY` | `POST /files`, `GET /files`<br>`POST /uploads`<br>`POST /fine_tuning/jobs`<br>`POST /fine_tuning/jobs/estimate_price`<br>`POST /batches`<br>`GET /models/{model}/download` |
| **Self-Serve Deployment Control Plane** | `https://api.crusoecloud.com/v1/projects/{project_id}/foundry/selfserve` | `Authorization: Bearer $CRUSOE_API_KEY` | `POST /deployments`<br>`GET /deployments`<br>`GET /deployments/{id}`<br>`PATCH /deployments/{id}`<br>`DELETE /deployments/{id}` |
| **Serverless Metrics (PromQL API)** | `https://api.cloud.crusoe.ai/v1/projects/{project_id}/metrics/timeseries` | `Authorization: Bearer $MONITORING_TOKEN` | `GET /metrics/timeseries?query=...` |

---

### 4.3 Step 3: Calling Serverless Inference (cURL, Python, TypeScript)

#### A. cURL Quickstart (List Models & Chat Completion)
```bash
# 1. List all available models on Serverless Inference
curl -s "https://api.inference.crusoecloud.com/v1/models" \
  -H "Authorization: Bearer $CRUSOE_API_KEY" | jq .

# 2. Chat completion with NVIDIA Nemotron-3-Super-120B-A12B
curl -s "https://api.inference.crusoecloud.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRUSOE_API_KEY" \
  -d '{
    "model": "nvidia/Nemotron-3-Super-120B-A12B",
    "messages": [
      {"role": "system", "content": "You are an autonomous lead architect agent."},
      {"role": "user", "content": "Break down the task of building a self-healing CI/CD pipeline into 3 sub-agent roles."}
    ],
    "temperature": 0.2,
    "max_tokens": 1024,
    "stream": false
  }' | jq .
```

#### B. Python SDK (`openai` package — Synchronous & Async Streaming)
```bash
pip install openai pydantic tenacity
```

```python
import os
from openai import OpenAI, AsyncOpenAI

client = OpenAI(
    base_url="https://api.inference.crusoecloud.com/v1",
    api_key=os.environ["CRUSOE_API_KEY"],
)

# Streaming response with NVIDIA Nemotron 3.5 Lightning (1M context, NVFP4)
stream = client.chat.completions.create(
    model="nvidia/nemotron-3.5-lightning-30b-a3b",
    messages=[
        {"role": "system", "content": "You are a fast execution sub-agent."},
        {"role": "user", "content": "Write a Python function that verifies git worktree cleanliness."},
    ],
    temperature=0.2,
    max_tokens=1024,
    stream=True,
)

for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

#### C. TypeScript / Node.js (`openai` npm package or Vercel AI SDK)
```bash
npm install openai
```

```typescript
import OpenAI from "openai";

const crusoe = new OpenAI({
  baseURL: "https://api.inference.crusoecloud.com/v1",
  apiKey: process.env.CRUSOE_API_KEY,
});

async function runSubAgent(task: string) {
  const response = await crusoe.chat.completions.create({
    model: "nvidia/Nemotron-3-Nano-30B-A3B",
    messages: [
      { role: "system", content: "You are a specialized research sub-agent." },
      { role: "user", content: task },
    ],
    temperature: 0.3,
  });
  return response.choices[0].message.content;
}
```

---

### 4.4 Step 4: Reference Architecture — Recursive Multi-Agent Loop Optimized for Crusoe MemoryAlloy™
Below is a complete, production-ready Python pattern for the hackathon that uses:
1. **`nvidia/Nemotron-3-Super-120B-A12B`** as the **Root Planner & Orchestrator**
2. **`nvidia/nemotron-3.5-lightning-30b-a3b`** as parallel **Worker Sub-Agents** (running concurrently via ` asyncio.gather`)
3. **`nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B`** as the **Recursive Critic / Self-Verifier** that decides whether the goal is satisfied or if another recursive iteration is needed
4. **Shared Static Prefix Caching** so Crusoe's **MemoryAlloy™** reuses the KV cache across all sub-agents
5. **Exponential Backoff on `429` / `503`** per Crusoe's rate-limit best practices

```python
import asyncio
import json
import os
import random
from typing import List, Dict, Any
from openai import AsyncOpenAI, APIStatusError

# Initialize AsyncOpenAI pointed at Crusoe Managed Inference
crusoe = AsyncOpenAI(
    base_url="https://api.inference.crusoecloud.com/v1",
    api_key=os.environ["CRUSOE_API_KEY"],
)

# Model tier assignments on Crusoe Serverless Inference
ORCHESTRATOR_MODEL = "nvidia/Nemotron-3-Super-120B-A12B"
WORKER_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
CRITIC_MODEL = "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B"

# Keep a shared static prefix across all agents to maximize Crusoe MemoryAlloy KV-cache hits!
SHARED_SYSTEM_PREFIX = """You are part of an autonomous Recursive Agent Team running on Crusoe Managed Inference.
Project Workspace Rules:
- Always produce deterministic, verifiable outputs.
- Communicate findings clearly so peer agents and the Critic agent can verify your work.
- Never stop until all acceptance criteria are verified.
"""

async def call_crusoe_with_backoff(
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int = 2048,
    max_retries: int = 6,
) -> str:
    """Calls Crusoe Serverless Inference with exponential backoff + jitter for 429/503."""
    for attempt in range(max_retries):
        try:
            resp = await crusoe.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return resp.choices[0].message.content or ""
        except APIStatusError as e:
            if e.status_code in (429, 503) and attempt < max_retries - 1:
                sleep_s = min(60.0, (2 ** attempt) + random.uniform(0.1, 1.0))
                print(f"[Crusoe {e.status_code}] Backing off {sleep_s:.1f}s (attempt {attempt + 1})...")
                await asyncio.sleep(sleep_s)
            else:
                raise

async def spawn_worker_agent(worker_id: str, subtask: str, shared_memory: str) -> Dict[str, str]:
    """Spawns a fast Nemotron 3.5 Lightning sub-agent sharing the common prefix."""
    messages = [
        {"role": "system", "content": SHARED_SYSTEM_PREFIX},
        {"role": "user", "content": f"SHARED TEAM MEMORY:\n{shared_memory}"},
        {
            "role": "user",
            "content": f"You are Worker Sub-Agent [{worker_id}]. Execute this delegated subtask thoroughly:\n{subtask}",
        },
    ]
    output = await call_crusoe_with_backoff(model=WORKER_MODEL, messages=messages)
    return {"worker_id": worker_id, "subtask": subtask, "output": output}

async def recursive_agent_loop(goal: str, max_depth: int = 4) -> str:
    """Persistent recursive agent loop: Plan -> Delegate in Parallel -> Critique -> Recurse until done."""
    shared_memory = f"INITIAL GOAL: {goal}\n"

    for iteration in range(1, max_depth + 1):
        print(f"\n=== Recursive Loop Iteration {iteration}/{max_depth} ===")

        # 1. Orchestrator (Nemotron 3 Super 120B) decomposes remaining work into parallel subtasks
        plan_messages = [
            {"role": "system", "content": SHARED_SYSTEM_PREFIX},
            {"role": "user", "content": f"SHARED TEAM MEMORY:\n{shared_memory}"},
            {
                "role": "user",
                "content": (
                    "You are the Lead Orchestrator Agent. Based on the goal and memory so far, "
                    "output ONLY a valid JSON array of 2 to 4 specific subtasks to delegate to worker sub-agents "
                    'in parallel. Format: [{"id": "worker-1", "task": "..."}]'
                ),
            },
        ]
        raw_plan = await call_crusoe_with_backoff(model=ORCHESTRATOR_MODEL, messages=plan_messages)

        try:
            start = raw_plan.find("[")
            end = raw_plan.rfind("]") + 1
            subtasks = json.loads(raw_plan[start:end])
        except Exception:
            subtasks = [{"id": f"worker-{iteration}-1", "task": f"Complete remaining work for: {goal}"}]

        # 2. Spawn Worker Sub-Agents in parallel (Nemotron 3.5 Lightning)
        print(f"Spawning {len(subtasks)} parallel worker sub-agents...")
        worker_results = await asyncio.gather(
            *[spawn_worker_agent(st["id"], st["task"], shared_memory) for st in subtasks]
        )

        for res in worker_results:
            shared_memory += f"\n--- Output from {res['worker_id']} ({res['subtask']}) ---\n{res['output']}\n"

        # 3. Critic / Verifier Agent (Nemotron 3 Nano Omni Reasoning) checks completion
        critic_messages = [
            {"role": "system", "content": SHARED_SYSTEM_PREFIX},
            {"role": "user", "content": f"SHARED TEAM MEMORY:\n{shared_memory}"},
            {
                "role": "user",
                "content": (
                    "You are the Autonomous Critic & Verification Agent. Evaluate whether the original goal "
                    "has been completely satisfied with zero gaps or errors. "
                    'Reply with a JSON object: {"complete": true/false, "critique": "...", "final_synthesis": "..."}'
                ),
            },
        ]
        critic_raw = await call_crusoe_with_backoff(model=CRITIC_MODEL, messages=critic_messages)
        shared_memory += f"\n--- Critic Evaluation (Iteration {iteration}) ---\n{critic_raw}\n"

        try:
            c_start = critic_raw.find("{")
            c_end = critic_raw.rfind("}") + 1
            verdict = json.loads(critic_raw[c_start:c_end])
            if verdict.get("complete") is True:
                print("✅ Critic verified goal completion!")
                return verdict.get("final_synthesis", shared_memory)
            print(f"🔄 Critic requested another recursive pass: {verdict.get('critique')}")
        except Exception:
            pass

    return shared_memory

if __name__ == "__main__":
    result = asyncio.run(
        recursive_agent_loop("Design and verify a fault-tolerant distributed task queue in Python.")
    )
    print("\nFINAL RESULT:\n", result)
```

---

## Part 5: Rate Limits, Error Codes, Headers & PromQL Metrics

### 5.1 Serverless Rate Limits (Per Project, Per Model)
Rate limits are enforced **independently per model** within your project (so calling `Nemotron-3-Super-120B-A12B`, `nemotron-3.5-lightning-30b-a3b`, and `Nemotron-3-Nano-Omni-Reasoning-30B-A3B` concurrently gives you **3× the aggregate capacity!**):

| Account Tier | Tokens Per Minute (TPM) | Requests Per Minute (RPM) |
| :--- | :--- | :--- |
| **No Payment Method Added** | **500,000 TPM** per model | **30 RPM** per model |
| **Payment Method Added** | **2,000,000 TPM** per model | **600 RPM** per model |

### 5.2 Rate-Limit Response Headers
Every response from `https://api.inference.crusoecloud.com/v1` includes real-time rate-limit tracking headers:
- `x-ratelimit-limit-tokens`: Maximum tokens permitted per minute for this model
- `x-ratelimit-remaining-tokens`: Remaining tokens in the current window
- `x-ratelimit-limit-requests`: Maximum requests permitted per minute for this model
- `x-ratelimit-remaining-requests`: Remaining requests in the current window

> **Pro Tip for Recursive Agents**: Inspect `x-ratelimit-remaining-requests` and `x-ratelimit-remaining-tokens` in your agent router! When `nvidia/nemotron-3.5-lightning-30b-a3b` drops below 10% remaining RPM/TPM, automatically overflow worker tasks to `nvidia/Nemotron-3-Nano-30B-A3B` or `deepseek-ai/DeepSeek-V4-Flash` so your agent swarm never stalls.

### 5.3 Status Codes: `429` vs. `503`
- **`429 Too Many Requests`**: Your project exceeded its per-model RPM or TPM limit.
- **`503 Service Unavailable`**: The shared serverless model pool is experiencing high aggregate demand across tenants and is scaling up capacity.
- Both should be handled with **exponential backoff + jitter** (`1s, 2s, 4s, 8s...` capped at `30–60s`).

### 5.4 Querying Live Inference Metrics via Crusoe's PromQL API
You can build a live observability dashboard for your recursive agents during the hackathon by querying Crusoe's Prometheus-compatible metrics endpoint!
1. Generate a monitoring token via Crusoe CLI:
   ```bash
   crusoe monitoring tokens create
   ```
2. Query `https://api.cloud.crusoe.ai/v1/projects/<project-id>/metrics/timeseries`:
   ```bash
   curl -G "https://api.cloud.crusoe.ai/v1/projects/$CRUSOE_PROJECT_ID/metrics/timeseries" \
     -H "Authorization: Bearer $CRUSOE_MONITORING_TOKEN" \
     --data-urlencode 'query=sum by (model_name) (increase(crusoe_serverless_inference_tokens_total[5m]))' \
     --data-urlencode "start=$(date -u -v-1H +%s)" \
     --data-urlencode "end=$(date -u +%s)" \
     --data-urlencode "step=1m"
   ```
- **Available Metrics**:
  - `crusoe_serverless_inference_requests_total` (labels: `model_name`, `status_code`)
  - `crusoe_serverless_inference_tokens_total` (labels: `model_name`, `token_type` = `input` | `output`)
  - `crusoe_serverless_inference_ttft_ms_bucket` / `_sum` / `_count` (Time-To-First-Token histogram; query P50/P90/P99 via `histogram_quantile(0.95, ...)`)
  - `crusoe_serverless_inference_tps_bucket` (Tokens-Per-Second histogram)
  - `crusoe_serverless_inference_request_duration_ms_bucket` (End-to-end latency histogram)

---

## Part 6: Self-Serve Dedicated Deployments & Serverless Fine-Tuning

### 6.1 Self-Serve Deployments (Dedicated GPU Endpoints)
When you need guaranteed, unthrottled throughput or want to serve a fine-tuned LoRA adapter:
- **Supported GPUs & Hourly Pricing**:
  - **NVIDIA H100 (80GB HGX)**: `$6.30 / GPU-hr`
  - **NVIDIA H200 (141GB HGX)**: `$7.50 / GPU-hr`
  - **AMD MI355X (288GB)**: `$8.20 / GPU-hr`
  - **NVIDIA B200 (180GB HGX)**: `$10.20 / GPU-hr`
  - **NVIDIA HGX B300 (288GB)**: `$13.80 / GPU-hr`
- **3 Optimization Profiles**:
  1. `Responsiveness`: Minimizes TTFT and inter-token latency for interactive/real-time agents.
  2. `Throughput`: Maximizes total concurrent tokens/sec for massive parallel sub-agent swarms.
  3. `Balanced`: Optimizes both latency and throughput.
- **Supported Base Models on Self-Serve Deployments**:
  - `deepseek-ai/DeepSeek-V4-Flash`, `google/gemma-4-26b-a4b-it`, `google/gemma-4-31b-it`, `meta-llama/Llama-3.1-8B-Instruct`, `meta-llama/Llama-3.3-70B-Instruct`, `nvidia/Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3-Super-120B-A12B`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/Qwen3-8B`, `qwen/Qwen3-235B-A22B-Instruct-2507`, `qwen/Qwen3.5-2B`, `qwen/Qwen3.5-9B`, `qwen/Qwen3.5-35B-A3B`, `qwen/Qwen3.6-27B`, `qwen/Qwen3.6-35B-A3B`, `qwen/Qwen3.8-27B`, `thinkingmachines/Inkling-Small` (1M ctx), `zai/GLM-5.2-FP8`, `zai/GLM-5.3`, `zai/GLM-5.3-Flash`.
- **Creating & Calling a Self-Serve Deployment**:
  ```bash
  # Create a deployment via REST API
  curl -X POST "https://api.crusoecloud.com/v1/projects/$CRUSOE_PROJECT_ID/foundry/selfserve/deployments" \
    -H "Authorization: Bearer $CRUSOE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "nemotron-agent-swarm",
      "description": "Dedicated Nemotron 3.5 Lightning endpoint",
      "deployment_Increment_id": "<increment_id_from_console>",
      "replica_count": 1,
      "model_id": "nvidia/nemotron-3.5-lightning-30b-a3b"
    }'
  ```
  Once running, call `https://api.inference.crusoecloud.com/v1/chat/completions` and pass your **Deployment ID** in the `"model"` field!

---

### 6.2 Serverless Fine-Tuning (`https://api.intelligence.crusoecloud.com/v1`)
Want your recursive agent to learn from its own successful trajectories during the hackathon? You can fine-tune **`nvidia/nemotron-3.5-lightning-30b-a3b`** for just **$0.40 per 1M tokens**!
- **Supported Fine-Tuning Models & Prices**:
  - `nvidia/nemotron-3.5-lightning-30b-a3b` (**$0.40/1M tokens**, 262k context)
  - `meta-llama/Llama-3.1-8B-Instruct`, `qwen/Qwen3-8B`, `qwen/Qwen3.5-9B`, `qwen/Qwen3.5-4B`, `qwen/Qwen3.5-2B` (**$0.40/1M tokens**)
  - `qwen/Qwen3.6-35B-A3B` (**$1.20/1M tokens**)
  - `google/gemma-4-31b-it`, `openai/gpt-oss-20b`, `qwen/Qwen3.8-27B` (**$2.50/1M tokens**)
  - `deepseek-ai/DeepSeek-V4-Flash` (**$5.00/1M tokens**, up to 1M context)
  - `openai/gpt-oss-120b`, `meta-llama/Llama-3.3-70B-Instruct` (**$6.00/1M tokens**)
  - `zai/GLM-5.2-FP8` (**$10.00/1M tokens**)
- **Dataset Format**: `.jsonl` or `.parquet` up to 3 GB (via multipart `/v1/uploads` or `/v1/files`) using standard OpenAI chat format (`{"messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}]}`) or completions format (`{"prompt": "...", "completion": "..."}`). If no validation file is provided, Crusoe automatically holds out 10% for validation.
- **End-to-End Python Fine-Tuning Workflow**:
  ```python
  import os
  from openai import OpenAI

  # Point OpenAI SDK to the Intelligence Foundry management URL!
  foundry = OpenAI(
      base_url="https://api.intelligence.crusoecloud.com/v1",
      api_key=os.environ["CRUSOE_API_KEY"],
  )

  # 1. Upload JSONL training dataset
  with open("agent_trajectories.jsonl", "rb") as f:
      train_file = foundry.files.create(file=f, purpose="fine-tune")
  print("Uploaded File ID:", train_file.id)

  # 2. Launch Serverless Fine-Tuning Job on Nemotron 3.5 Lightning
  job = foundry.fine_tuning.jobs.create(
      model="nvidia/nemotron-3.5-lightning-30b-a3b",
      training_file=train_file.id,
      suffix="recursive-agent-v1",
      method={
          "type": "supervised",
          "supervised": {
              "hyperparameters": {
                  "n_epochs": 3,
                  "lora_rank": 32,
                  "lora_alpha": 64,
                  "use_rslora": True,
              }
          },
      },
  )
  print("Fine-Tuning Job ID:", job.id)

  # 3. Check job status / events / checkpoints
  status = foundry.fine_tuning.jobs.retrieve(job.id)
  print("Status:", status.status, "Fine-tuned Model ID:", status.fine_tuned_model)
  ```
- **Downloading LoRA Weights**: Once complete, you can either deploy the adapter directly to a Self-Serve Deployment or download the `.zip` archive (`adapter_model.safetensors` + `adapter_config.json`) via:
  ```bash
  curl -L "https://api.intelligence.crusoecloud.com/v1/models/$FINE_TUNED_MODEL_ID/download" \
    -H "Authorization: Bearer $CRUSOE_API_KEY" \
    -o adapter.zip
  ```

---

## Part 7: Crusoe CLI & Crusoe Cloud MCP Server

### 7.1 Crusoe CLI (`crusoe`)
Manage VMs, disks, Kubernetes clusters, networking, and monitoring tokens from your terminal:
```bash
# Install on macOS via Homebrew
brew install crusoecloud/cli/crusoe

# Interactive configuration (creates ~/.crusoe/config)
crusoe config init

# Verify authentication & default project
crusoe whoami
crusoe config get default_project

# Useful commands
crusoe locations list
crusoe instance-types list
crusoe compute vms list
crusoe monitoring tokens create
```

### 7.2 Crusoe Cloud MCP Server (`@crusoeai/cloud-mcp`)
Crusoe provides an official **Model Context Protocol (MCP)** server (`@crusoeai/cloud-mcp`) that gives AI coding agents (Claude Code, Cursor, or your own hackathon recursive agents!) direct visibility into your Crusoe Cloud infrastructure:
```bash
# Add to Claude Code
claude mcp add crusoe-cloud -- npx -y @crusoeai/cloud-mcp
```
Or configure in `.mcp.json` / `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "crusoe-cloud": {
      "command": "npx",
      "args": ["-y", "@crusoeai/cloud-mcp"],
      "env": {
        "CRUSOE_ACCESS_KEY_ID": "your-access-key-id",
        "CRUSOE_SECRET_KEY": "your-secret-key"
      }
    }
  }
}
```
- **Capabilities**: Read-only tools to inspect real-time GPU/VM capacities across data centers, list running VMs, disks, VPCs, firewall rules, Crusoe Managed Kubernetes (CMK) clusters, GPU tracking, and project billing/usage.
- **Hackathon Idea**: Equip your recursive infrastructure/DevOps agent with `@crusoeai/cloud-mcp` so it can autonomously inspect cluster state, check GPU availability across regions, and monitor resource health!
