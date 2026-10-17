Context distraction is not hypothetical
– in our study an unguarded online method (Dynamic Cheatsheet) goes from
near-best on ALFWorld (70.7%70.7\\%) to a WebShop score of 0.1360.136 versus the ReAct
baseline’s 0.4290.429, a catastrophic regression caused entirely by the context it
added.
We argue that the reliability of context evolution comes less from the
artifact being evolved and more from the _selection gate_ that decides whether
to commit it. An evolution loop that commits whatever it produces inherits the
variance of its own rewrites; one that commits a change only when it improves
_held-out_ performance cannot do worse than not evolving at all. We make this
gate the design center of our method rather than an afterthought.
Concretely, we present RSEA (Recursive Self-Evolving Agent). RSEA carries a
compact three-layer natural-language state – _strategy_ (an imperative
preamble), _skills_ (reusable sub-routines), and _playbook_ (procedures
distilled from successes) – and across generations (i) rolls the current state out
on a small evolve pool, (ii) rewrites _all three layers_ from the resulting
trajectories, and (iii) commits the candidate only if it does not regress on a
disjoint validation split, updating the frozen best state only on a _strict_
improvement. Only the frozen best state is run on a held-out test split, so there is
no leakage. RSEAR{}\_{\\text{R}} injects this frozen prior into a per-task retry loop.
Contributions. (1) A formulation of cross-task NL self-evolution centered on
a _strict held-out keep-better_ gate that makes the operation
_monotone-safe_ (§ [4](https://arxiv.org/html/2606.28374#S4 "4 Method: RSEA ‣ Recursive Self-Evolving Agents via Held-Out Selection")). (2) A faithful, single-backbone
re-implementation of six classic and recent baselines on a shared harness
(§ [5](https://arxiv.org/html/2606.28374#S5 "5 Experimental Setup ‣ Recursive Self-Evolving Agents via Held-Out Selection")). (3) A four-benchmark study with multi-seed statistics and paired
tests, yielding an honest scope condition rather than a universal-win claim
(§ [6](https://arxiv.org/html/2606.28374#S6 "6 Results on ALFWorld: the evolved prior significantly helps ‣ Recursive Self-Evolving Agents via Held-Out Selection")– [7](https://arxiv.org/html/2606.28374#S7 "7 Transfer to GAIA, 𝜏-bench, and WebShop ‣ Recursive Self-Evolving Agents via Held-Out Selection")). (4) Controlled ablations that isolate the
contribution of each state layer and quantify the cost of removing held-out
selection (§ [8](https://arxiv.org/html/2606.28374#S8 "8 Ablations ‣ Recursive Self-Evolving Agents via Held-Out Selection")).
Key findings.
(a) On ALFWorld (134 tasks ×\\times 5 seeds, 7B) the single-pass evolved prior
significantly beats ReAct, GEPA, and AWM, and RSEAR{}\_{\\text{R}} is best overall
(79.4%79.4\\%).
(b) On the strong-backbone tool-use benchmarks no NL artifact dominates; RSEA is
statistically tied with ReAct (and never significantly worse), while AWM’s concrete
workflows give the only consistent small lift.
(c) Methods without a held-out gate are high-variance and can catastrophically
regress; RSEA’s strict gate converts “context evolution” from a coin-flip into a
monotone-safe operation.
(d) Ablations show every layer of the evolved state helps (the layers overlap rather
than being strictly complementary) and that removing held-out selection overfits the
evolve pool (100%100\\% in-sample, a 3333-point drop to test).
![Refer to caption](https://arxiv.org/html/2606.28374v1/figures/fig_crossbench.png)Figure 1: No context-evolution artifact universally wins, and unguarded
evolution is unsafe. Single-pass methods across four benchmarks on one shared
backbone (ALFWorld 7B; GAIA/τ\\tau-bench/WebShop 30B).
---
Prompt/context optimizers carry a cross-task artifact but optimize a _single_
form: GEPA (Agrawal and others, [2025](https://arxiv.org/html/2606.28374#bib.bib14 "GEPA: reflective prompt evolution can outperform reinforcement learning")) a flat prompt via reflective Pareto evolution; AWM
(Wang et al., [2024b](https://arxiv.org/html/2606.28374#bib.bib17 "Agent workflow memory")) a list of induced workflows; ACE (Zhang et al., [2025c](https://arxiv.org/html/2606.28374#bib.bib18 "Agentic context engineering: evolving contexts for self-improving language models")) an itemized
bullet playbook with add-only deltas; Dynamic Cheatsheet (Suzgun et al., [2025](https://arxiv.org/html/2606.28374#bib.bib19 "Dynamic cheatsheet: test-time learning with adaptive memory")) a
single cheatsheet curated _online_. Two issues recur. Single-form
artifacts conflate complementary kinds of knowledge – a high-level strategy, a
reusable sub-routine, and a concrete procedure are not interchangeable, yet most
methods fold them into one string. Unguarded commitment is the more
damaging: methods that append or rewrite without a held-out check (notably online
curation) commit context that can _distract_ the base policy, and – because the
same mechanism that helps when context is useful is unconstrained when it is not –
they are high-variance across benchmarks (§ [7](https://arxiv.org/html/2606.28374#S7 "7 Transfer to GAIA, 𝜏-bench, and WebShop ‣ Recursive Self-Evolving Agents via Held-Out Selection")). RSEA targets both:
a three-layer form, and a strict held-out gate.
Table 1: Context-adaptation methods as (form, update operator, selection rule).
The selection rule – whether a candidate is committed only after improving
_held-out_ performance – is what we argue governs reliability.
|     |     |     |     |
| --- | --- | --- | --- |
| Method | Artifact form | Update operator | Selection rule |
| Reflexion | per-task reflection | verbal self-feedback | none (within-task retry) |
| GEPA | flat prompt | reflective mutation | Pareto on val minibatch |
| AWM | workflow list | induction from successes | none (induce & inject) |
| ACE | bullet playbook | add-only deltas | val keep-best (non-strict) |
| Dynamic Cheatsheet | single cheatsheet | online rewrite | none (no held-out gate) |
| RSEA (ours) | 3-layer state | holistic rewrite of all layers | strict held-out keep-better |

## 4 Method: RSEA

### Three-layer evolving state.
The agent state is a triple
s=(strategy,skills,playbook)s=(\\textsc{strategy},\\textsc{skills},\\textsc{playbook}): (1) strategy,
an imperative natural-language preamble (≤\\leq a few sentences); (2) skills,
a short list of reusable sub-routines / conditional rules; and (3) playbook,
a list of procedures (ordered step sequences) distilled from successful
trajectories. The three layers are deliberately complementary – a _policy_ of
what to prefer, a _library_ of reusable moves, and _procedures_ for
recurring task families. At inference, ss is rendered to a compact preamble and
injected immediately ahead of the task in an otherwise canonical ReAct loop
(Fig. [2](https://arxiv.org/html/2606.28374#S4.F2 "Figure 2 ‣ RSEA_\"R\": evolution × retry. ‣ 4 Method: RSEA ‣ Recursive Self-Evolving Agents via Held-Out Selection")); the _only_ difference from vanilla ReAct is this
injected, evolved state, which keeps the comparison clean.
### The self-rewrite operator.
A development pool is split into a disjoint
_evolve_ set DeD\_{e} and _val_ set DvD\_{v}. Generation gg rolls the current
state sg−1s\_{g-1} out on DeD\_{e}, collecting (task, trajectory, env-verified outcome)
tuples, then prompts the _same_ frozen LLM to act as its own meta-optimizer:
given the current three layers and a balanced sample of successful and failed
trajectories, it returns a rewritten triple s~g\\tilde{s}\_{g}.
---
Title:

Content selection saved. Describe the issue below:

Description:

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2606.28374v1 \[cs.AI\] 17 Jun 2026

# Recursive Self-Evolving Agents via Held-Out Selection

Michael Nguyen  Quoc Nguyen  Paul Vuong

School of Information Technology

Monash University Malaysia

{michael.nguyen, quoc.nguyen, paul.vuong}@monash.edu

###### Abstract

LLM agents are increasingly improved _without_ weight updates, by evolving a
natural-language artifact – reflections, workflows, playbooks, cheatsheets, or
optimized prompts – that conditions a frozen policy. Such methods are typically
reported as wins on the single benchmark where they help. We study them
apples-to-apples and surface a sharper picture. We introduce RSEA
(Recursive Self-Evolving Agent), which carries a compact _three-layer_
_natural-language state_ – an imperative _strategy_, reusable _skills_,
and a procedural _playbook_ – and across generations rewrites all three layers
from its own trajectories, committing a candidate only if it does not regress on a
disjoint held-out split (a _strict keep-better_ gate). Across four diverse
benchmarks (ALFWorld, GAIA, τ\\tau-bench, WebShop) and six faithful baselines
(ReAct, Reflexion, GEPA, AWM, ACE, Dynamic Cheatsheet), all on one shared local
backbone, we find: (i) _no artifact universally wins_ – RSEA is the strongest
single-pass method on ALFWorld (69.3%69.3\\% vs. ReAct 64.6%64.6\\%, McNemar p=0.015p{=}0.015;
79.4%79.4\\% with retry, best overall), while concrete-workflow induction (AWM) is best
on the strong-backbone tool-use tasks; (ii) unguarded context evolution is
_high-variance and unsafe_ – Dynamic Cheatsheet, which curates context online
with no held-out gate, is near-best on ALFWorld (70.7%70.7\\%) yet _collapses_ on
WebShop (score 0.140.14 vs. ReAct 0.430.43); and (iii) RSEA’s strict held-out selection
is what makes recursive self-evolution _monotone-safe_: it never significantly
underperforms the base agent on any benchmark, falling back to vanilla ReAct when
evolved context would hurt. Controlled ablations show that every layer of
the evolved state helps and that removing held-out selection causes severe
overfitting (a perfect in-sample score but a 3333-point drop to test). We argue the
reliability of context evolution comes less from the
artifact and more from the _selection gate_, and release the full harness, the
six baseline re-implementations, and pre-registered manifests.
## 1 Introduction

A central paradigm for building self-improving LLM agents adapts the _context_
rather than the weights: the policy is frozen and an evolving natural-language
artifact – accumulated reflections, induced workflows, curated playbooks, online
cheatsheets, or optimized system prompts – is injected at inference. Context
adaptation is attractive for concrete reasons: it is interpretable and auditable,
integrates new knowledge at runtime, transfers across model versions, and – with
long-context inference and KV-cache reuse – is increasingly cheap to serve.
Despite rapid progress, these methods are almost always evaluated _in_
_isolation_: a single benchmark, weak or non-matched baselines, and a backbone or
decoding budget that varies between methods. This makes their _relative_ merits
and, crucially, their _failure modes_ hard to read. When we re-run six
representative methods on one shared backbone across four diverse agent benchmarks,
two uncomfortable facts emerge. First, _which_ artifact helps is
benchmark-dependent: a method that tops one benchmark is middling or harmful on
another. Second, and more importantly, evolving context is _not_ a free lunch.
We name the failure mode _context distraction_: an injected artifact that
degrades an otherwise-capable base policy.
---
### Held-out selection prevents overfitting (Table [6](https://arxiv.org/html/2606.28374\#S8.T6 "Table 6 ‣ Robustness. ‣ 8 Ablations ‣ Recursive Self-Evolving Agents via Held-Out Selection")).
We re-run the evolution with _no_ held-out split (selecting on the evolve set
itself) and freeze the result. The no-gate state _overfits_ sharply: it reaches
a perfect 100%100\\% in-sample selection score but only 66.7%66.7\\% on test – a 3333-point
train–test gap – versus held-out RSEA’s 67.3%67.3\\% (63.6%63.6\\% for ReAct). On ALFWorld
even the overfit state edges out ReAct, but the danger of unguarded commitment is
starkest on the transfer benchmarks (§ [7](https://arxiv.org/html/2606.28374#S7 "7 Transfer to GAIA, 𝜏-bench, and WebShop ‣ Recursive Self-Evolving Agents via Held-Out Selection")): there, the method with
_no_ held-out gate (Dynamic Cheatsheet) regresses catastrophically (WebShop
0.140.14 vs. 0.430.43), while RSEA’s strict gate keeps performance at the ReAct level.
The gate – not the rewrite operator – is what bounds the downside and makes
recursive self-evolution safe to deploy.
### Robustness.
The strict best-update is what bounds the downside: with a
non-strict (≥\\geq) best-update, a candidate that merely ties on a small or
unrepresentative val draw can be frozen and then hurt on test; the strict variant
returns the simpler (often empty) state in that case, which is exactly the
fall-back-to-ReAct behavior we observe on WebShop and τ\\tau-bench.
Table 5: Layer ablation (ALFWorld test, 54×\\times3 seeds). Every subset beats
ReAct; layers overlap.
|     |     |
| --- | --- |
| Injected state | Succ. (%) |
| empty (= ReAct) | 64.2 |
| strategy only | 67.3 |
| skills only | 69.8 |
| playbook only | 69.8 |
| strategy + skills | 67.9 |
| full RSEA | 68.5 |

Table 6: Selection ablation (ALFWorld). No gate ⇒\\Rightarrow 100% in-sample but a
33-pt drop to test (overfitting).
|     |     |     |
| --- | --- | --- |
| Variant | in-samp. | test |
| ReAct (empty) | – | 63.6 |
| RSEA, no held-out gate | 100.0 | 66.7 |
| RSEA, strict gate | – | 67.3 |

## 9 Compute and Cost

Because every method shares one backbone and an iso-rollout budget, cost differences
come from the _number of meta-LLM calls_ (rewrites/reflections) and the injected
context length. RSEA’s evolution is a fixed GG generations of (evolve rollout +
one rewrite + val rollout); the rewrite is a single call per generation, so the
meta-overhead is O​(G)O(G) calls – e.g. the τ\\tau-bench evolution used 190190 meta +
selection calls in total. At inference RSEA adds only the rendered preamble
(≤\\leq a few hundred tokens, bounded by construction since the rewrite may drop
layers), versus online methods whose context grows unboundedly with the test stream.
Crucially, the strict gate means this overhead is only ever spent to _match or_
_beat_ ReAct, never to underperform it – the favorable risk profile that the other
methods lack.
## 10 Discussion and Limitations

### When does cross-task NL evolution help?
The scope condition is clear: an
evolved NL state helps most when the bottleneck is _procedural strategy_
(text-action ReAct agents such as ALFWorld), where the state encodes exactly the
procedures a weak base policy lacks; it helps least when a strong backbone already
follows a detailed tool API (τ\\tau-bench) or when the bottleneck is
retrieval/grounding (WebShop, GAIA). This predicts _which_ of many proposed
methods will transfer to a new agent setting.
### Why our framing is selection-first.
The same data that makes the
benchmark-dependence visible also shows that the dangerous failures (DC’s WebShop
collapse) come from _committing_ context without a held-out check. RSEA’s
contribution is to make that check strict and central, which is what converts a
high-variance idea into a safe one.
### Limitations.