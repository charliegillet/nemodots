This SMBO loop accommodates mixed discrete/continuous spaces and noisy, non-differentiable metrics by relying on black-box evaluations. Crucially, GG (the node/edge topology) remains unchanged throughout.
##### GEPA ( [Agrawal et al., 2025](https://arxiv.org/html/2509.04642\#bib.bib1 "")).
A reflective, multi-objective evolutionary procedure on CC where execution traces induce edits, producing offspring that trade off task utility, cost, and parsimony. Selection is performed on the Pareto front with diversity maintenance, yielding a set of non-dominated configurations rather than a single scalar-optimal point. The approach is robust to non-smooth objectives and can incorporate domain heuristics via reflection operators. The topology GG is held constant; only configuration components (prompts) evolve.
##### GRPO ( [Shao et al., 2024](https://arxiv.org/html/2509.04642\#bib.bib12 "")).
A policy-gradient fine-tuning of model weights within CC using group-relative advantages and a PPO-style clipped objective with KL regularization. For each input, multiple candidate outputs are scored to form within-group standardized advantages, reducing variance and stabilizing updates. Gradients flow through log-likelihoods of the tuned node(s), improving the induced policy while controlling drift via the KL term. GRPO modifies parameters inside nodes but does not alter the graph GG (no addition/removal of nodes, edges, or tools).
All three methods optimize CC under the stated constraints (e.g., cost and rollout budgets), while _none_ perform structure search over GG (no graph mutations). To optimize the graph itself, a separate graph-mutation/search layer must be introduced (e.g., via explicit constraints on Ω⁡(G)\\Omega(G) or structural operators over VV and EE).
## 4 Maestro: A Holistic Graph & Config Optimizer for AI Agents111        This section presents the general formulation of the Maestro optimizer; technical details remain proprietary.
Maestro moves beyond configuration-only methods by _jointly_ optimizing the structural (graph) and operational (configuration) dimensions within the unified objective in a way that does not depend on specific frameworks of agent implementations:

|     |     |     |
| --- | --- | --- |
|  | maxG∈𝔊,C∈𝒞⁡𝔼(x,m)∼T​\[μ⁡(YO,m)\]s.t.{YO∼ΦG,C​(x),𝔼x∼T\[c(G,C;x)\]≤κ,Ω(G)≤τ,ℛtrain(G,C)≤B.\\max\_{G\\in\\mathfrak{G},\\;C\\in\\mathcal{C}}\ \\mathbb{E}\_{(x,m)\\sim T}\\!\\left\[\\mu(Y\_{O},m)\\right\]\\quad\\text{s.t.}\\quad\\begin{cases}Y\_{O}\\sim\\Phi\_{G,C}(x),\\\<br>\\mathbb{E}\_{x\\sim T}\\!\\left\[c(G,C;x)\\right\]\\leq\\kappa,\ \ \\Omega(G)\\leq\\tau,\ \ \\mathcal{R}\_{\\text{train}}(G,C)\\leq B.\\end{cases} |  |

At a high level, Maestro follows a _block-coordinate_ scheme that alternates between configuration updates (holding GG fixed) and graph updates (leveraging the utilities observed in the configuration step), utilizing both numeric feedback (e.g. evaluation scores) and non-numeric, reflective feedback (e.g., textual critiques from traces) to steer both updates.
##### Maestro supports the following updates to the current agent (G(t),C(t))(G^{(t)},C^{(t)}):

- •

C-step (config update)

Exploring and updating agent configurations while keeping the agent graph unchanged:

|     |     |     |     |
| --- | --- | --- | --- |
|  | C(t+1)\\displaystyle\\quad C^{(t+1)} | ∈argmaxC∈𝒞𝔼(x,m)∼T\[μ(YO,m)\]s.t.YO∼ΦG(t),C(x),𝔼\[c\]≤κ,ℛtrain≤Bt,\\displaystyle\\in\\arg\\max\_{C\\in\\mathcal{C}}\ \\mathbb{E}\_{(x,m)\\sim T}\\!\\left\[\\mu\\!\\big(Y\_{O},m\\big)\\right\]\ \ \\text{s.t.}\ \ Y\_{O}\\sim\\Phi\_{G^{(t)},C}(x),\ \ \\mathbb{E}\[c\]\\leq\\kappa,\ \ \\mathcal{R}\_{\\text{train}}\\leq B\_{t}, |  |

- •

G-step (graph update)

Proposing and updating agent graphs based on the current agent configurations:
---
In two application settings—an interviewer agent and an AI assistant—Maestro improves over the initial agents by an average of  41.9% (64% and 19.7%, respectively) with configuration-only optimization, and by an average of  65.7% (90% and 41.3%, respectively) with holistic optimization. Qualitatively, Maestro reduces instruction drift, prevents loops through revised control logic, preserves global state via explicit memory nodes, and improves corner-case reliability through context gating and validator insertion.
Collectively, these results position Maestro as a _robust, generalizable_ solution for end-to-end agent improvement: it closes structural and configuration gaps simultaneously, exploits rich feedback for sample-efficient search, and operates across frameworks without requiring agents to be rewritten in a specific DSL [Khattab et al. (2023)](https://arxiv.org/html/2509.04642#bib.bib6 "").
C-step: Fix G(t)G^{(t)}, optimize CCImprove task score using the current graph.Budget: rollout BtB\_{t}G-step: Fix C(t+1)C^{(t+1)}, optimize GGPropose small structural edits (add / remove / rewire).Budget: graph Bt′B^{\\prime}\_{t}utilities & costscarry configNon-numeric feedback from traces guides Maestro in both steps.
Figure 2: Maestro’s two complementary optimization steps. _C-step (config update):_ keep the graph fixed and tune the configuration under a rollout budget.
_G-step (graph update):_ keep the configuration fixed and try small graph edits under a graph budget.
Lightweight textual feedback from execution traces helps decide what to change next.
## 2 A Formulation for Joint AI Agent Config and Graph Optimization

### Agentic computation graph

Let G=(V,E)G=(V,E) be a finite directed graph with (optional) designated input and output node sets I,O⊆VI,O\\subseteq V.
Each node v∈Vv\\in V has an _input set_ XvX\_{v} and an _output set_ YvY\_{v}.
##### Edge adapters.
Each edge e=(u→v)∈Ee=(u\\!\\to\\!v)\\in E carries an adapter

|     |     |     |
| --- | --- | --- |
|  | ψe:Yu×αe⟶Xv,\\psi\_{e}:Y\_{u}\\times\\alpha\_{e}\\longrightarrow X\_{v}, |  |

where αe\\alpha\_{e} are adapter parameters (e.g., templates, serializers, schema maps).
##### Merging.
Each node vv has a merge operator

|     |     |     |
| --- | --- | --- |
|  | ⊕v:Xv×⋯×Xv⏟one per incoming edge×βv⟶Xv,\\oplus\_{v}:\ \\underbrace{X\_{v}\\times\\cdots\\times X\_{v}}\_{\\text{one per incoming edge}}\\times\\beta\_{v}\\;\\longrightarrow\\;X\_{v}, |  |

with hyperparameters βv\\beta\_{v}; if vv has a single parent, take ⊕v\\oplus\_{v} as the identity.
##### Agentic node.
Externally, a node vv (LLM + tools + controller) is modeled as a _stochastic function_

|     |     |     |
| --- | --- | --- |
|  | Fv:Xv×cv⟶𝖣𝗂𝗌𝗍⁡(Yv),F\_{v}:\ X\_{v}\\times c\_{v}\\;\\longrightarrow\\;\\mathsf{Dist}(Y\_{v}), |  |

where cv∈𝒞vc\_{v}\\in\\mathcal{C}\_{v} is the node configuration (e.g., model family and weights θv\\theta\_{v}, prompt ρv\\rho\_{v}, tool set, decoding and control hyperparameters).
##### Execution semantics (DAG).
Fix any topological order. For each vv:

|     |     |     |
| --- | --- | --- |
|  | xv=⊕v({ψ(u→v)(yu,α(u→v))}(u→v)∈E,βv),yv∼Fv(xv,cv).x\_{v}\\;=\\;\\oplus\_{v}\\!\\big(\\{\\psi\_{(u\\to v)}(y\_{u},\\alpha\_{(u\\to v)})\\}\_{(u\\to v)\\in E}\\,,\\,\\beta\_{v}\\big),\\qquad y\_{v}\\sim F\_{v}(x\_{v},c\_{v}). |  |

This induces an end-to-end randomized map

|     |     |     |
| --- | --- | --- |
|  | ΦG,C:∏i∈IXi⟶𝖣𝗂𝗌𝗍⁡(∏o∈OYo),\\Phi\_{G,C}:\ \\prod\_{i\\in I}X\_{i}\\longrightarrow\\mathsf{Dist}\\!\\Big(\\prod\_{o\\in O}Y\_{o}\\Big), |  |

where CC collects all configurations C≔{cv}v∈V∪{αe}e∈E∪{βv}v∈VC\\coloneqq\\{c\_{v}\\}\_{v\\in V}\\cup\\{\\alpha\_{e}\\}\_{e\\in E}\\cup\\{\\beta\_{v}\\}\_{v\\in V}.
##### Graphs with cycles.
To consider graphs with cycles, one can either unroll t=1:Tt=1{:}T (dynamic graph) with
---
Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: arXiv.org perpetual non-exclusive license](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2509.04642v1 \[cs.AI\] 04 Sep 2025

# Maestro: Joint Graph & Config Optimization   for Reliable AI Agents

Wenxiao Wang
Email: [wwx@relai.ai](mailto:)Affiliation: RELAI.ai
Priyatham Kattakinda
Email: [priyatham@relai.ai](mailto:)Affiliation: RELAI.ai
Soheil Feizi
Email: [sfeizi@relai.ai](mailto:)Affiliation: RELAI.ai

###### Abstract

Building reliable LLM agents requires decisions at two levels: the _graph_ (which modules exist and how information flows) and the _configuration_ of each node (models, prompts, tools, control knobs). Most existing optimizers tune configurations while holding the graph fixed, leaving structural failure modes unaddressed. We introduce Maestro, a framework-agnostic holistic optimizer for LLM agents that _jointly_ searches over graphs and configurations to maximize agent quality, subject to explicit rollout/token budgets. Beyond numeric metrics, Maestro leverages _reflective textual feedback_ from traces to prioritize edits, improving sample efficiency and targeting specific failure modes. On the IFBench and HotpotQA benchmarks, Maestro consistently surpasses leading prompt optimizers—MIPROv2, GEPA, and GEPA+Merge—by an average of 12%, 4.9%, and 4.86%, respectively; even when restricted to prompt-only optimization, it still leads by 9.65%, 2.37%, and 2.41%. Maestro achieves these results with far fewer rollouts than GEPA. We further show large gains on two applications (interviewer & RAG agents), highlighting that joint graph & configuration search addresses structural failure modes that prompt tuning alone cannot fix.
## 1 Introduction

Figure 1: Maestro outperforms leading prompt optimizers with far fewer rollouts.
001,0001{,}0002,0002{,}0003,0003{,}0004,0004{,}0005,0005{,}0006,0006{,}0007,0007{,}0004040505060607070Initial Design (38.00%)MIPROv2: 58.00%GEPA: 69.00%GEPA+Merge: 65.67%Maestro (graph + config): 72.00%Maestro (config only): 70.33%Rollouts (↓)({\\color\[rgb\]{1,0,0}\\downarrow})Evaluation Score

(a) Evaluation Score vs. Rollouts on HotpotQA (gpt-4.1-mini).
Questionretrievedocs1summarize1summary1create\_query\_hop2… (omitted)extract\_entitiesentities

(b) Agent graph edits suggested by Maestro for HotpotQA; changes highlighted.
Large Language Models (LLMs) have enabled a new _agentic AI_ paradigm, in which AI agents autonomously plan and act to accomplish complex tasks. These LLM-based agents aim to reduce the need for human orchestration by converting high-level instructions into multi-step decisions and tool calls [Wang et al. (2023)](https://arxiv.org/html/2509.04642#bib.bib14 ""). From customer support to code generation, such agents integrate capabilities like tool use, memory, and self-reflection to handle tasks beyond a single prompt’s scope [Gao et al. (2024)](https://arxiv.org/html/2509.04642#bib.bib5 ""); [Packer et al. (2023)](https://arxiv.org/html/2509.04642#bib.bib9 ""). Some even argue that the agent paradigm could be a stepping stone toward artificial general intelligence (AGI) by virtue of its autonomy and cross-domain adaptability [Altman (2023)](https://arxiv.org/html/2509.04642#bib.bib2 ""). Despite this promise, current AI agents often fall short of expectations [Liu et al. (2024)](https://arxiv.org/html/2509.04642#bib.bib7 ""), frequently failing to deliver reliable results in practice. This gap between potential and reality stems largely from limitations in today’s agent designs, which undermine robustness and generality.
Current LLM-based agents suffer from several technical limitations that hinder their effectiveness, scalability and reliability including:

- •
---
Figure [9](https://arxiv.org/html/2509.04642#S5.F9 "Figure 9 ‣ 5.4.2 Results ‣ 5.4 RAG Agent ‣ 5 Evaluation ‣ Maestro: Joint Graph & Config Optimizationfor Reliable AI Agents") shows the results of optimizing the RAG agent using Maestro. All the scores in the plot are from a custom LLM-based judge that uses per-sample rubrics to evaluate the responses from the RAG agent. We ran Maestro in two different modes: with configuration optimization only, and with both graph and configuration optimization. In the latter case, the improvements suggested by Maestro’s graph optimizer were applied to the agent before continuing with the configuration optimization. Both modes lead to substantial improvements over the scores achieved by the initial design.
Figure [10](https://arxiv.org/html/2509.04642#S5.F10 "Figure 10 ‣ 5.4.2 Results ‣ 5.4 RAG Agent ‣ 5 Evaluation ‣ Maestro: Joint Graph & Config Optimizationfor Reliable AI Agents") compares the initial and optimized designs of the agent obtained through combined graph and configuration optimization. Maestro suggested new tools to perform computations such as mean, standard deviation, and percentage growth. In the initial design, these computations had to be handled by the LLM itself. Since the arrays involved in the computations can be large, this approach is slower, more expensive, and more error-prone. The initial and final choices for the hyperparameters are shown in Appendix [A.4](https://arxiv.org/html/2509.04642#A1.SS4 "A.4 RAG Agent ‣ Appendix A Agent Configurations and Graphs ‣ Maestro: Joint Graph & Config Optimizationfor Reliable AI Agents"). This example highlights Maestro’s capability to effectively optimize diverse configurations, such as prompts, models, and tools.
LLMPromptOutputToolssemantic\_searchget\_stock\_pricesDataHyperparametersmodelnum\_chunkssystem\_prompt

(a) Initial design.
LLMPromptOutputToolssemantic\_searchget\_stock\_pricesnumeric\_computeDataHyperparametersmodelnum\_chunkssystem\_prompt

(b) Maestro optimized design. Additions are shown in green, while modifications are shown in orange.
Figure 10: Comparison of the design of the RAG agent before and after optimization using Maestro.
## 6 Conclusion

Reliable agentic AI will not emerge from monolithic, one–size–fits–all systems or from optimizers that tune prompts and weights while keeping architecture frozen. In this paper we argued, and demonstrated empirically, that _joint_, _holistic_ optimization of both the agent’s _graph_ (what modules exist and how information flows) and its _configuration_ (models, prompts, tools, and control hyperparameters) is required for robustness and efficiency under realistic constraints.
Our contributions are threefold in spirit. First, we provided a unified formulation that treats agents as typed stochastic computation graphs with adapters and merge operators, and we coupled task utility with explicit budgets for cost, structure, and training rollouts. Second, we introduced Maestro, a holistic agent optimizer that alternates between a configuration step (fix GG, optimize CC) and a graph step (fix CC, optimize GG), with trust–region edits, warm starts, and budgeted evaluation. Third, we showed how non-numeric, reflective feedback from execution traces can be distilled into targeted edits, improving sample efficiency and addressing failure modes such as missing verification, brittle control flow, and inadequate state handling, that configuration-only methods cannot reliably fix. Across IFBench and HotpotQA, Maestro delivered consistent gains under matched budgets, and in two application settings it substantially improved reliability over strong configuration-only baselines.
Why does joint optimization matter? Structure changes determine which computations are even possible—adding validators, memory, or conditional routing can eliminate whole classes of errors—while configuration tuning determines how well those computations are realized.