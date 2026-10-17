Cloud

Engineering

[homepage](https://www.crusoe.ai/)

- Crusoe Cloud















AI Cloud Platform

[Cloud Overview](https://www.crusoe.ai/cloud) [Command Center](https://www.crusoe.ai/cloud/command-center) [Crusoe Edge Zones](https://www.crusoe.ai/cloud/edge-zones)









Managed AI

[Managed Inference](https://www.crusoe.ai/cloud/managed-inference) [Serverless Fine-Tuning](https://www.crusoe.ai/cloud/serverless-fine-tuning)









GPUs

[NVIDIA GB200](https://www.crusoe.ai/cloud/gpus/nvidia-gb200) [NVIDIA B200](https://www.crusoe.ai/cloud/gpus/nvidia-b200) [NVIDIA H200](https://www.crusoe.ai/cloud/gpus/nvidia-h200) [NVIDIA H100](https://www.crusoe.ai/cloud/gpus/nvidia-h100) [AMD MI300X](https://www.crusoe.ai/cloud/gpus/amd-mi300x) [AMD MI355X](https://www.crusoe.ai/cloud/gpus/amd-mi355x)









Solutions

[Data Prep](https://www.crusoe.ai/cloud/solutions/data-preparation) [Model Training](https://www.crusoe.ai/cloud/solutions/model-training) [Model Inference](https://www.crusoe.ai/cloud/solutions/model-inference)









Ecosystem

[Cloud Partners](https://www.crusoe.ai/partners)






[Cloud](https://www.crusoe.ai/cloud)
- [Pricing](https://www.crusoe.ai/cloud/pricing)
- AI Infrastructure















[Data Centers](https://www.crusoe.ai/data-centers) [Manufacturing](https://www.crusoe.ai/manufacturing) [Energy](https://www.crusoe.ai/energy)
[Cloud](https://www.crusoe.ai/cloud)
- About















[Company](https://www.crusoe.ai/about/company) [Impact](https://www.crusoe.ai/about/impact) [Communities](https://www.crusoe.ai/about/communities) [Leadership](https://www.crusoe.ai/about/leadership) [Board of Directors](https://www.crusoe.ai/about/board-of-directors)





Careers







[Open Roles](https://www.crusoe.ai/about/careers) [Life at Crusoe](https://www.crusoe.ai/about/careers/culture) [Early Careers](https://www.crusoe.ai/about/careers/early-careers)

- Resources

















[Blog](https://www.crusoe.ai/resources/blog) [Newsroom](https://www.crusoe.ai/resources/newsroom) [Events & Webinars](https://www.crusoe.ai/resources/events) [Learning Hub](https://www.crusoe.ai/resources/learning-hub) [Customers](https://www.crusoe.ai/resources/customers) [Support](https://support.crusoecloud.com/hc/en-us)





Developers







[Developer Hub](https://www.crusoe.ai/developers) [Documentation](https://docs.crusoecloud.com/) [Engineering Blog](https://www.crusoe.ai/resources/blog/engineering)

- [Login](https://console.crusoecloud.com/)



[Login](https://console.crusoecloud.com/)



[Login](https://console.crusoecloud.com/)



[Get started](https://console.crusoecloud.com/request)



[Contact sales](https://www.crusoe.ai/contact-sales)



[Contact sales](https://www.crusoe.ai/contact-sales)



[Talk to us](https://www.crusoe.ai/contact-sales)



[Talk to us](https://www.crusoe.ai/contact-sales)


July 8, 2026

# Frontier Agents at 10x lower cost: NVIDIA Nemotron 3 Ultra + LangChain Deep Agents on Crusoe Managed Inference

Nemotron 3 Ultra pairs with a tuned LangChain Deep Agents harness to match frontier closed-model agent accuracy at roughly a tenth of the cost, and Crusoe Managed Inference plus a native langchain-crusoe integration make it a ten-minute setup.

![Emmanuel Acheampong photo](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/69e67893a754f3e7f54808fe_emmanuel_blogimage.jpg)

Emmanuel Acheampong

Senior Developer Relations Manager

September 3, 2026

![Isometric cloud and server illustration for Crusoe Managed Inference hosting the Nemotron 3 model family](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6a99a1c8596f3794e867c6cd_6a4e646246eff30422dd4a79_used_7_8.avif)

Table of contents

[The gap just closed](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#the-gap-just-closed)

[The numbers behind the headline](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#the-numbers-behind-the-headline)

[Meet Deep Agents: the harness](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#meet-deep-agents-the-harness)

[Meet Nemotron 3 Ultra: the model](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#meet-nemotron-3-ultra-the-model)

[Why Crusoe is the right place to run it](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#why-crusoe-is-the-right-place-to-run-it)

[The walkthrough: a Deep Agent on Crusoe in ten minutes](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#the-walkthrough-a-deep-agent-on-crusoe-in-ten-minutes)

[Prerequisites](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#prerequisites)

[Step 1: Generate a Crusoe API key](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-1-generate-a-crusoe-api-key)

[Step 2: Install the stack](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-2-install-the-stack)

[Step 3: Sanity-check the model](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-3-sanity-check-the-model)

[Step 4: Create the agent](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-4-create-the-agent)

[Step 5: Run a real task](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-5-run-a-real-task)

[Step 6: Tier your models](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#step-6-tier-your-models)

[Taking it to production: the NemoClaw blueprint](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#taking-it-to-production-the-nemoclaw-blueprint)

[Try it](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference#try-it)

Share:

[Twitter share](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference# "Twitter share")[Linkedin share](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference# "Linkedin share")

[Copy URL](https://www.crusoe.ai/resources/blog/nvidia-nemotron-3-ultra-langchain-deep-agents-on-crusoe-managed-inference# "Copy URL")

_NVIDIA's new open flagship, a Deep Agents harness tuned specifically for it, and a first-class `langchain-crusoe` integration. A developer walkthrough for running frontier-class open agents on the Crusoe Intelligence Foundry in about ten minutes._ ‍

## The gap just closed

For the last two years, the honest advice for anyone building a serious agent was uncomfortable: if you wanted frontier-level task completion, you paid frontier closed-model prices. Open models were good, and getting better fast, but the harnesses that turn a model into an agent (the planning loops, the tool schemas, the context management) were tuned for the closed frontier. Open weights ran inside harnesses built for someone else.

That's the gap that closed this week. NVIDIA and LangChain announced that **LangChain Deep Agents has been tuned specifically for NVIDIA Nemotron 3 Ultra**, NVIDIA's new 550B-parameter open flagship. The result, on LangChain's own Deep Agents evaluation suite: **top accuracy among open models, at approximately 10x lower cost per run than leading closed alternatives**. The tuned Nemotron model profile ships directly in Deep Agents, so every developer using the framework can access it today.

And because [Crusoe Managed Inference](https://www.crusoe.ai/cloud/managed-inference) hosts the full Nemotron 3 family on the Intelligence Foundry, and because [langchain-crusoe](https://pypi.org/project/langchain-crusoe/) gives LangChain a native Crusoe integration, the whole stack (open model, open harness, fast inference) is a `pip install` away. This post walks through it.

## The numbers behind the headline

LangChain's team tuned the Deep Agents harness for Nemotron 3 Ultra the way you'd want it done: not by fine-tuning the model, but by **harness engineering**. They ran their evaluation suite against the harness, had an agent analyze the failing cases for root causes, applied changes to prompts, tool descriptions, and middleware, and repeated the loop until the score converged. The model never changed. The scaffolding around it did.

Early results on the 127-example Deep Agents evaluation suite:

- **Nemotron 3 Ultra: 86.6% accuracy**, the top score among open models, ahead of DeepSeek V4 Pro (83.4%) and Kimi K2.6 (82.7%)
- **Roughly 10x lower total cost** than Claude Opus 4.7 on the same suite (about $4 to $5 in tokens for the full run versus roughly $43, based on public pricing), while landing within a couple of points on accuracy

Two things make this result interesting beyond the leaderboard. First, it validates that the quality gap between open and closed models on real agentic work is now small enough that the economics dominate the decision. Second, it demonstrates that the biggest remaining wins in agent performance live in the harness, not the weights. You can extract frontier behavior from an open model by tuning what surrounds it, and that tuning is now upstreamed into Deep Agents itself.

## Meet Deep Agents: the harness

[LangChain Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) is a batteries-included agent harness built on LangGraph. It is the same core tool-calling loop as every other framework, plus the capabilities that make agents reliable on long, messy, real tasks:

- **Planning.** A built-in `write_todos` tool lets the agent decompose work and track progress across many turns.
- **Subagents.** A built-in `task` tool spawns ephemeral subagents with fresh, isolated context. Heavy subtasks stay quarantined and return one compact result.
- **A virtual filesystem.**`ls`, `read_file, write_file, edit_file`, `glob`, and `grep` over pluggable backends, with declarative permission rules.
- **Context management.** Automatic summarization and offloading of large tool results, so long-running work stays inside token limits.
- **Skills and memory.** On-demand domain knowledge via the Agent Skills standard, plus persistent `AGENTS.md`-style memory across sessions.
- **Human-in-the-loop.** Pause for approval on sensitive tool calls with `interrupt_on`.
- **MCP support.** Connect databases, APIs, and file systems through the Model Context Protocol.

Deep Agents is provider-agnostic by design: `create_deep_agent()` accepts any LangChain chat model that can call tools. That's the slot Crusoe plugs into.

## Meet Nemotron 3 Ultra: the model

[Nemotron 3 Ultra](https://developer.nvidia.com/blog/nvidia-nemotron-3-ultra-powers-faster-more-efficient-reasoning-for-long-running-agents/) is a 550B-parameter Mixture-of-Experts model with 55B active parameters, built explicitly for the hard calls in agent workflows: orchestration, long-horizon planning, and synthesis across large contexts. The design choices read like a checklist for agentic inference:

- **Hybrid Mamba-Transformer architecture.** Mamba-2 layers carry long sequences with sub-quadratic scaling; attention layers preserve precise recall.
- **1M-token context**, with leading RULER scores at full length.
- **Post-trained for agent harnesses.** Trained with one of the largest suites of long-running, tool-using datasets, and evaluated for consistency across harnesses rather than single-turn chat.
- **Token efficiency.** On SWE-bench and Terminal-Bench 2.0 it completes tasks with fewer total tokens and fewer tokens per turn, lowering cost to task completion by up to 30%.
- **5x higher throughput** than other open models in its class, helped by NVFP4 precision and multi-token prediction.
- **Actually open.** Weights, training data recipes, and RL environments are released under OpenMDW-1.1, the Linux Foundation's permissive license for open model distributions.

## Why Crusoe is the right place to run it

An open model and a tuned harness still need an inference layer that behaves well under agent workloads: fan-out subagent calls, long accumulated contexts, unattended runs. Three things make Crusoe the natural home for this stack.

**The full Nemotron catalog, day zero.** The [Crusoe Intelligence Foundry](https://console.crusoecloud.com/foundry/models) hosts the Nemotron 3 family end to end: Nemotron 3 Ultra for frontier orchestration, Nemotron 3 Super 120B for mid-tier reasoning, and Nemotron 3 Nano Omni for fast multimodal turns, alongside DeepSeek Gemma, Qwen, Llama, GLM , and others. Crusoe's NVIDIA Cloud Partner status means new Nemotron releases land with day-zero support.

**MemoryAlloy.** Crusoe's cluster-wide KV cache fabric routes requests cache-aware, which is exactly what a Deep Agent needs: the harness re-sends system prompts, skills, and accumulated history on every turn, and cache hits are the difference between a snappy loop and a sluggish one. Crusoe benchmarks up to 9.9x faster time-to-first-token and 5x throughput versus vLLM, and the gap widens as contexts grow.

**A native LangChain integration.** [`langchain-crusoe`](https://pypi.org/project/langchain-crusoe/) provides `ChatCrusoe`, a drop-in LangChain chat model with streaming, async, tool calling, and structured output. No custom endpoint wiring, no OpenAI-compat shims. It's a first-class provider, which means it slots directly into `create_deep_agent()`.

Pricing stays predictable at agent scale: Nemotron 3 Ultra at $1.00 / $3.20 per 1M input/output tokens with cached input at $0.25 per 1M, and Nemotron 3 Nano Omni at $0.30 / $1.83 for the high-volume tier. For a harness that revisits the same context every turn, the cached-token price is the number that actually shapes your bill.

## The walkthrough: a Deep Agent on Crusoe in ten minutes

The shape: generate a Crusoe API key, install two packages, point `ChatCrusoe` at Nemotron 3 Ultra, and hand it to `create_deep_agent()`. The tuned Nemotron profile activates automatically inside Deep Agents.

### Prerequisites

- Python 3.11+
- A [Crusoe Cloud account](https://console.crusoecloud.com/request-foundry)
- Optionally, a search API key (we use Tavily below) for the research example

### Step 1: Generate a Crusoe API key

Sign in to the [Crusoe Cloud console](https://console.crusoecloud.com/), open **Intelligence Foundry → Models**, hit **Get API Key**, give it an alias (e.g. `deep-agents`) and an expiration, and save the key. Crusoe shows it once. While you're there, note the Nemotron 3 Ultra model ID from the catalog.

```javascript
export CRUSOE_API_KEY="cr_..."
```

### Step 2: Install the stack

```javascript
pip install -U deepagents langchain-crusoe
```

Two packages. That's the whole stack: the tuned harness and the Crusoe provider.

### Step 3: Sanity-check the model

```javascript
from langchain_crusoe import ChatCrusoe

llm = ChatCrusoe(model="nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B")
print(llm.invoke("In one sentence: why do open agent stacks matter in 2026?").content)
```

If you get a sensible answer back, Crusoe is wired up. `ChatCrusoe` reads `CRUSOE_API_KEY` from the environment and defaults to Crusoe's API endpoint, so there is nothing else to configure.

### Step 4: Create the agent

Here's a research agent with one custom tool. Everything else (planning, subagents, the filesystem, context management) comes from the harness:

```javascript
import os
from deepagents import create_deep_agent
from langchain_crusoe import ChatCrusoe
from tavily import TavilyClient

tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

def internet_search(query: str, max_results: int = 5) -> dict:
    """Run a web search and return the results."""
    return tavily.search(query, max_results=max_results)

model = ChatCrusoe(
    model="nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    max_tokens=8192,
)

agent = create_deep_agent(
    model=model,
    tools=[internet_search],
    system_prompt=(
        "You are an expert research agent. Plan your work with write_todos, "
        "delegate independent lookups to subagents, and write your final "
        "report to report.md with citations."
    ),
)
```

### Step 5: Run a real task

```javascript
result = agent.invoke(
    {"messages": [{"role": "user", "content":\
        "Produce a one-page brief on hybrid Mamba-Transformer architectures: "\
        "what they are, why they matter for long-context agents, and who is "\
        "shipping them. Cite at least three sources."}]}
)
```

What you'll see: Nemotron 3 Ultra writes itself a todo list, fires `internet_search` calls (fanning independent lookups out to subagents in isolated contexts), synthesizes across the results, and writes `report.md` to the virtual filesystem. This is exactly the workload the model was post-trained for, and exactly the loop LangChain tuned the harness around.

### Step 6: Tier your models

The pattern Crusoe recommends for multi-agent systems is tiered: the frontier reasoner orchestrates, cheap fast models execute. With the full Nemotron family on one endpoint, that's a two-line change:

```javascript
fast = ChatCrusoe(model="nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B")

agent = create_deep_agent(
    model=model,  # Ultra orchestrates
    tools=[internet_search],
    subagents=[{\
        "name": "research-subagent",\
        "description": "Runs one isolated research task and returns a summary.",\
        "system_prompt": "Research the topic you are given. Return a compact, cited summary.",\
        "tools": [internet_search],\
        "model": fast,  # Nano Omni executes\
    }],
)
```

At $0.30 per 1M input tokens on the subagent tier, fan-out gets cheap enough that you stop thinking about it. MemoryAlloy's cache reuse across parallel subagent runs compounds the effect.

## Taking it to production: the NemoClaw blueprint

For teams that want the full reference stack rather than assembling it themselves, NVIDIA's **NemoClaw for LangChain Deep Agents** blueprint packages the three open layers together: Nemotron 3 Ultra (open model), LangChain Deep Agents tuned for Nemotron (open harness), and NVIDIA OpenShell (open secure runtime for executing agent-generated code). With open models, an open harness, and an open runtime, you own the full stack: customize it, govern it, improve it, and run it anywhere, including pointing the model layer at Crusoe through the same `ChatCrusoe`slot.

A few directions worth exploring once the basics run:

- **Add skills and memory.** Package your domain workflows as Agent Skills and persistent `AGENTS.md` memory. The harness loads skills progressively, so your startup context stays compact.
- **Put a human in the loop.**`interrupt_on={"write_file": True}` pauses the agent before any file write for approval. Useful while you build trust in unattended runs.
- **Trace everything.**`langchain-crusoe`has built-in LangSmith support, so every plan, tool call, and subagent handoff is inspectable.
- **Bring your own fine-tune.** Nemotron 3 Ultra ships with LoRA, SFT, and RL recipes through NVIDIA NeMo, and Crusoe Managed Inference supports hosting your own models. Tune for your workflows, host on Crusoe, keep the same agent code.

## Try it

The claim behind this launch is simple: frontier-class agent performance is now an open-stack property, not a closed-API subscription. The pieces:

- [**Crusoe Managed Inference**](https://www.crusoe.ai/cloud/managed-inference) for the model brain. Generate a key in the [Intelligence Foundry](https://console.crusoecloud.com/request-foundry) and you're hitting Nemotron 3 Ultra, Super, and Nano Omni in minutes.
- [**LangChain Deep Agents**](https://docs.langchain.com/oss/python/deepagents/overview) for the harness, with the tuned Nemotron profile built in.
- [**langchain-crusoe**](https://pypi.org/project/langchain-crusoe/) to connect them: `pip install -U deepagents langchain-crusoe`.

If you build something interesting on this stack, we'd love to hear about it. Reach the Crusoe developer community at [devcommunity@crusoe.ai](mailto:devcommunity@crusoe.ai), and follow [Crusoe for Developers on LinkedIn](https://www.linkedin.com/showcase/crusoedev/) and [@crusoedev on X](https://x.com/crusoedev) for new model launches, cookbook drops, and more walkthroughs like this one.

Frontier reasoning from an open model, a harness tuned to extract it, and infrastructure built for agents. At a tenth of the cost, that's not a compromise. That's the better stack.

_Nemotron 3 Ultra is released by_ [_NVIDIA_](https://developer.nvidia.com/nemotron) _. LangChain Deep Agents is open source (_ [_docs_](https://docs.langchain.com/oss/python/deepagents/overview) _). Crusoe Managed Inference is generally available via the_ [_Crusoe Intelligence Foundry_](https://console.crusoecloud.com/foundry/models) _. Benchmark figures reflect LangChain's early performance results on the 127-example Deep Agents evaluation suite; pricing reflects the Crusoe catalog as of July 2026. See_ [_Crusoe's model catalog_](https://docs.crusoecloud.com/managed-inference/overview/) _for current models and prices._

## Latest articles

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6ad1bcab5ad58ef9983a46c4_Tech%20Blog%2026.jpg)

October 16, 2026

Quantized weights, full precision: The math behind 75% cheaper fine-tuning

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6acff212190afd0f99114724_Tech%20Blog%2024.jpg)

October 14, 2026

Crusoe Spark AI factories achieve NVIDIA Exemplar-level performance

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6ac95865e78c365b131471ca_Tech%20Blog%2025.jpg)

October 13, 2026

Crusoe expands NVIDIA DSX collaboration with open-source NVIDIA Run:ai

## Are you ready to build something amazing?

[Contact Us](https://www.crusoe.ai/contact-us)

Subscribe for updates

Thank you for your interest in Crusoe

Crusoe Cloud

[Overview](https://www.crusoe.ai/cloud) [Managed Inference](https://www.crusoe.ai/cloud/managed-inference) [Command Center](https://www.crusoe.ai/cloud/command-center) [Pricing](https://www.crusoe.ai/cloud/pricing)

GPUs

[NVIDIA GB200](https://www.crusoe.ai/cloud/gpus/nvidia-gb200) [NVIDIA B200](https://www.crusoe.ai/cloud/gpus/nvidia-b200) [NVIDIA H200](https://www.crusoe.ai/cloud/gpus/nvidia-h200) [NVIDIA H100](https://www.crusoe.ai/cloud/gpus/nvidia-h100) [AMD MI355x](https://www.crusoe.ai/cloud/gpus/amd-mi355x) [AMD MI300x](https://www.crusoe.ai/cloud/gpus/amd-mi300x)

AI Infrastructure

[Data Centers](https://www.crusoe.ai/data-centers) [Manufacturing](https://www.crusoe.ai/manufacturing) [Energy](https://www.crusoe.ai/energy)

GPUs

[NVIDIA GB200](https://www.crusoe.ai/cloud/gpus/nvidia-gb200) [NVIDIA B200](https://www.crusoe.ai/cloud/gpus/nvidia-b200) [NVIDIA H200](https://www.crusoe.ai/cloud/gpus/nvidia-h200) [NVIDIA H100](https://www.crusoe.ai/cloud/gpus/nvidia-h100) [AMD MI355x](https://www.crusoe.ai/cloud/gpus/amd-mi355x) [AMD MI300x](https://www.crusoe.ai/cloud/gpus/amd-mi300x)

Developers

[Documentation](https://docs.crusoecloud.com/) [Github](https://github.com/crusoecloud) [Cookbook](https://cookbook.crusoe.ai/)

Solutions

[Data Prep](https://www.crusoe.ai/cloud/solutions/data-preparation) [Model Training](https://www.crusoe.ai/cloud/solutions/model-training) [Model Inference](https://www.crusoe.ai/cloud/solutions/model-inference)

About

[Company](https://www.crusoe.ai/about/company) [Leadership](https://www.crusoe.ai/about/leadership) [Impact](https://www.crusoe.ai/about/impact) [Careers](https://www.crusoe.ai/about/careers)

Legal

[Trust Center](https://trust.crusoe.ai/) [Legal Center](https://legal.crusoe.ai/) [Report Abuse](https://ironcladapp.com/public-launch/673f8d97a97bc4d653205e17) [Ethics Helpline](https://secure.ethicspoint.com/domain/media/en/gui/1002889/index.html)

Resources

[Blog](https://www.crusoe.ai/resources/blog) [Newsroom](https://www.crusoe.ai/resources/newsroom) [Customers](https://www.crusoe.ai/resources/customers) [Support](https://support.crusoecloud.com/hc/en-us?gclid=23423jhksjdf) [Learning Hub](https://www.crusoe.ai/resources/learning-hub) [Events & Webinars](https://www.crusoe.ai/resources/events)

2026 Crusoe, Inc, All rights reserved.

[Privacy Policy](https://legal.crusoe.ai/#website-privacy-notice)

Do Not Sell or Share My Personal Information

[Login](https://console.crusoecloud.com/) [Contact us](https://www.crusoe.ai/contact-us) [Cloud Partnerships](https://www.crusoe.ai/partners)

Cookbook

[![Company logo](https://cdn.prod.website-files.com/6855c1aa175582ee23e0aa19/68762899486863fd46acd673_logo-footer.svg)](https://www.crusoe.ai/)

Qualified