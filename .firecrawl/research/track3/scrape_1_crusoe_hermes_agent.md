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


July 20, 2026

# The open agent stack: Running Nous Research’s Hermes Agent on Crusoe Managed Inference

For agents that fan out parallel tool calls and run unattended, cache discipline and tail latency matter more than for a single-shot chatbot. This walkthrough connects Hermes Agent to Crusoe Managed Inference in ten minutes using two environment variables.

![Emmanuel Acheampong photo](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/69e67893a754f3e7f54808fe_emmanuel_blogimage.jpg)

Emmanuel Acheampong

Senior Developer Relations Manager

September 3, 2026

![Isometric cloud, server racks, and storage disks representing Crusoe's managed inference infrastructure.](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6a99a25549cbc7814eb7aea3_6a5e9c2a551368a1d0239874_used_7_20.avif)

Table of contents

[The walkthrough: Hermes Agent on Crusoe in ten minutes](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#the-walkthrough-hermes-agent-on-crusoe-in-ten-minutes)

[Prerequisites](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#prerequisites)

[Step 1: Generate a Crusoe API key](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-1-generate-a-crusoe-api-key)

[Step 2: Sanity-check the endpoint](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-2-sanity-check-the-endpoint)

[Step 3: Install Hermes Agent](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-3-install-hermes-agent)

[Step 4: Wire Hermes to Crusoe](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-4-wire-hermes-to-crusoe)

[Step 5: Choose your models](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-5-choose-your-models)

[Step 6: Run a real task](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-6-run-a-real-task)

[Step 7: Let the Curator loose](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#step-7-let-the-curator-loose)

[Where to take it from here](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#where-to-take-it-from-here)

[Try building on it](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference#try-building-on-it)

Share:

[Twitter share](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference# "Twitter share")[Linkedin share](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference# "Linkedin share")

[Copy URL](https://www.crusoe.ai/resources/blog/running-nous-researchs-hermes-agent-on-crusoe-managed-inference# "Copy URL")

Crusoe isn’t the only place to run open models. But for an agent that fans out parallel tool calls, holds long contexts, and runs unattended on a schedule, the inference layer’s cache discipline and tail latency matter more than they do for a single-shot chatbot, and that’s where Crusoe’s design choices pay off.

## The walkthrough: Hermes Agent on Crusoe in ten minutes

Here’s the plan: install Hermes locally, generate a Crusoe API key, point Hermes’ OpenAI-compatible provider slot at Crusoe, pick a default model and an auxiliary fast model, and run a real task.

## Prerequisites

- Linux, macOS, or Windows under WSL2. Native Windows isn’t supported by Hermes.
- Python 3.11+ (Hermes’ installer handles this on most systems).
- A [Crusoe Cloud account](https://console.crusoecloud.com/request-foundry).

## Step 1: Generate a Crusoe API key

Sign in to the [Crusoe Cloud console](https://console.crusoecloud.com/) and open the Intelligence Foundry → Models tab. Hit Get API Key, give it an alias (e.g. hermes-agent) and an expiration date, and click Create. Save the key somewhere safe; Crusoe shows it only once.

While you’re there, browse the model catalog. Note these two model IDs; we’ll use them in a moment:

- moonshotai/Kimi-K2.6: 256K context, modified MIT license, our heavy-reasoning workhorse for agentic tool use.
- nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B: multimodal MoE with ~3B active parameters, 262K context, our fast-and-cheap default.

## Step 2: Sanity-check the endpoint

Before configuring Hermes, confirm your key works against the OpenAI-compatible endpoint with a one-liner. This is the same surface Hermes will be using:

```javascript
export CRUSOE_API_KEY="cr_..."   # paste your key

python - <<'PY'
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["CRUSOE_API_KEY"],
    base_url="https://api.inference.crusoecloud.com/v1",
```

```javascript
)

resp = client.chat.completions.create(
    model="nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B",
    messages=[\
        {"role": "system", "content": "You are a concise assistant."},\
        {"role": "user", "content": "In one sentence: why is open-source agent infrastructure interesting in 2026?"},\
    ],
)
print(resp.choices[0].message.content)
```

If you get a sensible answer back, you’re done with the platform setup. The same `base_url` and `api_key` will be the only Crusoe-specific values Hermes needs.

## Step 3: Install Hermes Agent

One line, taken straight from [the official docs](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart):

```javascript
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc      # or ~/.zshrc
```

The installer handles Python, uv, the virtualenv, and a ~/.local/bin/hermes shim. Verify:

```javascript
hermes --version
hermes doctor          # diagnoses any environment issues
```

## Step 4: Wire Hermes to Crusoe

Hermes Agent supports any OpenAI-compatible endpoint. The cleanest way to point it at Crusoe is to set the OpenAI provider slot’s base URL and API key, then pick the model interactively.

Add the following to your shell config (`~/.bashrc` or `~/.zshrc`):

```javascript
# Crusoe Managed Inference, exposed via the OpenAI-compatible slot
export OPENAI_API_KEY="cr_..."   # your Crusoe key from Step 1
export OPENAI_BASE_URL="https://api.inference.crusoecloud.com/v1
```

Then run the setup wizard, which asks where to send LLM calls:

```javascript
hermes setup
```

When prompted for a provider, pick **OpenAI** (the OpenAI-compatible custom-endpoint slot). Hermes will pick up the `OPENAI_BASE_URL` and route requests to Crusoe.

## Step 5: Choose your models

Hermes lets you pick two models: a primary model for the main agent loop, and an auxiliary model used by the Curator and other background skills. A good split for a Crusoe-backed Hermes:

- Primary: moonshotai/Kimi-K2.6: 256K context, built for agentic tool use. Good for agent loops that plan, decompose, and synthesize across long histories.
- Auxiliary: nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B: fast, cheap, and multimodal. Handles skill grading, classification, and quick tool-call decisions.

Set them with the interactive picker:

```javascript
hermes model
```

\# When prompted: provider = openai, model = moonshotai/Kimi-K2.6

```javascript
hermes config set auxiliary.curator.model nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B
hermes config set auxiliary.curator.provider openai
```

(The auxiliary.curator slot is the one v0.12.0 introduced for the Autonomous Curator. Pick its model in hermes model or set it directly as above.)

## Step 6: Run a real task

Start the CLI:

```javascript
hermes
```

Try a task that exercises planning, tool use, and a side artifact. Paste this in:

“I’d like a one-page brief on NVIDIA Nemotron 3 Nano Omni: what it is, what it’s good at, and what makes it different from other open multimodal models. Use web search, cite at least three sources, and save the result as nemotron-brief.md in this directory. Then summarize what you wrote in five bullet points.”

What you’ll see:

1. Kimi K2.6 plans the task, likely something like (1) search for primary sources, (2) read the top results, (3) draft, (4) save, (5) summarize.
2. Hermes’ built-in web search and file-write tools fire in sequence; the streaming tool output lands in your terminal.
3. A markdown file appears on disk.
4. You get a five-bullet summary in the chat.

Try a follow-up that proves the memory loop works:

“Tomorrow I’d like a similar brief on GLM 5.2. Remember the format and citation style you used here.”

Hermes will write itself a skill or memory note. The next time you ask, it’ll skip the format-figuring step and go straight to the work.

## Step 7: Let the Curator loose

You don’t invoke the Curator directly; it runs in the background once your gateway is up. To see it in action:

```javascript
hermes gateway start            # starts the cron ticker

# After your agent has built up a few skills (run several tasks), check on the Curator:
hermes curator status           # ranks skills by usage
cat ~/.hermes/logs/curator/REPORT.md   # latest curator report
```

By default the Curator runs every 7 days, grades your skills against a rubric using your auxiliary model (Nemotron 3 Nano Omni in our config), consolidates near-duplicates, and prunes dead ones. You can tune the cycle, the model, and the gates from the dashboard.

## Where to take it from here

The walkthrough is the minimum viable setup. A few directions worth exploring once it’s running:

Move the gateway off your laptop. Hermes is designed to live on a $5 VPS or a cloud VM, with you talking to it from Telegram or Slack. Run hermes gateway setup, point it at your messaging platform of choice, and your agent persists when your laptop sleeps. The Modal and Daytona terminal backends work well for serverless persistence: your agent’s environment hibernates when idle and wakes on demand.

Mix models per turn. Use /model mid-conversation to switch between Kimi K2.6 for hard agentic reasoning, GLM 5.2 for long-context synthesis, Nemotron 3 Nano Omni for multimodal turns (it ingests images, video, and audio natively), and Nemotron 3 Nano 30B for cheap high-volume classification. This is the tiered-architecture pattern Crusoe describes for multi-agent systems, and Hermes’ hermes model flow makes it a one-keystroke change.

Fan out with subagents. For tasks that benefit from parallelism (researching ten companies at once, processing a directory of files), Hermes’ isolated subagents each get their own conversation, terminal, and Python RPC scripts. Combined with Crusoe’s MemoryAlloy KV-cache reuse, parallel subagent runs cost far less than re-running the planner from scratch.

Build skills for your stack. The skill system is where you’ll get the most leverage over time. Every non-trivial workflow you do twice should become a skill. The Curator maintains the library for you.

**Bring your own fine-tune.** Crusoe Managed Inference [supports bringing your own model](https://www.crusoe.ai/resources/blog/building-the-worlds-favorite-ai-cloud), trained from scratch or fine-tuned from an open base. If you’ve trained Hermes’ tool schemas into a custom model, you can host it on Crusoe and point Hermes at it through the same OpenAI-compatible slot. Same code, your weights.

## Try building on it

The full stack (open agent, open weights, fast inference) is now cohesive enough to build on without the compromises that come with closed setups. The two pieces:

- [Crusoe Managed Inference](https://www.crusoe.ai/cloud/managed-inference) for the model brain. Generate an API key in the [Intelligence Foundry](https://console.crusoecloud.com/request-foundry) and you’re hitting Nemotron 3, Kimi K2.6, GLM 5.2, and the rest of the catalog in minutes.
- [Hermes Agent](https://hermes-agent.nousresearch.com/) for the agent itself. Install with one curl, run hermes setup, point the OpenAI provider at Crusoe.


If you build something interesting on this stack, we’d love to hear about it. Reach the Crusoe developer community at [devcommunity@crusoe.ai](mailto:devcommunity@crusoe.ai) with anything inference-related, and follow [Crusoe for Developers on LinkedIn](https://www.linkedin.com/showcase/crusoedev/) and [@crusoedev on X](https://x.com/crusoedev) for new model launches, cookbook drops, and more walkthroughs like this one.

An agent that improves as it runs, on infrastructure built for that workload.

‍

_Hermes Agent is MIT-licensed and built by_ [_Nous Research_](https://nousresearch.com/) _. Crusoe Managed Inference is generally available via the_ [_Crusoe Intelligence Foundry_](https://console.crusoecloud.com/foundry/models) _. Model availability and pricing referenced in this post reflect the catalog as of July 2026; see Crusoe’s model catalog for the current list._

## Latest articles

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6acff212190afd0f99114724_Tech%20Blog%2024.jpg)

October 14, 2026

Crusoe Spark AI factories achieve NVIDIA Exemplar level performance

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6ac95865e78c365b131471ca_Tech%20Blog%2025.jpg)

October 13, 2026

Crusoe expands NVIDIA DSX collaboration with open-source NVIDIA Run:ai

![Chase Lochmiller - Co-founder, CEO](https://cdn.prod.website-files.com/6863cc86499b79ce3ab28f8b/6ac860b78c8a6f98f2501645_Tech%20Blog%2036.png)

October 9, 2026

How green is Crusoe's inference engine?

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