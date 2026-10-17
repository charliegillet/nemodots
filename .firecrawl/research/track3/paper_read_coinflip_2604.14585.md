Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY-NC-SA 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2604.14585v2 \[cs.AI\] 27 May 2026

# Prompt Optimization Is a Coin Flip:   Diagnosing When It Helps in Compound AI Systems

Xing Zhang
Guanghui Wang
Yanwei Cui
Wei Qiu
Ziyuan Li
Bing Zhu
Peiyang He

###### Abstract

Prompt optimization in compound AI systems is statistically indistinguishable from a coin flip: across 72 optimization runs on Claude Haiku 4.5 (6 methods ×\\times 4 tasks ×\\times 3 repeats), 49% score _below_ zero-shot; on Amazon Nova Lite, the failure rate is even higher.
Yet on one task, _all_ six methods improve over zero-shot by up to +6.8+6.8 points.
What distinguishes success from failure?
We investigate with 18,000 grid evaluations and 144 optimization runs, testing two assumptions behind end-to-end optimization tools like TextGrad and DSPy, in the order they must be answered: (A) agent prompts interact, requiring joint rather than independent optimization, and (B) individual prompts are worth optimizing at all.
Interaction effects are never significant (p>0.52p>0.52, all F<1.0F<1.0), and optimization helps only when the task has _exploitable output structure_: a format the model can produce but does not default to.
We further give a mechanistic account: instruction-tuning compresses input phrasing into a narrow output distribution, eliminating the very phrasing-sensitivity that joint optimization assumes.
We provide a two-stage diagnostic: an $80 ANOVA pre-test for agent coupling, and a 10-minute headroom test that predicts whether optimization is worthwhile, turning a coin flip into an informed decision.
compound AI systems, prompt optimization, multi-agent, ANOVA, interaction effects, model specificity, evaluation methodology

## 1 Introduction

Compound AI systems (pipelines of multiple LLM calls where each agent handles a specialized subtask) have become the dominant architecture for complex applications (Chase, [2022](https://arxiv.org/html/2604.14585#bib.bib2 ""); Wu et al., [2023](https://arxiv.org/html/2604.14585#bib.bib15 "")).
A natural question arises: _how should we optimize the prompts in these systems?_

Recent work strongly favors end-to-end joint optimization.
TextGrad (Yuksekgonul et al., [2025](https://arxiv.org/html/2604.14585#bib.bib19 "")) propagates textual gradients through multi-component systems.
DSPy (Khattab et al., [2023](https://arxiv.org/html/2604.14585#bib.bib6 "")) compiles LLM programs with end-to-end optimization.
GPTSwarm (Zhuge et al., [2024](https://arxiv.org/html/2604.14585#bib.bib23 "")) treats agent graphs as optimizable structures.
These methods implicitly rely on two assumptions:

- •

Assumption A (coupling): Agent prompts interact, so the optimal prompt for one agent depends on the prompt of another, requiring joint rather than independent optimization.
- •

Assumption B (worth optimizing): Individual agent prompts are worth optimizing, in that changing a prompt meaningfully affects system output, even at realistic training budgets.
If Assumption A fails, independent per-agent optimization suffices.
If Assumption B also fails, even per-agent optimization is unnecessary.
Surprisingly, neither assumption has been empirically tested.
We provide controlled measurements of both, in the order they must be answered, and identify the conditions that separate the 49% failure rate from the cases where optimization delivers real gains.
---
Four tasks: Feedback-Bench (Kim et al., [2024](https://arxiv.org/html/2604.14585#bib.bib7 "")), HelpSteer2 (Wang et al., [2024b](https://arxiv.org/html/2604.14585#bib.bib14 "")), WildBench (Lin et al., [2024](https://arxiv.org/html/2604.14585#bib.bib8 "")), and XSum (Narayan et al., [2018](https://arxiv.org/html/2604.14585#bib.bib9 "")).
Training: 20 questions; test: 100 held-out questions; 3 repeats per condition.
Two executor models: Claude Haiku 4.5 and Amazon Nova Lite.
### 4.2 Results: Optimization Is a Coin Flip

Table 2: Held-out test scores on Claude Haiku 4.5 (mean over 3 repeats; 100 test questions per task; LLM-judge scale 0–100). Tasks: FB = Feedback-Bench, HS2 = HelpSteer2, WB = WildBench, XSum = XSum summarization. Bold = best method per task. HS2 is the only task where every optimizer beats zero-shot; on the other three, average gain is negative or near zero.
| Method | FB | HS2 | WB | XSum |
| --- | --- | --- | --- | --- |
| Zero-Shot | 82.4 | 68.0 | 68.9 | 76.0 |
| --- | --- | --- | --- | --- |
| APE | 82.3 | 69.3 | 68.0 | 76.6 |
| OPRO | 81.4 | 73.8 | 69.0 | 74.7 |
| EvoPrompt | 82.0 | 74.8 | 68.3 | 75.6 |
| PromptBreeder | 83.5 | 74.6 | 68.5 | 76.0 |
| DSPy-style | 81.9 | 69.8 | 65.1 | 76.2 |
| PROSE | 82.1 | 74.4 | 69.6 | 75.9 |

Table [2](https://arxiv.org/html/2604.14585#S4.T2 "Table 2 ‣ 4.2 Results: Optimization Is a Coin Flip ‣ 4 Study 2: When Does Individual Optimization Help? ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems") shows the results.
On Haiku, 49% of 72 runs (6 methods ×\\times 4 tasks ×\\times 3 repeats) score _below_ zero-shot.
We cannot reject the null hypothesis that gain over zero-shot is symmetric around zero (binomial p=0.91p=0.91): in our setup, optimization is statistically indistinguishable from random selection at the binomial level.
On Nova Lite, the picture is worse: 14 of 24 method×\\timestask means fall below zero-shot (Table [4](https://arxiv.org/html/2604.14585#A2.T4 "Table 4 ‣ Appendix B Nova Lite Optimization Results ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems") in Appendix [B](https://arxiv.org/html/2604.14585#A2 "Appendix B Nova Lite Optimization Results ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
On three of four tasks, the average gain across all methods is _negative_: −0.20-0.20 (FB), −0.82-0.82 (WB), −0.17-0.17 (XSum).
#### Why optimization usually fails.
Two factors compound: with only 20 training questions, per-candidate scores are too noisy for reliable selection, and iterative methods overfit (train-test gaps up to +5.6+5.6 pts; APE, being non-iterative, shows none).
This aligns with broader evidence: Nie et al. ( [2026](https://arxiv.org/html/2604.14585#bib.bib10 "")) report that only 9% of surveyed agents use any automated optimization, attributing low adoption to hidden design choices that compound the noise problem we observe.
### 4.3 When Does Optimization Work?
The aggregate coin-flip statistic conceals a striking exception: on HelpSteer2, _all_ six methods beat zero-shot on Haiku (best Δ=+6.8\\Delta=+6.8 pts from EvoPrompt), and all methods reaching ≥\\geq74 pts independently discover the same structure.
Understanding _why_ this task succeeds is more actionable than the aggregate failure rate.
We caution that the “exploitable structure” explanation we develop next is a hypothesis derived from a single positive case (HelpSteer2): it explains the present results but has not been validated on held-out tasks. Our 10-minute headroom test (§ [6](https://arxiv.org/html/2604.14585#S6 "6 Practitioner Framework ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")) is the operational form of this hypothesis, applied prospectively rather than retrospectively.
#### The “can but doesn’t” pattern.
---
Our ANOVA decomposition produces falsifiable predictions that can be tested on any architecture: if a pipeline’s interaction F>1F>1, joint optimization is warranted; if F<1F<1, it is not.
This contrasts with typical compound AI evaluation, which reports aggregate task scores without decomposing _why_ a pipeline succeeds or fails.
We hope the methodology generalizes beyond prompt optimization to any setting where practitioners need to measure whether components of a compound system compose or operate independently.
#### Limitations.
Our grid uses K=10K{=}10 whole-prompt substitutions; finer-grained edits (single-constraint flips, structured component substitutions) could in principle expose interaction patterns that whole-prompt swaps mask, and we view the present result as evidence against _coarse_ prompt-level coupling specifically.
Both executor models (Claude Haiku 4.5, Amazon Nova Lite) are mid-tier; a frontier-tier executor would strengthen the model-specificity finding by triangulating the trend.
Study 2 uses 20 training questions, reflecting practitioner reality but potentially limiting iterative methods, and Study 2’s optimization tasks (FB/HS2/WB/XSum) overlap with Study 1 only on XSum; running optimization on the HotpotQA and MBPP pipelines would directly test whether the single-agent vs. two-agent design itself shifts optimization-worthiness, which we leave to future work.
Both studies use a single two-agent, feed-forward architecture; the hypotheses enumerated above about three-agent pipelines, shared scratchpads, feedback loops, and structured-data communication are plausible but untested here.
## 8 Conclusion

Prompt optimization in compound AI systems is not universally futile, but it is highly conditional.
We tested the two core assumptions underlying end-to-end optimization and found that agents do not interact (all F<1.0F<1.0 across 18,000 evaluations) and that individual optimization helps only when the task has exploitable output structure: the “can but doesn’t” pattern.
On the one task with this pattern, all six methods succeed; aggregating across all four tasks, 49% of runs score below zero-shot.
The key contribution is not the negative result, but the evaluation methodology: ANOVA variance decomposition provides a principled, falsifiable test for compositional behavior in multi-agent systems, and the headroom test diagnoses optimization-worthiness before committing resources.
Together, they turn a coin flip into an informed decision:

#### Recommendations.
1. 1.
Test for coupling ($80, 1 day). Run the ANOVA grid on your pipeline. If F<1F<1 for the interaction term, optimize agents independently and do not invest in joint optimization.
2. 2.
Test for headroom ($5, 10 min). Generate 10–20 candidate prompts. If the best gains <<2 pts over zero-shot, the landscape is flat; use zero-shot. If the gain is >>2 pts, look for the “can but doesn’t” pattern: a specific output format or structure the model knows but does not default to.
3. 3.
Re-test after every model update. Which agents matter, which tasks benefit, and which methods work all change with the model. Budget optimization as recurring, not one-time.
## Impact Statement

This paper presents work whose goal is to advance the field of compound AI system optimization.
Our diagnostic framework helps practitioners avoid wasted computation on ineffective prompt optimization, reducing both cost and environmental impact.
We find no ethical concerns specific to this work beyond those generally associated with advancing prompt engineering capabilities.
## References

- Austin et al. (2021)
Austin, J., Odena, A., Nye, M., Bosma, M., Michalewski, H., Dohan, D., Jiang,
E., Cai, C., Terry, M., Le, Q., and Sutton, C.
Program synthesis with large language models.
_arXiv preprint arXiv:2108.07732_, 2021.
- Chase (2022)
Chase, H.
Langchain.
2022.
[https://github.com/langchain-ai/langchain](https://github.com/langchain-ai/langchain "").
---
Study 1 (§ [3](https://arxiv.org/html/2604.14585#S3 "3 Study 1: Measuring Agent Coupling via ANOVA ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")) tests Assumption A via exhaustive grid evaluation of two-agent pipelines with ANOVA decomposition: _do we even need joint optimization?_ Study 2 (§ [4](https://arxiv.org/html/2604.14585#S4 "4 Study 2: When Does Individual Optimization Help? ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")) tests Assumption B by benchmarking six optimization methods against zero-shot baselines under equal compute budgets: _given that joint optimization is unnecessary, does individual optimization help?_ We then analyze _why_ it works when it does (§ [4.3](https://arxiv.org/html/2604.14585#S4.SS3 "4.3 When Does Optimization Work? ‣ 4 Study 2: When Does Individual Optimization Help? ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
#### Key findings.
1. 1.
Agents don’t interact. The A×BA\\times B interaction term is non-significant in all six model×\\timestask conditions (p>0.52p>0.52, all F<1.0F<1.0); joint optimization is unnecessary (§ [3](https://arxiv.org/html/2604.14585#S3 "3 Study 1: Measuring Agent Coupling via ANOVA ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")). § [7](https://arxiv.org/html/2604.14585#S7 "7 Discussion ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems") explains why this is mechanistically expected from instruction-tuning.
2. 2.
Optimization helps only when exploitable structure exists. The sole task where all methods succeed requires structured rubrics and JSON formatting, a format the model _can_ produce but does not default to. The other three tasks lack this gap (§ [4.3](https://arxiv.org/html/2604.14585#S4.SS3 "4.3 When Does Optimization Work? ‣ 4 Study 2: When Does Individual Optimization Help? ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
3. 3.
Model specificity dominates. Which agents matter, which tasks benefit, and which methods work all change with the executor model (§ [5](https://arxiv.org/html/2604.14585#S5 "5 The Dominant Factor Is Model, Not Prompt ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
4. 4.
A 10-minute test predicts optimization-worthiness. Generate 10–20 candidate prompts; when the best candidate gains <<2 pts over zero-shot, the landscape is flat and none of the six methods we tested reliably help. The 2-pt threshold is calibrated to our setup; the qualitative principle (flat landscape implies no useful headroom) is general (§ [6](https://arxiv.org/html/2604.14585#S6 "6 Practitioner Framework ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
Figure [1](https://arxiv.org/html/2604.14585#S3.F1 "Figure 1 ‣ 3 Study 1: Measuring Agent Coupling via ANOVA ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems") summarizes both studies; we distill the findings into a two-stage diagnostic framework: an $80 ANOVA pre-test for coupling, and a headroom test for optimization-worthiness (§ [6](https://arxiv.org/html/2604.14585#S6 "6 Practitioner Framework ‣ Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems")).
_Important caveat:_ our findings do not imply that compound AI systems are ineffective, nor that prompt optimization is universally useless. They show that, in our setup, we cannot reject the hypothesis that optimization performs no better than random; the practical implication is that optimization must be targeted at the right conditions, and that expensive joint optimization is unnecessary.