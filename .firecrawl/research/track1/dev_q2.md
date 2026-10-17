## [doc:https://www.langchain.com/blog/introducing-open-swe-an-open-source-asynchronous-coding-agent] (doc) Introducing Open SWE: An Open-Source Asynchronous Coding Agent
# Introducing Open SWE: An Open-Source Asynchronous Coding Agent
Open SWE operates like another engineer on your team: it can research a codebase, create a detailed execution plan, write code, run tests, review its own work for errors, and open a pull request when it's finished.

Today, we're excited to share it with the community.

### How It Works: The Agent Architecture
Open SWE operates using three specialized LangGraph agents that work in sequence: a Manager, a Planner, and a Programmer (which contains a sub-agent Reviewer).

Once the Reviewer approves the work, Open SWE generates a final conclusion, opens a pull request, and marks the task as complete.

### Related content
LangSmith

## [doc:https://www.openhands.dev/blog/20260506-the-verification-stack] (doc) Get useful insights in our blog
## The agent-level verifier: OpenHands critic model
The critic model is a verifier that runs while the agent is still working, before any code is pushed. As the agent takes actions, the model scores how likely the run is to succeed.

## The repo-level verifier: OpenHands code review & QA agent
### The code review skill
- **Testing gaps** — rejects mock-only tests; requires tests that exercise real code paths and assert on outputs

## Bring the full verification stack into your workflow
It has two complementary layers: the agent-level critic catches broken agent runs before code is pushed, while the repo-level verifier reviews and tests pull requests inside your normal development workflow.

**Layer 1 — Agent-level verification.** The critic model is available in OpenHands Cloud and Agent Canvas today. In Settings, open the **Verification** tab, turn on **Enable Critic**, and save.

If you’re deploying OpenHands in a team setting and want to bring this verification stack into your workflow, we’d love to hear from you. Contact us and we can help you set up the right combination of critic, code review, QA, and automations for your repositories.

## [doc:https://www.openhands.dev/blog/20260305-learning-to-verify-ai-generated-code] (doc) Get useful insights in our blog
The real bottleneck is **verification**: checking that a change is correct, follows repo conventions, and is something your team can trust, review, and merge.

In OpenHands, we think of this as a **verification stack**: a layered set of verifiers that helps coding agents fail fast and produce changes humans can confidently merge.

## What this critic does
The critic scores an agent's **trajectory** (conversation, tool calls, and actions). You can use it to decide whether to continue, stop, or refine; to pick among multiple attempts; and to collect lightweight feedback that improves the agent over time.

Critic model scoring diagram

## Try it today
### OpenHands SDK
The critic is integrated into the OpenHands Software Agent SDK, so you can call it programmatically and use the score in your own loops (e.g., reranking, early stopping, iterative refinement).

## What's next
If you're deploying OpenHands in a team setting and want critic-based verification wired into your workflow (policy checks, custom thresholds, feedback pipelines), reach out—we're happy to help.

Citation

# Get useful insights in our blog
### Thank you for your submission!
© 2026 OpenHands - All rights reserved

## [doc:https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model] (doc) Get useful insights in our blog
## SWE-Bench and OpenHands
to verify they have appropriately scoped unit tests and well-specified issue descriptions.

## Building a Better Critic
For the training process, we:

r∗t=γr∗t+1r*t = \gamma r*{t+1}r∗t=γr∗t+1

The process starts with the final reward r∗Tr*Tr∗T which is determined by running the unit tests on the completed solution - 1 for passing all tests and 0 for failing. We use γ=0.99\gamma=0.99γ=0.99.

## Try OpenHands Today
Besides being state-of-the-art on SWE-Bench Verified, OpenHands is also a top-performing agent on LiveSWEBench, a contamination-free benchmark for AI software engineers.

Citation

# Get useful insights in our blog
### Thank you for your submission!
© 2026 OpenHands - All rights reserved

## [issue:openhands/software-agent-sdk#1704] (issue) Interleave codereview-roasted with agent task: add critic-agent model that reviews git diff and returns pass/fail#1704
https://github.com/openhands/software-agent-sdk/issues/1704
License: MIT
# Interleave codereview-roasted with agent task: add critic-agent model that reviews git diff and returns pass/fail\#1704

## Description

xingyaoww

Summary

Implement a new “critic model” that spins up another OpenHands agent to perform codereview-roasted style reviews during development and in PRs. The critic agent receives a git diff (and PR context), produces a structured PR review (markdown) and returns an explicit decision: pass or not pass. This enables interleaving generator-agent work with a dedicated reviewer, similar to the approach in PR #1269.

Motivation

- Multiple iterations of agent code changes followed by codereview-roasted have been very effective at polishing PRs.
- We want a first-class mechanism to interleave “make changes” and “review” loops with a clear gate (pass/fail) and a single, final review comment to reduce PR noise.

Goals

- Add a new critic-agent model that:
  - Is initialized as a standard OpenHands agent (configurable LLM, tools, prompt).
  - Accepts repo path + git diff + PR metadata.
  - Produces:
    1. A PR review body (markdown, actionable feedback)
    2. An overall decision: pass \| not\_pass
- Integrate into our PR review workflow so we can:
  - Reuse the same checkout strategy and security posture as .github/workflows/pr-review-by-openhands.yml.
  - Optionally delete earlier bot reviews and only keep the last one to reduce noise.
- Provide an interleaving mechanism so the generator agent can run N cycles gated by critic decisions.

Non-goals

- End-to-end auto-merge.
- Implementing complex human-in-the-loop UIs (basic GitHub review comments + decision only).

Proposed design

1. Critic interface (openhands-sdk)
   - New module/class (e.g., openhands\_sdk.critics.CriticAgent) with a simple call signature:
… (136 more lines)

## [doc:https://docs.openhands.dev/openhands/usage/agent-canvas/critic] (doc) Critic
# Critic

Configure critic evaluation and iterative refinement in Agent Canvas.

  The critic feature is experimental. Configuration options, scoring behavior,
  and default models may change as the feature evolves.

The critic is an additional evaluation pass that reviews the agent's work and
predicts how likely the task is to succeed. In Agent Canvas, critic results can
appear in the conversation timeline as a success-likelihood score with detected
issue labels.

Use the critic when you want extra feedback for an OpenHands agent
conversation, or when you want the agent to automatically refine its work after
a low critic score.

  The default OpenHands-hosted critic is currently free to use. For background
  on the critic model and evaluation methodology, read
  SOTA on SWE-Bench Verified with Inference-Time Scaling and Critic Model
  and
  A Rubric-Supervised Critic from Sparse Real-World Outcomes.
  The critic applies to OpenHands agent conversations. Agent Canvas can also
  run third-party ACP agents, but those agents manage their own execution loop
  and may not expose the same critic evaluation path.

## Prerequisites

Before enabling the critic:

1. Configure your active LLM in `Settings > LLM`.
2. Prefer the `OpenHands` LLM provider when you want the default hosted critic
   path.
3. Start a new conversation after saving critic settings. Existing
   conversations keep the settings they were created with.
… (28 more lines)

## [readme:ayush488-glitch/genesis-kit] (readme) ayush488-glitch/genesis-kit
https://github.com/ayush488-glitch/genesis-kit
License: MIT
# Genesis
## Abstract
It connects specification, task execution, proof, recovery, and evaluated learning while preserving explicit human decisions.

The repository supplies its acceptance checks.

The implementation includes executable regression tests and a baseline/candidate evaluation path.

## Architecture
| Layer | Responsibility | Durable output |
|-|-|-|
| Verification | Bind executable checks and independent review to current inputs | Immutable evidence files and runtime receipts |

## Local control panel
Rerun

## Completion contract
\mathrm{Done}(t) \Rightarrow

These are operational checks, not a mathematical proof of software correctness. Their strength depends on the acceptance tests and the authority protecting the verifier and its evidence.

## A minimal workflow

## Bounded autonomy and recovery
The runner invokes the command, checks scope, verifies gates and either completes the task or persists a stop condition.

## Evaluated learning

A passing experiment means every candidate case passed without a baseline regression. Elapsed time and outcomes are retained; unknown cost stays unknown.
Citation: https://raw.githubusercontent.com/ayush488-glitch/genesis-kit/HEAD/README.md

## [doc:https://github.com/nibzard/awesome-agentic-patterns/blob/40359c7d791480956968ebb2cec1f9c7863b1096/research/subagent-compilation-checker-report.md] (doc) Subagent Compilation Checker Pattern - Research Report
License: Apache-2.0
### Multi-Agent Orchestration Frameworks

#### 8. Microsoft AutoGen

**Company**: Microsoft Research
**URL**: https://github.com/microsoft/autogen
**Status**: Production (Internal tools, Power Platform)

**Implementation Approach**:
- Multi-agent conversations with critic/reviewer agents
- Supervervisor pattern with multi-agent coordination
- Supports human-in-the-loop interactions

**Pattern**: Generator Agent → Initial Output → Critic Agent → Evaluation & Feedback → Generator Agent → Revised Output

---

#### 9. LangGraph

**Company**: LangChain Inc.
**URL**: https://github.com/langchain-ai/langgraph
**Status**: Open Source, Production

**Implementation Approach**:
- Supervisor pattern with multi-agent coordination
- Stateful multi-agent applications
- Built-in support for critic and reviewer roles
… (54 more lines)

## [doc:https://github.com/g-0-b/floss/blob/be802243024938219954eff9492363ba9ba2710a/docs/research/intake_raw/2026-06-12-root/reports/automating-flossioullk.md] (doc) research and Synthesize the plausibly absolute best most functionally automated methodology and techniques to orchestrate and coordinate agent centric ai systems for completely automatable development
License: GPL-3.0
## Fully automated dev pipeline

A functionally automatable loop that still stays verifiable looks like:

- Intake: scrape issues/roadmap into a canonical task format; create minimal reproducible failing test when possible.
- Spec: generate an executable spec bundle (acceptance tests + invariants + “definition of done”).
- Plan: decompose into small, testable subtasks sized like “junior engineer within a short window,” then schedule them across role agents.
- Implement: sandboxed code edits + command execution + dependency installation; keep every action as an append-only event log for replay.
- Verify: run unit/integration tests; require reproduction/regression checks before any merge (OpenHands describes filtering patches by regression and reproduction tests in its SWE-bench workflow). [^2_3]
- Select: run multiple candidate trajectories and use a critic/reranker to choose the best patch (OpenHands reports 60.6% single-trajectory vs 66.4% with five attempts on SWE-Bench Verified using this approach). [^2_3]
- Merge/Release: automatically open PRs, attach provenance + logs, enforce policy gates, cut releases, and publish signed artifacts.

## Case studies \& limitations

- **OpenHands (formerly OpenDevin):** OpenHands is presented as an open platform for building developer-like agents (code + CLI + web), supporting multi-agent coordination, sandboxed interaction, and evaluation benchmarks; it is released under the MIT license and was accepted by ICLR 2025. [^2_2]
- **Measured automation wins (but not “solved”):** OpenHands’ published SWE-bench numbers show meaningful gains from inference-time scaling + critic selection, but the need for multiple attempts highlights ongoing brittleness and cost/performance trade-offs. [^2_3]
- **Holochain evolution constraints:** Holochain’s architecture notes that changing integrity zomes yields a new DNA (new network) and requires migration strategy, while coordinator zomes can be swapped but may create compatibility differences across participants if versions diverge.
- **Security + Sybil reality:** The Holochain whitepaper emphasizes that agent-centric systems must explicitly handle membranes/participation gating and Sybil-resistance as application-level design choices, rather than assuming global consensus gives it “for free.” [^2_1]

If the next step is to turn this into an implementable blueprint, what’s the intended “unit of autonomy” for FLOSSIOUllk: (a) per-repo autonomous maintainer agents, (b) per-issue swarms, or (c) a long-lived multi-DNA hApp where repos/issues are entries governed by validation rules?
[^2_10][^2_11][^2_12][^2_13][^2_14][^2_15][^2_16][^2_17][^2_18][^2_19][^2_20][^2_4][^2_5][^2_6][^2_7][^2_8][^2_9]

⁂

[^2_1]: https://jetthoughts.com/blog/autogen-crewai-langgraph-ai-agent-frameworks-2025/

[^2_2]: https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen

[^2_3]: https://galileo.ai/blog/autogen-vs-crewai-vs-langgraph-vs-openai-agents-framework

[^2_4]: https://www.linkedin.com/pulse/best-agentic-ai-frameworks-2025-langgraph-autogen-crewai-ambatwar-kiltf

[^2_5]: https://www.datacamp.com/pt/tutorial/crewai-vs-langgraph-vs-autogen

[^2_6]: https://mgx.dev/insights/62fee7b52567490da851f0ed7cb2bf9f

[^2_7]: https://www.ainvest.com/news/holochain-disrupt-traditional-blockchain-infrastructure-agent-centric-architecture-scalability-2025-2511/

[^2_8]: https://tirnav.com/blog/langgraph-vs-crewai-vs-autogen
… (24 more lines)

## [pull_request:openhands/software-agent-sdk#4479] (pull_request) HUMAN:
https://github.com/openhands/software-agent-sdk/issues/4479
License: MIT
HUMAN:

I've tested this against actual automations, it works when the agent uses the FinishTool

* * *

AGENT:

## Why

The default preset needs a narrow way to opt into structured `FinishTool` responses for automation task outcomes. The SDK already supports `response_schema` on registered tool specs, so this PR keeps the change localized to the default preset instead of adding SDK-level built-in tool override behavior.

`TaskOutcome` intentionally stays minimal: it currently exposes only a status and `outcome_summary`. The summary description asks the agent to include completion details, blockers, required user action, and next steps; more fields can be added later if they prove necessary.

## Summary

- Add experimental structured task-outcome models under `openhands.tools.preset`:

  - `TaskOutcome`
  - `TaskOutcomeStatus`
- Add `finish_tool_response_schema` to the default preset so callers can opt into structured `FinishTool` responses, including the simplified `TaskOutcome` model.
- Keep the implementation localized to the default preset: when a structured finish response schema is passed, `get_default_agent(...)` registers the SDK `FinishTool`, adds the schema-bound explicit finish tool, and omits the default unstructured `FinishTool` to avoid duplicate runtime `finish` tools.

### REST API contract changes

Compared with base OpenAPI `effc01ef3352` for public `/api/**` paths.
… (565 more lines)