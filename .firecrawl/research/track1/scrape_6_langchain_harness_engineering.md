[home](https://www.langchain.com/)

Products

[LangSmith Platform](https://www.langchain.com/langsmith-platform)

Agent Improvement

[![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6a1c6031b3db015796401c5b_4e8060f75e16b02daa59026cbae4bc8f_LangSmith%20Engine_Icon_light%201.svg)\\
\\
Engine\\
\\
Improve agents autonomously](https://www.langchain.com/langsmith/engine) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c024180a65887312dd40_Frame%202147254707.svg)\\
\\
Observability\\
\\
See exactly what your agents are doing](https://www.langchain.com/langsmith/observability) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c0247f235ca5583fa63b_Frame%202147255166.svg)\\
\\
Evaluation\\
\\
Score and improve agent performance](https://www.langchain.com/langsmith/evaluation)

Agent Infrastructure

[![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c024926f877c1de6e728_updated.svg)\\
\\
Deployment\\
\\
Ship and scale agents in production](https://www.langchain.com/langsmith/deployment) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6a020888f9b2346912c07f41_sandboxes_light_mode%202.svg)\\
\\
Sandboxes\\
\\
Run agent-generated code safely](https://www.langchain.com/langsmith/sandboxes) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6a6aaa79189ca58233362fc0_LangSmith%20LLM%20Gateway_icon_dark%20mode.png)\\
\\
LLM Gateway\\
\\
Control agent model calls](https://www.langchain.com/langsmith/llm-gateway)

No-Code Agents

[![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69baea024a5f7c2d229815b0_LangSmith%20Fleet_icon_light%20mode%203.svg)\\
\\
Fleet\\
\\
Agents for the whole company](https://www.langchain.com/langsmith/fleet)

[Open Source](https://www.langchain.com/oss-overview)

Agent Frameworks

[![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c02453d869396317aaa3_updated-1.svg)\\
\\
deepagents\\
\\
Build long-running agents for complex tasks](https://www.langchain.com/deep-agents) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c024c2d98286a8fb058f_Frame%202147255166-1.svg)\\
\\
langgraph\\
\\
Build agents with low-level control](https://www.langchain.com/langgraph) [![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/6989c024409fcfc7e5b8f78f_Frame%202147254707-1.svg)\\
\\
langchain\\
\\
Quick start agents with any model provider](https://www.langchain.com/langchain)

Learn

Resources

[Blog](https://www.langchain.com/blog) [Customer Stories](https://www.langchain.com/customers) [Guides](https://www.langchain.com/resources) [Max Agency](https://www.youtube.com/playlist?list=PLfaIDFEXuae3UwB1QGEjsRAr8BzCQss7s)

How-To

[LangChain Academy](https://academy.langchain.com/) [YouTube](https://www.youtube.com/@LangChain) [Documentation](https://docs.langchain.com/)

Community

[LangSmith for Startups](https://www.langchain.com/startups) [Meetups](https://luma.com/langchain?k=c) [Community](https://www.langchain.com/community)

[Docs](https://docs.langchain.com/)

Company

[About](https://www.langchain.com/about) [Careers](https://www.langchain.com/careers) [Partners](https://www.langchain.com/langchain-partner-network) [Events](https://www.langchain.com/events)

[Pricing](https://www.langchain.com/pricing)

[Try LangSmith](https://smith.langchain.com/) [Get a demo](https://www.langchain.com/contact-sales)

[Try LangSmith](https://smith.langchain.com/)

[Get a demo](https://www.langchain.com/contact-sales)

[Deep Agents](https://www.langchain.com/blog?category_equal=%5B%22Deep+Agents%22%5D)

[Observability & Evals](https://www.langchain.com/blog?category_equal=%5B%22Observability+%26+Evals%22%5D)

[Agent Architecture](https://www.langchain.com/blog?category_equal=%5B%22Agent+Architecture%22%5D)

# Improving Deep Agents with harness engineering

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69dcefac505b6b48827abf84_vivek-trivedy.png)

Vivek Trivedy

February 17, 2026

![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69ce2c533137196179bae949_Icon-7.svg)

8

min

[Go back to blog](https://www.langchain.com/blog)

[The Goal of Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#the-goal-of-harness-engineering)

[Experiment Setup & The Knobs on a Harness](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#experiment-setup-and-the-knobs-on-a-harness)

[The Knobs we can Turn](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#the-knobs-we-can-turn)

[The Trace Analyzer Skill](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#the-trace-analyzer-skill)

[What Actually Improved Agent Performance](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#what-actually-improved-agent-performance)

[Build & Self-Verify](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#build-and-self-verify)

[Giving Agents Context about their Environment](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#giving-agents-context-about-their-environment)

[Encouraging Agents to Step Back & Reconsider Plans](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#encouraging-agents-to-step-back-and-reconsider-plans)

[Choosing How Much Compute to Spend on Reasoning](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#choosing-how-much-compute-to-spend-on-reasoning)

[Practical Takeaways for Building Agent Harnesses](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering#practical-takeaways-for-building-agent-harnesses)

Share

TLDR: Our coding agent went from Top 30 to Top 5 on [Terminal Bench 2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0?ref=blog.langchain.com). We only changed the harness. Here’s our approach to harness engineering (teaser: self-verification & tracing help a lot).

## The Goal of Harness Engineering

The goal of a harness is to mold the inherently spiky intelligence of a model for tasks we care about. **Harness Engineering** is about systems, you’re building tooling around the model to optimize goals like task performance, token efficiency, latency, etc. Design decisions include the system prompt, tool choice, and execution flow.

But how should you change the harness to improve your agent?

At LangChain, we use [Traces](https://docs.langchain.com/langsmith/observability-quickstart?ref=blog.langchain.com) to understand agent failure modes at scale. Models today are largely black-boxes, their inner mechanisms are hard to interpret. But we can see their inputs and outputs in text space which we then use in our improvement loops.

We used a simple recipe to iteratively improve [deepagents-cli](https://github.com/langchain-ai/deepagents/tree/main/libs/code) (our coding agent) `13.7 points` from `52.8` to `66.5` on Terminal Bench 2.0. We only tweaked the harness and kept the model fixed, `gpt-5.2-codex`.

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69cba9e8e691fa7cd1fac872_Screenshot-2026-02-12-at-12.25.20---PM.png)

## Experiment Setup & The Knobs on a Harness

We used [Terminal Bench 2.0](https://www.tbench.ai/?ref=blog.langchain.com), a now standard benchmark to evaluate agentic coding. It has 89 tasks across domains like machine learning, debugging, and biology. We use [Harbor](https://harborframework.com/?ref=blog.langchain.com) to orchestrate the runs. It spins up sandboxes ( [Daytona](https://www.daytona.io/?ref=blog.langchain.com)), interacts with our agent loop, and runs verification + scoring.

Every agent action is stored in [LangSmith](https://smith.langchain.com/?ref=blog.langchain.com). It also includes metrics like latency, token counts, and costs.

### **The Knobs we can Turn**

An agent harness has a lot of knobs: system prompts, tools, hooks/middleware, skills, sub-agent delegation, memory systems, and more. We deliberately compress the optimization space and focus on three: **System Prompt, Tools,** and [**Middleware**](https://docs.langchain.com/oss/python/langchain/middleware/overview?ref=blog.langchain.com#the-agent-loop) (our term for hooks around model and tool calls).

We start with a default prompt and standard tools+middleware. This scores 52.8% with GPT-5.2-Codex. A solid score, just outside the Top 30 of the leaderboard today, but room to grow.

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69cba9e9e691fa7cd1fac8a9_Screenshot-2026-02-16-at-12.50.00---PM.png)

### **The Trace Analyzer Skill**

We wanted trace analysis to be repeatable so we made it into an Agent Skill. This serves as our recipe to **analyze errors across runs and make improvements to the harness**. The flow is:

1. Fetch experiment traces from LangSmith
2. Spawn parallel error analysis agents → main agent synthesizes findings + suggestions
3. Aggregate feedback and make targeted changes to the harness.

This works similarly to [boosting](https://en.wikipedia.org/wiki/Boosting_(machine_learning)?ref=blog.langchain.com) which focuses on mistakes from previous runs. A human can be pretty helpful in Step 3 (though not required) to verify and discuss proposed changes. Changes that overfit to a task are bad for generalization and can lead to regressions in other Tasks.

Automated trace analysis saves hours of time and made it easy to quickly try experiments. We’ll be publishing this skill soon, we’re currently testing it for prompt optimization generally.

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69cba9eae691fa7cd1fac8d6_langsmith_trace_analyzer_skill.png)

## What Actually Improved Agent Performance

Automated Trace analysis allowed us to [debug where agents were going wrong](https://www.langchain.com/conceptual-guides/agent-observability-powers-agent-evaluation?ref=blog.langchain.com). Issues included reasoning errors, not following task instructions, missing testing and verification, running out of time, etc. We go into these improvements in more details in the sections below.

### Build & Self-Verify

Today’s models are exceptional self-improvement machines.

**Self-verification allows agents to self-improve via feedback within a run**. However, they don’t have a natural tendency to enter this **build-verify loop.**

The most common failure pattern was that the agent wrote a solution, re-read its own code, confirmed it looks ok, and stopped. Testing is a key part of autonomous agentic coding. It helps test for overall correctness and simultaneously gives agents signal to hill-climb against.

We added guidance to the system prompt on how to approach problem solving.

1. **Planning & Discovery:** Read the task, scan the codebase, and build an initial plan based on the task specification and how to verify the solution.
2. **Build:** Implement the plan with verification in mind. Build tests, if they don’t exist and test both happy paths and edge cases.
3. **Verify:** Run tests, read the full output, compare against what was asked (not against your own code).
4. **Fix:** Analyze any errors, revisit the original spec, and fix issues.

We really focus on testing because it powers the changes in every iteration. We found that alongside prompting, deterministic context injection helps agents verify their work. We use a `PreCompletionChecklistMiddleware` that intercepts the agent before it exits and reminds it to run a verification pass against the Task spec. This is similar to a [Ralph Wiggum Loop](https://ghuntley.com/loop/?ref=blog.langchain.com) where a hook forces the agent to continue executing on exit, we use this for verification.

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69cba9e9e691fa7cd1fac8c3_self-verification-loop.png)

### Giving Agents Context about their Environment

Part of harness engineering is **building a good delivery mechanism for context engineering.** Terminal Bench tasks come with directory structures, built-in tooling, and strict timeouts.

1. **Directory Context & Tooling:** A `LocalContextMiddleware` runs on agent start to map the `cwd` and other parent+children directories. We run `bash` commands to find tools like `Python` installations. Context discovery and search are error prone, so injecting context reduces this error surface and helps **onboard the agent into its environment.**
2. **Teaching Agents to Write Testable Code:** Agents don’t know how their code needs to be testable. We add prompting say their work will be measured against programatic tests, similar to when committing code. For example, Task specs that mention file paths should be followed exactly so the solutions works in an automated scoring step. Prompting that stresses edge-cases helps the agent avoid only checking “happy path” cases. Forcing models to conform to testing standards is a powerful strategy to avoid “slop buildup” over time.
3. **Time Budgeting:** We inject time budget warnings to nudge the agent to finish work and shift to verification. Agents are famously bad at time estimation so this heuristic helps in this environment. Real world coding usually doesn’t have strict time limits, but without adding any knowledge of constraints, agents won’t work within time bounds.

The more that agents know about their environment, constraints, and evaluation criteria, the better they can autonomously self-direct their work.

**The purpose of the harness engineer: prepare and deliver context so agents can autonomously complete work.**

### Encouraging Agents to Step Back & Reconsider Plans

Agents can be myopic once they’ve decided on a plan which results in “doom loops” that make small variations to the same broken approach (10+ times in some traces).

We use a `LoopDetectionMiddleware` that tracks per-file edit counts via tool call hooks. It adds context like “…consider reconsidering your approach” after `N` edits to the same file. This can help agents recover from doom loops, though the model can continue down the same path if it thinks it’s correct.

Important note. This is a design heuristic that engineers around today’s perceived model issues. As models improve, these guardrails will likely be unnecessary, but today helps agents execute correctly and autonomously.

### Choosing How Much Compute to Spend on Reasoning

Reasoning models can run autonomously for hours so we have to decide how much compute to spend on every subtask. You can use the max reasoning budget on every task, but most work can benefit from optimizing reasoning compute spend.

Terminal Bench timeout limits create a tradeoff. More reasoning helps agents evaluate each step, but can burn over `2x` more tokens/time. `gpt-5.2-codex` has 4 reasoning modes, `low`, `medium`, `high`, and `xhigh`.

We found that reasoning helps with planning to fully understand the problem, some Terminal Bench tasks are very difficult. A good plan helps get to a working solution more quickly.

Later stage verification also benefits from more reasoning to catch mistakes and get a solution submitted. As a heuristic, we choose a xhigh-high-xhigh " **reasoning sandwich**" as a baseline.

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69cba9e9e691fa7cd1fac8bd_the-reasoning-sandwich.png)

_Spending more reasoning compute on planning and verification_

Running only at `xhigh` scored poorly at `53.9%` due to agent timeouts compared to `63.6%` at `high`. There weren’t large differences in trial runs across reasoning budget splits so we stuck with our approach which pushed the score to `66.5%`.

The natural approach for models is **Adaptive Reasoning,** seen with [Claude](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking?ref=blog.langchain.com) and [Gemini](https://ai.google.dev/gemini-api/docs/thinking?ref=blog.langchain.com) models where the model decides how much compute to spend on reasoning.

In a multi-model harness, balancing reasoning budgets could play out as using a large model for planning and [handing off](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs?ref=blog.langchain.com) to a smaller model for implementation.

## Practical Takeaways for Building Agent Harnesses

The design space of agents is big. Here are some general principles from our experiments and building deepagents overall.

1. **Context Engineering on Behalf of Agents.** Context assembly is still difficult for agents today, especially in unseen environments. Onboarding models with context like directory structures, available tools, coding best practices, and problem solving strategies helps reduce the error surface for poor search and avoidable errors in planning.
2. **Help agents self-verify their work.** Models are biased towards their first plausible solution. Prompt them aggressively to verify their work by running tests and refining solutions. This is especially important in autonomous coding systems that don’t have humans in the loop.
3. **Tracing as a feedback signal.** Traces allow agents to self-evaluate and debug themselves. It’s important to debug tooling and reasoning together (ex: models go down wrong paths because they lack a tool or instructions how to do something).
4. **Detect and fix bad patterns in the short term.** Models today aren’t perfect. The job of the harness designer is to design around today’s shortcomings while planning for smarter models in the future. Blind retries and not verifying work are good examples. These guardrails will almost surely dissolve over time, but to build robust agent applications today, they’re useful tools to experiment with.
5. **Tailor Harnesses to Models. T** he [Codex](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide/?ref=blog.langchain.com) and [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices?ref=blog.langchain.com) prompting guides show that models require different prompting. A test run with Claude Opus 4.6 scored `59.6%` with an earlier harness version, competitive but worse than Codex because we didn’t run the same Improvement Loop with Claude. Many principles generalize like good context preparation and a focus on verification, but running a few rounds of harness iterations for your task helps maximize agent performance across tasks.

There’s more open research to do in harness design. Interesting avenues include multi-model systems (Codex, Gemini, and Claude together), memory primitives for continual learning so agents can autonomously improve on tasks, and measuring harness changes across models.

For the outer loop of improving agents, we’re looking at methods like [RLMs](https://alexzhang13.github.io/blog/2025/rlm/?ref=blog.langchain.com) to more efficiently mine traces. We’ll be continuing work to improve the harness and openly share our research.

We created [a dataset of our Traces](https://smith.langchain.com/public/29393299-8f31-48bb-a949-5a1f5968a744/d?tab=2&ref=blog.langchain.com) to share with the community.

Deep Agents is open source. [Python](https://github.com/langchain-ai/deepagents?ref=blog.langchain.com) and [Javascript](https://github.com/langchain-ai/deepagentsjs?ref=blog.langchain.com).

**To more hill climbing and open research.**

### Related content

![The most common questions about agent evals, answered](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6ac98333d970ebc162805c63_agent-evals-faq-cover-1200x675.png)

Observability & Evals

LangSmith

#### The Most Common Questions About Agent Evals, Answered

![Divya Santhanam](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6ac97dfca101bc80e9f2d64d_divya-santhanam.png)

Divya Santhanam

October 15, 2026

![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69cd1fd0002272ce39bf1241_Icon-6.svg)

min

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6ac6d12e05f73fc9690266a8_dark-74%20characters%20max.png)

Deep Agents

Conceptual Guide

#### Context Engineering: How Deep Agents Remember

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6acfb8492227373b922e7719_Screenshot%202026-10-14%20at%2010.12.17%E2%80%AFAM.png)

Jess Weng

October 14, 2026

![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69cd1fd0002272ce39bf1241_Icon-6.svg)

10

min

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6acd66ed592eea4558483d0f_Search%20agent%20traces%20by%20behavior%20with%20AI%20Search%20in%20LangSmith-blog.png)

Observability & Evals

#### Search agent traces by behavior with AI Search in LangSmith

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6ace2c2d4c7a9a78b091a4ff_A.%20Natarajan.jpg)

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/69dd146b49c3ff6f8c05da14_Eugene-Yurtsev%201.png)

![](https://cdn.prod.website-files.com/65c81e88c254bb0f97633a71/6ac988a9cdcd2c5147321cb0_Suraj%20Vathsa.png)

A. Natarajan,

E. Yurtsev,

S. Vathsa

October 13, 2026

![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69cd1fd0002272ce39bf1241_Icon-6.svg)

7

min

![](https://cdn.prod.website-files.com/65b8cd72835ceeacd4449a53/69ce01ea562f8cc223cabf25_Frame%202147254328.svg)

Sign up for our newsletter to stay up to date

Thank you! Your submission has been received!

Oops! Something went wrong while submitting the form.

### S    e    e        w    h    a    t        y    o    u    r        a    g    e    n    t        i    s        r    e    a    l    l    y        d    o    i    n    g

LangSmith, our agent engineering platform, helps developers debug every agent decision, eval changes, and deploy in one click.

[Try LangSmith](https://smith.langchain.com/) [Get a demo](https://www.langchain.com/contact-sales)

###### Products

[LangSmith Platform](https://www.langchain.com/langsmith-platform) [LangSmith Observability](https://www.langchain.com/langsmith/observability) [LangSmith Evaluation](https://www.langchain.com/langsmith/evaluation) [LangSmith Deployment](https://www.langchain.com/langsmith/deployment) [LangSmith Fleet](https://www.langchain.com/langsmith/fleet) [LangSmith Sandboxes](https://www.langchain.com/langsmith/sandboxes) [Deep Agents](https://www.langchain.com/deep-agents) [Deep Agents Code](https://www.langchain.com/dcode) [LangChain](https://www.langchain.com/langchain) [LangGraph](https://www.langchain.com/langgraph)

###### Resources

[Blog](https://www.langchain.com/blog) [Customer Stories](https://www.langchain.com/customers) [Guides](https://www.langchain.com/resources) [Community](https://www.langchain.com/join-community) [Changelog](https://changelog.langchain.com/) [Docs](https://docs.langchain.com/) [Support](https://support.langchain.com/) [LangChain Academy](https://academy.langchain.com/)

###### Company

[About](https://www.langchain.com/about) [Careers](https://www.langchain.com/careers) [Partners](https://www.langchain.com/langchain-partner-network) [Trust Center](https://trust.langchain.com/) [Brand Assets](https://www.langchain.com/brand-assets)

[Events](https://www.langchain.com/events)

###### Sign up for our newsletter to stay up to date

Thank you! Your submission has been received!

Oops! Something went wrong while submitting the form.

[All systems operational](https://status.smith.langchain.com/)

[Privacy policy](https://www.langchain.com/privacy-policy) [Terms of service](https://www.langchain.com/terms-of-service)

Qualified