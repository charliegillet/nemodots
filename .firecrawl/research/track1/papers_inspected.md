=== PAPER 1: arxiv:2610.17358 (claimcheck) ===
# claimcheck: Measuring and Improving Specification Faithfulness

Paper ID: 3902247247780752882
IDs: arxiv:2610.17358
Authors: Martin Amster; One An; Holly Baker; Fernanda Graciolli; Simon Henniger; Nada Amin
Categories: cs.CL, cs.AI, cs.PL
Dates: created 2026-10-12; updated 2026-10-14

## Abstract
Formal verification proves that a program satisfies its specification, but says nothing about whether the specification captures what the author meant. As LLMs increasingly write both code and specifications, a gap between the author's natural-language requirement and the specification becomes a live risk. A machine-checked proof of a property narrower than the one requested is worthless but passes every check. Closing this gap is solving the spec formalization problem: given a natural-language requirement, produce a formal artifact whose meaning matches it. To measure the gap, we curate an end-to-end benchmark for spec formalization spanning four formal languages: Dafny contracts and Lean 4, Isabelle and Rocq theorem statements. Each of its 3,234 rows pairs a natural-language requirement with a formal artifact and a label established by execution, by proof, or by the benchmark it is drawn from. A third of the rows are meaning-preserving rewrites of the artifact that keep the faithful label, so a judge cannot score by detecting that a row was edited. We introduce claimcheck, a tool that detects incorrect formalizations: the formal artifact is translated back into plain English by a model that never sees the requirement, and a separate model, the judge, decides whether the informalization and the requirement express the same guarantee. On all four languages it gains 8.2 to 9.8 points of macro recall over a single call shown the requirement and the artifact, and 4.2 to 6.0 over that call handed the same list of meaning-preserving rewrites. Showing the judge the artifact as well costs 1.4 to 4.5 points. Across four judges that also see the artifact, the gain shrinks as the judge gets stronger, to within a point of the informed single call for the strongest.
Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY-SA 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2610.17358v1 \[cs.CL\] 12 Oct 2026

# claimcheck: Measuring and Improving Specification Faithfulness

Martin Amster
††thanks: Equal contribution, listed in alphabetical order; Apart Secure Program Synthesis fellows.Affiliation: Universidad de Buenos Aires
Affiliation: Buenos Aires, Argentina
Email: [mamster@dc.uba.ar](mailto:)One An11footnotemark: 1Affiliation: University of Pennsylvania
Affiliation: Philadelphia, PA 19104, USA
Email: [onean@engineering.upenn.edu](mailto:)Holly Baker11footnotemark: 1Affiliation: PolicingLab
Affiliation: Dublin, Ireland
Email: [baker@policinglab.org](mailto:)Fernanda Graciolli
Affiliation: Midspiral, Inc.
Affiliation: Cambridge, MA 02139, USA
Email: [fernanda@midspiral.com](mailto:)Simon Henniger
††thanks: Equal advising.Affiliation: Harvard University
Affiliation: Cambridge, MA 02138, USA
Email: [shenniger@fas.harvard.edu](mailto:)Nada Amin22footnotemark: 2Affiliation: Harvard University & Midspiral, Inc.
Affiliation: Cambridge, MA 02138 & MA 02139, USA
Email: [namin@seas.harvard.edu](mailto:)

###### Abstract

Formal verification proves that a program satisfies its specification, but says nothing about whether the specification captures what the author meant. As LLMs increasingly write both code and specifications, a gap between the author’s natural-language requirement and the specification becomes a live risk. A
machine-checked proof of a property narrower than the one requested is worthless but passes every check. Closing this gap is solving the spec formalization problem: given a natural-language requirement, produce a formal artifact whose meaning matches it.
To measure the gap, we curate an end-to-end benchmark for spec
formalization spanning four formal languages: Dafny contracts and Lean 4, Isabelle and Rocq theorem statements. Each of its 3,234 rows pairs a natural-language requirement with a formal artifact and a label established by execution, by proof, or by the benchmark it is drawn from. A third of the rows are meaning-preserving rewrites of the artifact that keep the faithful label, so a judge cannot score by detecting that a row was edited.
We introduce claimcheck, a tool that detects incorrect formalizations: the formal artifact is translated back into plain English by a model that never sees the requirement, and a separate model, the judge, decides whether the informalization and the requirement express the same guarantee. On all four languages it gains 8.28.2 to 9.89.8 points of macro recall over a single call shown the requirement and the artifact, and 4.24.2 to 6.06.0 over that call handed the same list of meaning-preserving rewrites. Showing the judge the artifact as well costs 1.41.4 to 4.54.5 points. Across four judges that also see the artifact, the gain shrinks as the judge gets stronger, to within a point of the informed single call for the strongest.
|     |
| --- |
|  |

## 1 Introduction

As models get better at writing code, the programmer’s job shifts toward saying _what_ a program should do rather than _how_ it should do it. Spec-driven development already works this way: the developer states the requirement in English, and the implementation is generated from it. The hard part moves from writing the code to knowing whether it does what was asked.
For most of what a model produces there is no automatic way to tell, and checking falls to a human or to another model ( [Zheng et al., 2023](https://arxiv.org/html/2610.17358#bib.bib33 "")). Formal languages are the exception.
---
In Isabelle and Rocq negate is
92%92\\% and 83%83\\% of the disputed rows, and asserting the negation of a statement
is the easiest defect in the benchmark to catch, so what separates systems on
those two slices is almost entirely the confirmed side; and there the three
trivial wrappers are about 45%45\\% of the rows, which tests whether a judge is
disturbed by structure carrying no meaning rather than whether it can read a
specification. Lean and Dafny carry defects of several strengths and are where
the disputed half discriminates.
The labels also carry different warrants. Every control was shown to preserve
meaning, by the Dafny verifier, by a tactic list in Lean, or by a propositional
argument in Isabelle and Rocq, but the semantic mutations rest on the rule that
produced them, and for bump\_const and strictness that is
intent alone, since a moved numeral or a loosened bound will in rare cases leave
a statement equivalent to the one it replaced. And all four slices are single
contracts or single theorem statements, short enough that a requirement and its
formalization can be held in view at once. Artifacts whose meaning lives in
their structure rather than in a proposition, and developments too long to read
in one pass, are outside what we measure; finding such tasks is the main thing we
would change before making a stronger claim.
## 8 Conclusion

claimcheck checks whether a formal artifact means what the
natural-language requirement it was written from asks for, which is the
question a verifier never asks. It does so in two model calls: one
informalizes the artifact without seeing the requirement, the other compares
the two English texts. Across Dafny contracts and Lean, Isabelle and Rocq
theorem statements it gains 8.28.2 to 9.89.8 points of macro recall over a direct
judge, and 4.24.2 to 6.06.0 over the same judge handed the same list of
meaning-preserving rewrites in a single call. Undoing any of its three choices lowers the score: removing the back-translation costs 2.82.8 to 6.06.0 points,
letting the informalizer see the requirement up to 3.03.0, and showing the judge
the artifact up to 4.54.5.
## Acknowledgments

Claimcheck was initially developed as part of a Claude Code hackathon; we thank Anthropic for their support in the context of that. We also thank Apart Research and their Secure Program Synthesis fellowship organizers, especially Eitán Sprejer, Max von Hippel and Quinn Dougherty. Simon Henniger was supported by the Harvard John A. Paulson School of Engineering and Applied Sciences (SEAS) Prize Fellowship and the German Academic Fellowship Organization, funded by the German Federal Ministry for Economic Affairs and Energy.
## Code Availability

Our code is available at [https://github.com/metareflection/claimcheck](https://github.com/metareflection/claimcheck "").
## References

- Agarwal et al. (2026)A. Agarwal, N. Neamtu, P. Aggarwal, S. Kim, J. Limperg, C. Flamant, K. Shimizu, B. Parno, and S. WelleckVerus-specgym: an agentic environment for evaluating specification autoformalization.
arXiv preprint arXiv:2605.26457.
Cited by: [§6](https://arxiv.org/html/2610.17358#S6.SS0.SSS0.Px3.p1.1 "Judging against the requirement directly. ‣ 6 Related Work ‣ claimcheck: Measuring and Improving Specification Faithfulness").
- Aggarwal et al. (2025)P. Aggarwal, B. Parno, and S. WelleckAlphaVerus: bootstrapping formally verified code generation through self-improving translation and treefinement.
In Proceedings of the 42nd International Conference on Machine Learning (ICML),
Note: arXiv:2412.06176Cited by: [§6](https://arxiv.org/html/2610.17358#S6.SS0.SSS0.Px1.p1.1 "Specifications that verify but say the wrong thing. ‣ 6 Related Work ‣ claimcheck: Measuring and Improving Specification Faithfulness").
- Amrollahi et al. (2026)D. Amrollahi, J. Lopez, and C. BarrettFaithful autoformalization via roundtrip verification and repair.
arXiv preprint arXiv:2604.25031.
---
Here the requirement is first written down as a specification: a precise statement of what the program must guarantee, in a form a machine can check. A verifier then proves that the code meets that specification on every
possible input. But the verifier only ever sees the specification. It never sees the natural-language requirement that specification was written from, so it cannot tell whether the specification asked for the right thing.
Suppose the requirement is to sort a list. The specification says the output must be in increasing order, and the code is proved to satisfy it. Now take a program that ignores its input and returns an empty list. Nothing in an empty list is out of order, so that program meets the specification too, and the same proof would go through. The specification never said the output has to contain the same items as the input. This is the part no verifier covers. In our Dafny ( [Leino, 2010](https://arxiv.org/html/2610.17358#bib.bib4 "")) slice every row we labelled defective still passes verification, so a verified artifact can carry an assurance it has not earned. We call the task of getting it right _spec formalization_: given a natural-language requirement, produce a formal artifact whose meaning matches it.
contractDafny verifies ✓

method SquareRoot(N:nat)

returns (r:nat)

ensures r\*r <= Nrequirement

Find the square root of a natural number.step 1informalizehaiku-4.5back-translation

“This contract guarantees that the returned natural number r, when
squared, is less than or equal to the input natural number N.”\+ preconditions, postcondition, scope, strengthstep 2comparesonnet-4.6verdictdisputedpostcondition-too-weak

“The contract only ensures r\*r <= N, but is missing the upper bound
(r+1)\*(r+1) > N. Any value from 0 to floor(sqrt(N)) would
satisfy the contract, including r=0 for all inputs.”baseline: one call, shown both sides at once, answers yes or no.
macro recall, baseline →\\rightarrowclaimcheck:

Dafny 84.0 →\\rightarrow93.1  Lean 79.7 →\\rightarrow87.9

Isabelle 81.5 →\\rightarrow91.3  Rocq 79.6 →\\rightarrow88.0never shownFigure 1: One claimcheck run, on a Dafny contract from CloverBench
whose postcondition was weakened (class C2). Like the sorting
example, the contract still verifies and is satisfied by returning zero.
Step 1 translates the contract into English without ever seeing the
requirement, so the informalization can only report what the contract says.
Step 2 compares the informalization with the requirement and names the
discrepancy; it never sees the contract. Colours follow the data:
blue is the natural-language requirement, amber the formal artifact, green its
informalization. A single-call baseline shown both sides at once scores lower
on all four languages (Table [2](https://arxiv.org/html/2610.17358#S5.T2 "Table 2 ‣ 5.1 Main results ‣ 5 Results ‣ claimcheck: Measuring and Improving Specification Faithfulness")).
We introduce claimcheck, a tool that checks whether a formal artifact means what its natural-language requirement asks for. The direct way to check this is to show a model both the requirement and the specification and ask whether they agree ( [Cabral et al., 2026](https://arxiv.org/html/2610.17358#bib.bib12 ""); [Zhang et al., 2026](https://arxiv.org/html/2610.17358#bib.bib30 ""); [Lu et al., 2025](https://arxiv.org/html/2610.17358#bib.bib7 "")). The trouble is that the requirement gives the answer away. A model that has just read _sort a list_ expects the specification to describe sorting, and is biased toward agreeing that it does. Telling the model not to do this is an instruction it can fail to follow, so claimcheck separates reading the specification from judging it. A first model, the informalizer, puts the specification into plain English — its preconditions, its postcondition, its scope — without ever seeing the requirement, so what it writes can only report what the specification says.
---
We call this the informalization ( [Wu et al., 2022](https://arxiv.org/html/2610.17358#bib.bib5 ""); [Amrollahi et al., 2026](https://arxiv.org/html/2610.17358#bib.bib10 "")).
A second model, the judge, then compares the informalization against the requirement (Figure [1](https://arxiv.org/html/2610.17358#S1.F1 "Figure 1 ‣ 1 Introduction ‣ claimcheck: Measuring and Improving Specification Faithfulness")). What it compares is two English texts, one saying what was asked for and the other what the artifact guarantees, and the one it reads was written before the requirement could shape it. We also report the variant that hands the judge the artifact alongside the informalization; it is the weaker of the two on all four of our languages, by 1.41.4 to 4.54.5 points of macro recall.
### 1.1 Contributions

Our paper’s main contributions are:

1. 1.
We curate a test suite for end-to-end formalization of
natural-language requirements, spanning four formal languages: Dafny
contracts and Lean 4, Isabelle and Rocq theorem statements.
Its 3,234 rows pair a requirement with a formal artifact and a label established by execution, by proof, or by the benchmark it is drawn from, and are scored by a standardized grader (Section [2](https://arxiv.org/html/2610.17358#S2 "2 Benchmark Design ‣ claimcheck: Measuring and Improving Specification Faithfulness")).
Benchmarks of this kind
are built by mutation, so their labels record whether a row was edited
rather than what it now means. A third of our rows are control mutations,
which rewrite the formal artifact while preserving its meaning and stay
labelled faithful, so detecting edits is no longer enough to score.
2. 2.
We measure baseline scores for frontier models. A single-prompt judge shown the requirement and the artifact reaches between 79.679.6 and 84.084.0 macro recall across the four languages, and errs in both directions: on Dafny it disputes 20%20\\% of the faithful contracts while missing a quarter of the rows whose requirement carries the defect.
Handing that same single call the list of meaning-preserving rewrites and the error vocabulary claimcheck’s judge is given raises it by 33 to 55 points on all four languages, so we report it as a second baseline throughout: it is what separates the pipeline from the information in its prompt (Section [5](https://arxiv.org/html/2610.17358#S5 "5 Results ‣ claimcheck: Measuring and Improving Specification Faithfulness")).
3. 3.
We introduce claimcheck, the two-step tool of
Figure [1](https://arxiv.org/html/2610.17358#S1.F1 "Figure 1 ‣ 1 Introduction ‣ claimcheck: Measuring and Improving Specification Faithfulness"). Comparing the two English texts gains 4.24.2 to 6.06.0 points of macro recall over that informed baseline on all four, most of it on the faithful rows, originals and controls alike. Three ablations locate the gain: removing the back-translation costs 2.82.8 to 6.06.0 points, giving the informalizer the requirement it is otherwise denied costs 0.80.8 to 3.03.0, and holding rewrites out of the judge’s list moves macro recall by at most a point, so that list is not acting as an answer key for the benchmark’s controls.
Varying the judge, with the artifact in its view, shows the gain is substitutive rather than additive: up to 2727 points for the weakest model we test and none for the strongest
(Section [5](https://arxiv.org/html/2610.17358#S5 "5 Results ‣ claimcheck: Measuring and Improving Specification Faithfulness")).
## 2 Benchmark Design

Each row is a natural-language requirement, a formal artifact meant
to express it, and the context needed to read that artifact, and its label says whether the artifact means what the requirement asks for: confirmed or disputed.
=== PAPER 2: arxiv:2606.30931 (RoPoLL) ===
# RoPoLL: Robust Panel of LLM Judges

Paper ID: 5138280609977348151
IDs: arxiv:2606.30931
Authors: Anish Acharya; Kris W Pan; Brian Verkhovsky
Categories: cs.AI, cs.LG, cs.MA, math.OC, math.PR
Dates: created 2026-06-29; updated 2026-07-01

## Abstract
The LLM Jury, a Panel of LLM Evaluators (PoLL) reporting consensus scores, has become a practical alternative to single-judge LLM evaluation, yet its statistical behavior remains poorly understood. We formalize the LLM Jury under the Huber contamination model and show that PoLL incurs unbounded bias under any positive contamination, regardless of jury size, whenever a single judge fails in a biased, LLM-typical way (mode collapse, sycophancy, safety refusal). Framing jury consensus as classical robust mean estimation, we propose RoPoLL (Robust Panel of LLM-as-Judge), which preserves the PoLL panel but replaces the aggregation function with a robust mean estimator, instantiated with the geometric median (GM): tuning-free, with the optimal finite-sample breakdown point 1/2. A finite-sample error bound and a matching information-theoretic minimax lower bound agree on the parametric rate sigma*sqrt(d/N) and differ on the breakdown floor by a factor of sqrt(d), a statistical-computational gap that polynomial-time RoPoLL pays relative to the intractable Tukey halfspace median. Across 13 open-weight judges (4B-675B), three reward-model benchmarks, and four corruption regimes at rates up to 50%, RoPoLL dominates PoLL on every biased corruption type: by about 19% on cross-dimensional attacks at matched compute, and by orders of magnitude on heavy-tailed Byzantine adversaries. A 3-judge RoPoLL committee at 38B beats Mistral-Large-3 (675B) by 1.31x on HelpSteer-2 under 30% bimodal-random corruption, an 18x parameter advantage at better accuracy; a Noisy-GT control confirms the premium is paid against biased contamination, not benign imprecision.
‣ 4.3 The Weiszfeld Iteration ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges"), § [4.3](https://arxiv.org/html/2606.30931#S4.SS3 "4.3 The Weiszfeld Iteration ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges")) at
O​(N​d​log⁡(1/ϵ))O(Nd\\log(1/{\\epsilon})) per query.
CoMed and the trimmed mean serve as empirical baselines in
§ [6](https://arxiv.org/html/2606.30931#S6 "6 Experiments ‣ RoPoLL: Robust Panel of LLM Judges").
#### Contributions.
- •

Formalisation.
We give the first formal treatment of LLM jury aggregation as a
robust mean-estimation problem
(§ [3](https://arxiv.org/html/2606.30931#S3 "3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges")):
we model the LLM-as-Judge pipeline as a Markov kernel
(Definition [4](https://arxiv.org/html/2606.30931#Thmdefinition4 "Definition 4 (LLM-As-Judge). ‣ 3.2 Reference Protocol, Rubric, and Parser ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges")), define the LLM Jury
(Definition [5](https://arxiv.org/html/2606.30931#Thmdefinition5 "Definition 5 (LLM Jury). ‣ 3.3 LLM Jury and Aggregation Function ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges")), and characterise judge failures
as Byzantine faults under the Huber contamination model
(Assumption [2](https://arxiv.org/html/2606.30931#Thmassumption2 "Assumption 2 (Huber ϵ-Contamination Model). ‣ 3.4 Huber Contamination Model and Companion Assumptions ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges")).
Proposition [2](https://arxiv.org/html/2606.30931#Thmproposition2 "Proposition 2 (Unbounded Bias of PoLL). ‣ 3.6 Fragility of PoLL ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges") shows that PoLL
admits unbounded bias under this model.
- •

Algorithm and theory.
We propose RoPoLL (§ [4](https://arxiv.org/html/2606.30931#S4 "4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges")) and
establish its theoretical guarantees (§ [5](https://arxiv.org/html/2606.30931#S5 "5 Theoretical Guarantees ‣ RoPoLL: Robust Panel of LLM Judges")):
a finite-sample upper bound
‖𝐲^GM−𝐲⋆‖2≤Cα+β​ρ\\\|\\hat{{\\mathbf{y}}}\_{\\mathrm{GM}}-{\\mathbf{y}}^{\\star}\\\|\_{2}\\leq C\_{\\alpha+\\beta}\\rho
with explicit absolute constants
(Theorem [1](https://arxiv.org/html/2606.30931#Thmtheorem1 "Theorem 1 (RoPoLL Breakdown Bound under Huber Contamination). ‣ 5.1 Finite-Sample Error Bound ‣ 5 Theoretical Guarantees ‣ RoPoLL: Robust Panel of LLM Judges")),
a correlated-jury extension under the equicorrelated-indicator
hypothesis (Lemma [3](https://arxiv.org/html/2606.30931#Thmlemma3 "Lemma 3 (RoPoLL under Equicorrelated Juries). ‣ Beyond i.i.d.: equicorrelated juries. ‣ 5.1 Finite-Sample Error Bound ‣ 5 Theoretical Guarantees ‣ RoPoLL: Robust Panel of LLM Judges"), with empirical
indicator-correlation γ¯W∈\[0.45,0.53\]\\bar{\\gamma}\_{W}\\in\[0.45,0.53\]
measured on our judge panels,
[Section˜6.10](https://arxiv.org/html/2606.30931#S6.SS10 "6.10 Empirical Indicator Correlation 𝛾̄_𝑊 ‣ 6 Experiments ‣ RoPoLL: Robust Panel of LLM Judges")), and an information-theoretic
minimax lower bound (Theorem [2](https://arxiv.org/html/2606.30931#Thmtheorem2 "Theorem 2 (Minimax Lower Bound). ‣ 5.2 Minimax Lower Bound ‣ 5 Theoretical Guarantees ‣ RoPoLL: Robust Panel of LLM Judges")) that
matches on the parametric rate σ​d/N\\sigma\\sqrt{d/N} and differs
on the breakdown floor by a d\\sqrt{d}
statistical–computational gap, attributed to GM’s
polynomial-time tractability relative to the (intractable)
Tukey halfspace median.
- •

Large-scale empirical validation.
---
Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2606.30931v1 \[cs.AI\] 29 Jun 2026

# RoPoLL: Robust Panel of LLM Judges

Anish Acharya

Amazon Web Services

achanish@amazon.com

&Kris W. Pan

Amazon Web Services

kriswpan@amazon.com

&Brian Verkhovsky

Amazon Web Services

bverkhov@amazon.com

Corresponding author.
Abstract.The LLM Jury, a _Panel of LLM Evaluators_
(PoLL) (Verga et al., [2024](https://arxiv.org/html/2606.30931#bib.bib5 "Replacing judges with juries: evaluating llm generations with a panel of diverse models")) reporting consensus
scores, has become a practical alternative to single judge LLM
evaluation, yet its statistical behaviour remains poorly
understood.
We formalize the LLM Jury setup under the Huber contamination model,
and show that PoLL incurs unbounded bias under any positive
contamination, regardless of jury size, whenever a single judge
fails in a biased, LLM-typical way (mode collapse, sycophancy,
safety refusal).
We frame the jury consensus problem as an instance of classical
robust mean estimation and
propose RoPoLL (Robust Panel
of LLM-as-Judge), which preserves the
PoLL panel and substitutes the aggregation function with a robust mean estimator.
Among classical robust estimators, we instantiate RoPoLL
with the geometric median (GM), a tuning-free,
joint-distance-preserving mean estimator that yields the optimal finite-sample breakdown
point 1/21/2.
We establish a finite-sample error bound and an
information-theoretic minimax lower bound that match on the
parametric rate σ​d/N\\sigma\\sqrt{d/N} and differ on the breakdown
floor by a factor of d\\sqrt{d} – a
statistical-computational gap that polynomial-time RoPoLL
pays relative to the (intractable) Tukey halfspace median.
Across 1313 open-weight judges (44 B–675675 B), three
reward-model benchmarks, and four corruption regimes at rates up
to 50%50\\%, RoPoLL dominates PoLL on every biased
corruption type: by ≈19%\\approx 19\\% on cross-dimensional attacks at
matched compute, and by orders of magnitude on heavy-tailed
Byzantine adversaries (whose unbounded first moments make any
breakdown-positive aggregator beat averaging unconditionally).
A 33-judge RoPoLL committee at 3838 B beats
Mistral-Large-3 (675675 B) by 1.31×1.31\\times on HelpSteer-2 under
30%30\\%bimodal-random corruption – an 18×18\\times parameter
advantage with strictly better accuracy.
A Noisy-GT control confirms the premium is paid against
_biased_ contamination, not benign Gaussian imprecision (where
PoLL is statistically optimal).
Overall, we establish that robust aggregation of a small, diverse committee is a
parameter-efficient and statistically principled alternative to
scaling a single large LLM-as-judge.Correspondence:achanish@amazon.com![[Uncaptioned image]](https://arxiv.org/html/2606.30931v1/x1.png)

## 1 Introduction

Reliable evaluation remains the bottleneck in aligning Large
Language Models (LLMs).
Human evaluation, while the gold standard, does not scale to the
iterative development cycles that modern alignment pipelines
demand.
The field has therefore converged on the _LLM-as-a-Judge_
paradigm (Zheng et al., [2023](https://arxiv.org/html/2606.30931#bib.bib1 "Judging llm-as-a-judge with mt-bench and chatbot arena")), in which another LLM
(typically a frontier model) acts as a referee, scoring outputs
along one or more quality attributes.
---
‣ 3.4 Huber Contamination Model and Companion Assumptions ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges")—and trade
independence for deliberation-driven error reduction.
Whether they exhibit the same Byzantine-failure mode as PoLL
is an open question.
The Huber-contamination analysis of this paper does not directly
apply to such interactive aggregators, but the corruption-class
diagnosis (point masses far from the truth) likely transfers,
suggesting robust extensions of debate-based aggregation as a future
direction.
Majority voting in mathematical reasoning
(Cobbe et al., [2021](https://arxiv.org/html/2606.30931#bib.bib13 "Training verifiers to solve math word problems")) is a related but coarser ensemble
technique on binary correctness;
the analogue of Proposition [2](https://arxiv.org/html/2606.30931#Thmproposition2 "Proposition 2 (Unbounded Bias of PoLL). ‣ 3.6 Fragility of PoLL ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges") for vote-based
aggregation on {0,1}\\{0,1\\} outputs is the standard α<1/2\\alpha<1/2
Byzantine threshold.
Calibration as a complementary paradigm.
A separate line of work removes judge bias _at the source_ via
per-judge calibration on a labeled validation slice
(Zheng et al., [2023](https://arxiv.org/html/2606.30931#bib.bib1 "Judging llm-as-a-judge with mt-bench and chatbot arena")).
Calibration assumes a stationary, recoverable bias and trades
worst-case guarantees for average-case efficiency;
RoPoLL assumes nothing on the corruption distribution and
pays a constant-factor insurance premium to bound the worst case.
The two are complementary: RoPoLL can aggregate calibrated
scores, and the calibration-RoPoLL composition—together with
extensions to heterogeneous, correlated, and dependent juries—is
left to future work.
Robust statistics and the geometric median.
The Huber contamination model (Huber, [1964](https://arxiv.org/html/2606.30931#bib.bib31 "Robust estimation of a location parameter")) and the
breakdown point (Tukey, [1960](https://arxiv.org/html/2606.30931#bib.bib15 "A survey of sampling from contaminated distributions")) are the classical framework
for estimation under arbitrary corruption.
The geometric median attains the optimal 1/21/2 breakdown for any
translation-equivariant estimator
(Lopuhaä and Rousseeuw, [1991](https://arxiv.org/html/2606.30931#bib.bib26 "Breakdown points of affine equivariant estimators of multivariate location and covariance matrices"); Small, [1990](https://arxiv.org/html/2606.30931#bib.bib27 "A survey of multidimensional medians"); Vardi and Zhang, [2000](https://arxiv.org/html/2606.30931#bib.bib28 "The multivariate L1-median and associated data depth"));
in high dimensions, Minsker ( [2015](https://arxiv.org/html/2606.30931#bib.bib30 "Geometric median and robust estimation in Banach spaces")) established
sub-Gaussian concentration for the geometric median of
means—the result Theorem [1](https://arxiv.org/html/2606.30931#Thmtheorem1 "Theorem 1 (RoPoLL Breakdown Bound under Huber Contamination). ‣ 5.1 Finite-Sample Error Bound ‣ 5 Theoretical Guarantees ‣ RoPoLL: Robust Panel of LLM Judges") adapts to
contaminated juries—and Lugosi and Mendelson ( [2019](https://arxiv.org/html/2606.30931#bib.bib16 "Sub-Gaussian mean estimators")) developed
sub-Gaussian mean estimators with optimal dimension dependence.
Recent applications to ML pipelines include block-coordinate GM
descent for robust training (Acharya et al., [2022](https://arxiv.org/html/2606.30931#bib.bib33 "Robust training in high dimensions via block coordinate geometric median descent")) and GM
Matching for robust subset selection
(Acharya et al., [2025](https://arxiv.org/html/2606.30931#bib.bib32 "Geometric median (GM) matching for robust k-subset selection from noisy data"));
Acharya ( [2025](https://arxiv.org/html/2606.30931#bib.bib34 "Robust and efficient learning in high dimensions from noisy data")) surveys robust learning from noisy data.
---
‣ 3.6 Fragility of PoLL ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges"), § [3.6](https://arxiv.org/html/2606.30931#S3.SS6 "3.6 Fragility of PoLL ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges"))
shows that under _any_ positive contamination rate
PoLL’s conditional bias grows linearly with the corruption
shift and is unbounded over the corruption class, regardless of
NN:
the 1/N1/N variance reduction that motivates juries cannot rescue
an aggregator whose bias is itself unbounded.
![Refer to caption](https://arxiv.org/html/2606.30931v1/)(a) HelpSteer 2

![Refer to caption](https://arxiv.org/html/2606.30931v1/x3.png)(b) HelpSteer 3

![Refer to caption](https://arxiv.org/html/2606.30931v1/x4.png)(c) UltraFeedback

Figure 1: PoLL vs. RoPoLL under heavy-tailed
cauchy-far corruption.
RMSE vs. per-case corruption rate rr (log yy-axis) for the
Medium jury (N=3N{=}3, ≈89{\\approx}89 B), with the best single
open-weight judge as a gray dashed reference; coordinate-wise
Median is competitive with RoPoLL here and is
omitted (full three-method comparison in
[Figure˜12](https://arxiv.org/html/2606.30931#S6.F12 "In 6.6 Jury-Size Ablation and Corruption-Type Dependence ‣ 6 Experiments ‣ RoPoLL: Robust Panel of LLM Judges")). Each corrupted slot is drawn as
y^=y⋆+10+2​(smax−smin)​T\\hat{y}=y^{\\star}+10+2(s\_{\\max}{-}s\_{\\min})\\,T with TT
component-wise standard Cauchy: a biased heavy-tailed Byzantine
attack with undefined mean and variance, instantiating the
adversarial choice in Proposition [2](https://arxiv.org/html/2606.30931#Thmproposition2 "Proposition 2 (Unbounded Bias of PoLL). ‣ 3.6 Fragility of PoLL ‣ 3 Problem Setup ‣ RoPoLL: Robust Panel of LLM Judges").
#### Overview of our approach.
We propose RoPoLL (Robust Panel of
LLM-as-Judge), a drop-in replacement for the
arithmetic-mean aggregation step of PoLL with a robust
mean estimator.
Among classical candidates—the coordinate-wise median (CoMed),
the trimmed mean, and the geometric median (GM)—only GM is
simultaneously _tuning-free_ (no contamination-rate hyperparameter
unlike the trimmed mean), _joint-distance preserving_ (operates
on Euclidean distance over the full score vector unlike CoMed,
which decouples coordinates and misses cross-attribute structure
of Example [1](https://arxiv.org/html/2606.30931#Thmexample1 "Example 1 (Cross-Dimensional Corruption). ‣ Coordinate-wise median. ‣ 4.1 Choosing the Robust Estimator ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges")), and attains the optimal 1/21/2
breakdown point (Definition [8](https://arxiv.org/html/2606.30931#Thmdefinition8 "Definition 8 (Finite-Sample Breakdown Point). ‣ 4.2 The Geometric Median: Definition and Properties ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges"),
Proposition [3](https://arxiv.org/html/2606.30931#Thmproposition3 "Proposition 3 (Properties of the Geometric Median). ‣ 4.2 The Geometric Median: Definition and Properties ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges"));
the comparison is developed in detail in § [4.1](https://arxiv.org/html/2606.30931#S4.SS1 "4.1 Choosing the Robust Estimator ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges").
We instantiate RoPoLL with the geometric median
(Definition [7](https://arxiv.org/html/2606.30931#Thmdefinition7 "Definition 7 (RoPoLL via Geometric Median). ‣ 4.2 The Geometric Median: Definition and Properties ‣ 4 Robust Panel of LLM Judges ‣ RoPoLL: Robust Panel of LLM Judges")), computed via the modified Weiszfeld
iteration (Algorithm [1](https://arxiv.org/html/2606.30931#alg1 "Algorithm 1 ‣ Derivation.
=== PAPER 3: arxiv:2609.40103 (JuryFlow) ===
# JuryFlow: Disagreement-Guided Human-in-the-Loop Multi-Agent Evaluation

Paper ID: 6957937841667878342
IDs: arxiv:2609.40103
Authors: Mufeng Yang; Junwei Yu; Yepeng Ding
Categories: cs.CL, cs.HC
Dates: created 2026-09-30; updated 2026-10-01

## Abstract
Large language models (LLMs) are increasingly deployed as automated judges for AI-generated content, yet a single judge is unreliable and even a panel of judges leaves a hard residue: when judges disagree, majority voting discards the conflict instead of resolving it. We present JuryFlow, a disagreement-guided, human-in-the-loop multi-agent evaluation framework that treats inter-judge disagreement not as noise to be averaged away, but as a precise, claim-level signal indicating where an evaluation is uncertain. JuryFlow decomposes each candidate response into atomic claims, has a panel of heterogeneous judges assign per-claim verdicts, and builds a disagreement graph whose nodes are scored by verdict entropy and whose edges encode structural similarity between claims. A human acts as a structural guide, selecting which disagreement to resolve through a single, minimal intervention rather than re-labeling the response, after which the focal claim is re-evaluated, the correction propagates along graph edges and to historically similar cases, and is crystallized into reusable rubric entries that all judges inherit, making the evaluator progressively self-refining. To enable large-scale, reproducible benchmarking without human studies, we evaluate JuryFlow in an automatic configuration in which focal selection is made by entropy ranking. On MT-Bench and LLMBar, JuryFlow improves agreement with gold labels over single-judge and majority-vote panel baselines, and ablations isolate the contributions of disagreement-targeted re-evaluation, propagation, and rubric induction. We contribute (1) a human-in-the-loop paradigm that recasts the human from labeler to structural guide, (2) the JuryFlow framework operationalizing it through a disagreement graph, focal re-evaluation, and closed-loop rubric induction, and (3) an evaluation protocol with ablations that isolate where the gains originate.
We present JuryFlow, a disagreement-guided, human-in-the-loop multi-agent evaluation framework that treats inter-judge disagreement not as noise to be averaged away, but as a precise, claim-level signal indicating where an evaluation is uncertain. JuryFlow decomposes each candidate response into atomic claims, has a panel of heterogeneous judges assign per-claim verdicts, and builds a disagreement graph whose nodes are scored by verdict entropy and whose edges encode structural similarity between claims. A human acts as a structural guide, i.e., selecting which disagreement to resolve through a single, minimal intervention rather than re-labeling the response, after which the focal claim is re-evaluated, the correction propagates along graph edges and to historically similar cases, and is crystallized into reusable rubric entries that all judges inherit, making the evaluator progressively self-refining. To enable large-scale, reproducible benchmarking without human studies, we evaluate JuryFlow in an automatic configuration in which the focal selection is made by entropy ranking. On MT-Bench and LLMBar, JuryFlow improves agreement with gold labels over single-judge and majority-vote panel baselines, and ablations isolate the contributions of disagreement-targeted re-evaluation, propagation, and rubric induction. We contribute (1) a human-in-the-loop paradigm that recasts the human from labeler to structural guide, (2) the JuryFlow framework operationalizing it through a disagreement graph, focal re-evaluation, and closed-loop rubric induction, and (3) an evaluation protocol with ablations that isolate where the gains originate.
###### Keywords:

Disagreement Graph, Multi-Agent Evaluation, Human-in-the-Loop, LLM-as-a-Judge, Uncertainty Quantification, Self-Refining Evaluation, Rubric Induction

††cc-license: by

## 1\. Introduction

Large language models (LLMs) are increasingly used as automated judges to
evaluate AI-generated content at scale, such as ranking chatbot responses,
scoring factuality, and screening for safety ( [Zheng et al., 2023](https://arxiv.org/html/2609.40103#bib.bib1 ""); [Liu et al., 2023](https://arxiv.org/html/2609.40103#bib.bib2 ""); [Dubois et al., 2024](https://arxiv.org/html/2609.40103#bib.bib3 "")).
A single LLM judge is susceptible to position, verbosity, and self-enhancement
biases ( [Wang et al., 2023](https://arxiv.org/html/2609.40103#bib.bib4 ""); [Zheng et al., 2024](https://arxiv.org/html/2609.40103#bib.bib5 ""); [Panickssery et al., 2024](https://arxiv.org/html/2609.40103#bib.bib9 "")).
Its verdicts are particularly fragile in fine-grained, few-shot settings with
ambiguous criteria, conflicting standards, or incomplete evidence. A
_panel_ of heterogeneous judges can reduce model-specific bias and improve
agreement with human preferences ( [Verga et al., 2024](https://arxiv.org/html/2609.40103#bib.bib8 ""); [Chan et al., 2023](https://arxiv.org/html/2609.40103#bib.bib6 "")). Yet
the panel still requires a resolution procedure when its judges disagree.
The standard response is to aggregate the conflicting verdicts through
majority voting or confidence-weighted reconciliation ( [Chen et al., 2024](https://arxiv.org/html/2609.40103#bib.bib20 ""); [Jiang et al., 2023](https://arxiv.org/html/2609.40103#bib.bib18 "")).
This procedure discards useful information. Inter-judge disagreement provides
a claim-level indication of _where_ an evaluation is
uncertain ( [Seung et al., 1992](https://arxiv.org/html/2609.40103#bib.bib16 ""); [Lakshminarayanan et al., 2017](https://arxiv.org/html/2609.40103#bib.bib15 "")). Claims with
conflicting verdicts are also those for which a holistic verdict is least
reliable. Existing methods either operate at a coarser granularity or require
more human effort.
---
(2023)](https://arxiv.org/html/2609.40103#bib.bib19 "") use atomic
facts as the unit of factuality evaluation and show that binary holistic
judgments are inadequate when a response contains both supported and unsupported claims;
[Wei et al. (2024)](https://arxiv.org/html/2609.40103#bib.bib12 "") add search-augmented verification against retrieved
evidence; and [Kim et al. (2024b)](https://arxiv.org/html/2609.40103#bib.bib24 "") carry claim-level analysis into
open-ended evaluation through customizable rubrics.
Evaluation design also varies by domain. In particular, [Ye et al. (2023)](https://arxiv.org/html/2609.40103#bib.bib10 "")
decompose evaluation into 12 fine-grained skills with separate rubrics and show that
dimension-specific prompting outperforms unified assessment. Safety evaluation
requires judge architectures that differ from those used for factuality or
coherence ( [Inan et al., 2023](https://arxiv.org/html/2609.40103#bib.bib11 "")).
Beyond static rubrics, iterative alignment between human intent and automated
evaluation has been studied through mixed-initiative interfaces.
[Shankar et al. (2024)](https://arxiv.org/html/2609.40103#bib.bib25 "") define _criteria drift_ as the change in users’
evaluation standards as they inspect more outputs. They identify this drift as
a central obstacle to specifying criteria before observing model behavior.
[Kim et al. (2024c)](https://arxiv.org/html/2609.40103#bib.bib26 "") show that interactive criteria refinement reduces the
number of required prompt revisions by 59%. In addition,
[Gebreegziabher et al. (2025)](https://arxiv.org/html/2609.40103#bib.bib34 "") present MetricMate,
which supports hierarchical criteria definition and calibration through curated
success/failure examples.
These tools address the upstream task of articulating and stabilizing evaluation
criteria. JuryFlow addresses the complementary downstream problem of resolving
claim-level disagreement under established criteria. It identifies the claim
with the highest entropy within an instance and directs re-evaluation to that
claim.
### 2.3. Uncertainty-Driven Human Escalation and Active Learning

A related line of work studies when and how uncertain automated judgments should
be escalated for human oversight.
[Jung et al. (2025)](https://arxiv.org/html/2609.40103#bib.bib21 "") propose _Trust or Escalate_, establishing provable
guarantees of human agreement by routing low-confidence LLM evaluations to
stronger models through a cascaded selective evaluation framework;
[Wang et al. (2024)](https://arxiv.org/html/2609.40103#bib.bib22 "") show that routing only low-verifier-score labels to
human re-annotators cuts annotation cost while preserving label quality; and
[Kim et al. (2024a)](https://arxiv.org/html/2609.40103#bib.bib23 "") operationalize the principle in MEGAnno+, a
deployed system for human verification of LLM-generated labels.
Selective routing is related to active learning ( [Settles, 2009](https://arxiv.org/html/2609.40103#bib.bib14 "")), particularly
query-by-committee ( [Seung et al., 1992](https://arxiv.org/html/2609.40103#bib.bib16 "")), which uses disagreement among models
to identify uncertain instances.
These approaches frame escalation at the _instance_ level by selecting
which outputs require human attention. JuryFlow operates at the claim level and
does not escalate the judgment to a human. Given an uncertain instance, it
identifies the claim that requires focused re-evaluation and replaces full
response review with targeted computation.
### 2.4. Disagreement and Uncertainty in Multi-Agent Systems
---
Uncertainty-driven escalation routes entire uncertain
_instances_ to
stronger models or human annotators ( [Jung et al., 2025](https://arxiv.org/html/2609.40103#bib.bib21 ""); [Wang et al., 2024](https://arxiv.org/html/2609.40103#bib.bib22 ""); [Kim et al., 2024a](https://arxiv.org/html/2609.40103#bib.bib23 "")). These systems re-evaluate a full response rather than the
contested claim within it. Interactive criteria tools such as EvalGen and
MetricMate instead address the upstream task of specifying what to evaluate
before inspecting a case ( [Shankar et al., 2024](https://arxiv.org/html/2609.40103#bib.bib25 ""); [Gebreegziabher et al., 2025](https://arxiv.org/html/2609.40103#bib.bib34 "")). A complementary mechanism is
needed to locate contested claims automatically, direct additional evaluation
to them, and retain the resulting corrections for subsequent evaluations.
We therefore treat disagreement as an evaluation signal and assign the human
the role of _structural guide_ rather than _labeler_. The human makes
one selection instead of re-evaluating the full response. The system then
performs an evidence-based re-evaluation of the selected claim. A structured
_disagreement graph_ exposes conflicts, and verdict entropy ranks claims
for selection. The human therefore chooses from a small set of claims with high
entropy. The same ranking supports automatic selection when no human is
available, as in our large-scale evaluation.
We implement this approach in JuryFlow, a disagreement-guided,
human-in-the-loop evaluation framework that operates in five stages
(Figure [1](https://arxiv.org/html/2609.40103#acmlabel1 "Figure 1 ‣ JuryFlow: Disagreement-Guided Human-in-the-Loop Multi-Agent Evaluation")).
(1) A panel of heterogeneous judge agents independently decomposes a candidate
response into atomic claims and assigns per-claim verdicts and dimension tags.
(2) The system constructs a disagreement graph whose nodes carry entropy-based
disagreement scores and whose edges encode structural similarity between claims.
(3) A human makes the only structural intervention by selecting the focal claim
to resolve. For automated benchmarking, the system instead selects claims with
the highest entropy using the same ranking.
(4) Each focal selection triggers _propagated re-evaluation_: the focal
claim is re-judged against evidence, and the correction propagates along graph
edges to structurally related claims and, via embedding retrieval, to
historically similar cases.
(5) The correction is abstracted into a reusable rubric entry that all judges
inherit in subsequent evaluations.
Stages 4 and 5 extend each targeted correction to related claims and incorporate
it into subsequent evaluation criteria. JuryFlow can therefore improve across
instances, unlike panels that evaluate each instance independently.
We evaluate JuryFlow on the MT-Bench and LLMBar
benchmarks ( [Zheng et al., 2023](https://arxiv.org/html/2609.40103#bib.bib1 ""); [Zeng et al., 2024](https://arxiv.org/html/2609.40103#bib.bib13 "")) against single-judge and
majority-vote panel baselines. Because human studies are out of scope here, we
use the automatic-selection configuration, which isolates the multi-agent
machinery from human factors.
We therefore use _human-in-the-loop_ throughout to name the interaction
design rather than an empirically validated property of this study. The human’s
only action is to select a claim in the disagreement graph, not to assign a
label or rewrite a verdict. Every reported result uses entropy ranking in place
of that selection. Section [6](https://arxiv.org/html/2609.40103#S6 "6. Discussion ‣ JuryFlow: Disagreement-Guided Human-in-the-Loop Multi-Agent Evaluation") describes the information that
a human could provide beyond this proxy, and
Section [7](https://arxiv.org/html/2609.40103#S7 "7.
---
JuryFlow is complementary to panel evaluation ( [Verga et al., 2024](https://arxiv.org/html/2609.40103#bib.bib8 "")): PoLL
aggregates independent votes, whereas JuryFlow adds disagreement-targeted
re-evaluation and a closed correction loop on the same panel. It also differs
from fixed-rubric evaluation ( [Ye et al., 2023](https://arxiv.org/html/2609.40103#bib.bib10 ""); [Kim et al., 2024b](https://arxiv.org/html/2609.40103#bib.bib24 "")). Rather than
using a static rubric for each dimension, JuryFlow induces entries from its own
corrections and updates them over time.
#### Generality.
The sequence of targeting, propagation, and rubric induction is not specific to
text quality evaluation. It can apply to multi-agent decision pipelines that
expose disagreement, including data labeling, content moderation, and
multi-agent reasoning.
## 7\. Limitations and Future Work

#### The human-guided mode is unvalidated.
Every result here uses automatic focal selection, so we establish the value of
disagreement-targeted re-evaluation but not that of the human selector
motivating the design. The argument in Section [6](https://arxiv.org/html/2609.40103#S6 "6. Discussion ‣ JuryFlow: Disagreement-Guided Human-in-the-Loop Multi-Agent Evaluation") follows from
the construction of the entropy proxy, not from measurement. A user study comparing
human and entropy-based selection in terms of accuracy and effort is therefore
necessary.
#### Correlated judges.
Disagreement is informative only when judges err conditionally independently.
Judges sharing training data or exhibiting self-preference
bias ( [Panickssery et al., 2024](https://arxiv.org/html/2609.40103#bib.bib9 "")) can reach confident but wrong
consensus, which low entropy will not flag; mitigating such blind spots requires
diversity-aware panel construction.
#### Cost and rubric drift.
Cross-instance propagation and a growing rubric raise inference cost and risk
unbounded growth or drift over long runs. Embedding-based deduplication
(Stage 5) mitigates but does not bound these risks. Principled pruning remains
future work.
#### Scope and evidence.
Our protocol covers two English benchmarks; generalization to other languages,
modalities, and long-form responses is untested. The reviewer also re-judges
using only the original context. Retrieving external evidence, as in
SAFE ( [Wei et al., 2024](https://arxiv.org/html/2609.40103#bib.bib12 "")), is a natural extension.
## 8\. Conclusion

JuryFlow treats inter-judge disagreement as a claim-level signal for allocating
additional evaluation. It scores claims by verdict entropy, re-evaluates the
most contested claims, propagates each correction through a structural graph,
and incorporates the correction into a shared rubric. This process converts a
judge panel into an evaluator that can improve from a single selection. On
MT-Bench and LLMBar, JuryFlow agrees with gold labels more often than
single-judge and majority-vote baselines. Our ablations identify the
contributions of focal re-evaluation, propagation, and rubric induction. Because
entropy ranking replaces human selection in all experiments, future work must
establish what a person contributes beyond this proxy, particularly when the
panel reaches an incorrect consensus.
###### Acknowledgements.
This research was supported by JSPS KAKENHI Grant Number 25K21201.
## Appendix A System Prompt Templates

Templates used by each agent; {curly} fields are instantiated per
instance.
#### Judge agent (Stage 1).
You are an impartial judge. Decompose the response into atomic, independently
verifiable claims. For each claim, output a verdict (accept / reject /
uncertain), a one-sentence rationale, and the relevant evaluation dimensions
from the fixed tag set {T}. Consider the current rubric: {rubric}.
Question: {Q}. Response: {A}. Return JSON matching the schema.
Reviewer agent (Stage 4).Re-evaluate the focal claim {c\*} using only evidence in the question and
response.
=== PAPER 4: arxiv:2608.06701 (LivePlan) ===
# Online Monitoring and Corrective Steering of Programming Agents

Paper ID: 5033872249947771187
IDs: arxiv:2608.06701
Authors: Shuyang Liu; Saman Dehghan; Ji Young Kim; Jatin Ganhotra; Martin Hirzel; Reyhaneh Jabbarvand
Categories: cs.SE, cs.AI, cs.CL, cs.LG
Dates: created 2026-08-07; updated 2026-08-10

## Abstract
Fixing GitHub issues in large-scale projects is a long-horizon task, especially when a fix requires changes across multiple locations or the issue description lacks the information needed to localize and repair it. As a result, agents traverse long trajectories that are prone to inefficiency and error: they drift away from their intended plan, repeat failed actions, or terminate without a working patch. This paper proposes LivePlan to monitor, detect, and correct such behavioral inefficiencies and drifts in real time. LivePlan decouples judging from advising: a deterministic, rule-based monitor examines general signals over the trajectory to detect issues without invoking an LLM, and only when an issue is detected does it consult an advisor LLM for a high-level, next-step correction. This design avoids the misleading re-planning and costly interventions of prior approaches. We implement LivePlan on top of SWE-agent and evaluate it using five LLMs (three as executor agents and two as advisors) across SWE-bench Verified and SWE-bench Pro. Compared to vanilla SWE-agent, LivePlan notably improves issue resolution rates, achieving consistent gains of up to 15.2% (average: 9.9%), while incurring only an additional cost of 0.08 per instance. The additional solutions concentrate on medium and hard instances. LivePlan consistently outperforms alternative approaches in resolution rate, with minimal regression on already successful runs and new successes on problems that no baseline solves.
28:(T,H)←ExecuteAndRecord​(s​t​e​p,T,H)(T,H)\\leftarrow\\textsc{ExecuteAndRecord}(step,T,H)

29:(G,L)←(G′,L′)(G,L)\\leftarrow(G^{\\prime},L^{\\prime})

30:H←AppendAdvice​(H,a​d​v​i​c​e)H\\leftarrow\\textsc{AppendAdvice}(H,advice)

31:b​l​o​c​k​C​o​u​n​t←0blockCount\\leftarrow 0

32:endif

33:l​a​t​e​s​t​A​d​v​i​c​e←a​d​v​i​c​elatestAdvice\\leftarrow advice

34:l​a​s​t​T​r​i​g​g​e​r←\|T\|lastTrigger\\leftarrow\|T\|

35:endif

36:endwhile

37:functionCallAdvisor

38:Input:II, r​e​c​e​n​t​S​t​e​p​srecentSteps, l​a​t​e​s​t​A​d​v​i​c​elatestAdvice, p​r​e​D​e​f​i​n​e​d​A​d​v​i​c​epreDefinedAdvice

39:Return: one LLM-generated next-step advice

40:endfunction

Fig. 4: Examples of behavioral drifts captured by Graphectory and Langutory.
_Monitor_ uses two process-centric trajectory representations, Graphectory and Langutory\[ [17](https://arxiv.org/html/2608.06701#bib.bib17 "")\], to generically encode behavioral drifts and detect them via deterministic algorithms. Graphectory converts the trajectory into an enriched graph, with nodes as distinct agent actions and edges as chronological execution order; Langutory abstracts low-level actions into a sequence of problem-solving phases. The original Graphectory treats only actions as nodes, with thought included as a node property. LivePlan augments Graphectory with thought nodes and edges to also monitor ineffective thinking that manifests as behavioral drift. It also splits the Graphectory’s _localization_ phase into _navigation_ (locating the potential bug) and _reproduction_ (confirming it), extending both Graphectory nodes and Langutory alphabets with these new phases. This lets _Monitor_ and _Advisor_ detect behavioral drifts and issue corrective steering more specifically.
We define behavioral drift as a condition in a trajectory that deviates from common expectations. Under this definition, deviation from the specified plan, repetitive thoughts or actions that fail to advance the agent, and stagnation in any problem-solving phase are behavioral drifts. While signals defined this way are general, they may be incomplete. To account for that, LivePlan maintains a configurable signal database that users can augment. Furthermore, as we discuss in § [II-B](https://arxiv.org/html/2608.06701#S2.SS2 "II-B Advisor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents"), the LLM _Advisor_ can still use its general knowledge to guide corrective steering.
Some behavioral drifts are alarming, e.g., skipping critical problem-solving phases, such as patch validation before submission, which may result in an incorrect patch. Therefore, _the execution of actions that manifest such drifts should be blocked_. Others represent inefficiencies that can be improved but are not necessarily harmful. For example, prolonged navigation through the repository to localize a bug could be due to ineffective reasoning/tooling, or a legitimate need to gather sufficient context to repair a multi-hunk bug. Therefore, execution of the corresponding actions can be allowed, accompanied by corrective steering advice.
Table [I](https://arxiv.org/html/2608.06701#S2.T1 "TABLE I ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents") lists _ten_ blocking and non-blocking behavioral drifts that _Monitor_ can detect. They can be detected in Graphectory and Langutory through generic signals:
a back-edge in Graphectory, regardless of the nature of the action, indicates _Repeated Action_ (Figure [4](https://arxiv.org/html/2608.06701#S2.F4 "Fig.
---
We conducted a manual analysis of successful and unsuccessful interventions by LivePlan and other baselines, discussing major root causes for intervention failures and guidelines for future research.
## II LivePlan Approach

![Refer to caption](https://arxiv.org/html/2608.06701v1/overview.png)Fig. 3: Overview of LivePlan workflow.TABLE I: Blocking and non-blocking behavioral drifts detected by LivePlan.
|     |     |     |     |     |
| --- | --- | --- | --- | --- |
| Type | Category | Signal | Behavioral Drift | Description |
| Blocking | Plan Violation | Skipping phase(s) in Langutory. | Premature Patching | Patch before Localization. |
| Skip Patching | Finalize without producing a patch. |
| Skip Validation | Submit before validating the patch. |
| Oscillation | Repeated back-edges in Graphectory | Thought Oscillation | Repeated reasoning pattern without meaningful progress. |
| Action Oscillation | Repeated execution loops, such as self-loops or cyclic action sequences. |
| Non-blocking | Long Stagnation | Long same-phase sequence in Langutory | Prolonged Navigation | Spends many steps in navigation. |
| Prolonged Reproduction | Prolonged bug reproduction. |
| Prolonged Patching | Performs many consecutive edits. |
| Prolonged Validation | Spends excessive effort validating. |
| Repeated Action | A back edge in Graphectory | Action Revisit | Repeatedly performs the same action, such as revisiting previously viewed locations. |

LivePlan consists of _three_ components (Figure [3](https://arxiv.org/html/2608.06701#S2.F3 "Fig. 3 ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")): (1) _Monitor_ incrementally constructs process-centric representations of the trajectory, evaluates them against a configurable set of general signals to determine behavioral drifts, and invokes the _Advisor_ upon drift detection (§ [II-A](https://arxiv.org/html/2608.06701#S2.SS1 "II-A Monitor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")); (2) _Advisor_ returns a predefined advice corresponding to the drift, or prompts an LLM to generate a custom advice based on issue description, trajectory context, _Monitor_ status, and latest advice, if available (§ [II-B](https://arxiv.org/html/2608.06701#S2.SS2 "II-B Advisor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")); depending on the latest action and _Monitor_ observation, (3) _Intervention Processor_ interacts with the executor agent for corrective steering (§ [II-C](https://arxiv.org/html/2608.06701#S2.SS3 "II-C Intervention Processor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")).
### II-A_Monitor_

Algorithm [1](https://arxiv.org/html/2608.06701#alg1 "Algorithm 1 ‣ II-A Monitor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents") shows the workflow of _Monitor_ along with other components. At each step, after the executor reasons about the next action but before executing it (Line 7), _Monitor_ tentatively updates the trajectory representations and checks them for behavioral drift (Lines 8–9). If none is observed, execution proceeds (Lines 10–13). Otherwise, _Monitor_ consults the _Advisor_ for corrective steering advice (Lines 14–22).
A common strategy is to feed an LLM the entire trajectory, or a slice of it, to review and surface issues. Using an LLM as a judge is prone to hallucination and error \[ [8](https://arxiv.org/html/2608.06701#bib.bib8 ""), [30](https://arxiv.org/html/2608.06701#bib.bib30 "")\].
---
Table [V](https://arxiv.org/html/2608.06701#S3.T5 "TABLE V ‣ III-B RQ2: Detailed Cost Analysis of LivePlan ‣ III Experimental Evaluation ‣ Online Monitoring and Corrective Steering of Programming Agents") reports that across all settings, the advisor costs only $0.01–$0.06 per instance on average. Rule-based monitoring incurs nearly zero runtime overhead, i.e., a few milliseconds. The _Advisor_ latency is modest relative to the runtime of long-horizon repository-level repair tasks. Beyond cost, LivePlan often reduces execution effort by decreasing inefficient exploration. For Gemini-2.5-Flash and MiniMax-M2.5, interventions generally shorten trajectories and, in some cases, even reduce the overall cost. In contrast, trajectories become longer for DeepSeek-V3 because LivePlan discourages common shortcuts such as skipping validation \[ [18](https://arxiv.org/html/2608.06701#bib.bib18 "")\], encouraging a more complete and reliable repair process. Regardless, the resulting cost overhead remains small.
### III-CRQ3: Process-Centric Analysis of Trajectories

TABLE VI: Observed behavioral drifts by LivePlan.
| Setting | PlanViolation | Long Stagnation | Oscillation | RepeatedAction |
| --- | --- | --- | --- | --- |
| Dataset | Advisor | Executor | Navigation | Reproduction | Patching | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| SWE-benchPro | GPT-5.2 | DeepSeek-V3 | 80.7 | 26.1 | 1.5 | 11.4 | 11.0 | 95.5 | 28.8 |
| Gemini-2.5-Flash | 43.9 | 31.8 | 5.3 | 20.5 | 20.8 | 73.5 | 59.5 |
| MiniMax-M3 | MiniMax-M2.5 | 1.9 | 48.7 | 5.3 | 1.1 | 21.3 | 10.3 | 44.1 |
| SWE-benchVerified | GPT-5.2 | DeepSeek-V3 | 28.2 | 22.8 | 7.4 | 0.6 | 14.6 | 37.0 | 12.8 |
| Gemini-2.5-Flash | 7.7 | 34.9 | 13.8 | 8.4 | 15.7 | 78.3 | 37.8 |
| MiniMax-M3 | MiniMax-M2.5 | 6.2 | 42.4 | 21.2 | 0.6 | 47.8 | 6.8 | 47.0 |

In addition to outcome-centric analysis, we conduct three types of automated process-centric analyses to better understand the notable improvement of LivePlan over Vanilla.
#### III-C1 Prevalence of Triggering Signals

![Refer to caption](https://arxiv.org/html/2608.06701v1/inefficiency_patterns_heatmap.png)Fig. 8: Behavioral drifts in final trajectories.
We measure the prevalence of behavioral drifts in _completed_ trajectories of Vanilla and LivePlan (Figure [8](https://arxiv.org/html/2608.06701#S3.F8 "Fig. 8 ‣ III-C1 Prevalence of Triggering Signals ‣ III-C RQ3: Process-Centric Analysis of Trajectories ‣ III Experimental Evaluation ‣ Online Monitoring and Corrective Steering of Programming Agents")), and the percentage of instances in which LivePlan observes each drift during execution (Table [VI](https://arxiv.org/html/2608.06701#S3.T6 "TABLE VI ‣ III-C RQ3: Process-Centric Analysis of Trajectories ‣ III Experimental Evaluation ‣ Online Monitoring and Corrective Steering of Programming Agents")). Drifts observed by LivePlan may not remain in the final trajectory, since LivePlan steers the agent away from them. On average, 86.16% and 78.33% of Vanilla trajectories in SWE-bench Pro and SWE-bench Verified show behavioral drifts. They are more prevalent in SWE-bench Pro, whose more complex problems require longer, drift-prone trajectories.
The exact behavioral drifts in Vanilla runs may not be observed in LivePlan. However, Table [VI](https://arxiv.org/html/2608.06701#S3.T6 "TABLE VI ‣ III-C RQ3: Process-Centric Analysis of Trajectories ‣ III Experimental Evaluation ‣ Online Monitoring and Corrective Steering of Programming Agents") shows that LivePlan observes many similar behavioral drifts during execution and attempts to steer the agent away. Specifically, LivePlan significantly reduces blocking signals. Many of the high-risk behavioral drifts, namely Plan Violation and Action/Thought Oscillation, that are prevalent in the final Vanilla trajectories and are notably observed during LivePlan runs do not appear in final LivePlan trajectories.
---
(3) While LLM-as-a-judge offers generalizability, i.e., the LLM draws on its internal knowledge to flag problems that are not necessarily encoded, it comes at the cost of reliability: LLMs are known to be unreliable evaluators that both miss real problems and flag spurious ones \[ [8](https://arxiv.org/html/2608.06701#bib.bib8 "")\]. _Overcoming this limitation entails a deterministic judge whose approach can flag a broad class of behavioral drifts._

Fig. 2: An advisor periodically checking the trajectory fails to resolve an issue due to late feedback.
We propose LivePlan for online monitoring of agent trajectories to detect behavioral drifts and intervene with corrective steering. LivePlan separates _judgment_ from _advising_: it relies on a deterministic, rule-based monitor that examines a set of _general signals_ over the trajectory to determine behavioral drifts (§ [II-A](https://arxiv.org/html/2608.06701#S2.SS1 "II-A Monitor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")). These signals are general rather than tied to a specific benchmark or repository, so they flag a broad class of behavioral drift. Upon detection of a behavioral drift, LivePlan generates predefined or custom
high-level, corrective, next-step advice to steer the trajectory (§ [II-B](https://arxiv.org/html/2608.06701#S2.SS2 "II-B Advisor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")). By separating judgment from advising and planning, judging with a deterministic monitor that does not hallucinate a non-existent problem, and advising only when that monitor fires, LivePlan addresses the limitations of prior work.
We implement LivePlan on top of SWE-agent \[ [37](https://arxiv.org/html/2608.06701#bib.bib37 "")\] and compare its performance against four baselines and ablated versions on the SWE-bench Verified \[ [12](https://arxiv.org/html/2608.06701#bib.bib12 "")\] and SWE-bench Pro \[ [7](https://arxiv.org/html/2608.06701#bib.bib7 "")\] datasets, using five diverse general and reasoning LLMs (three as executors and two as advisors). The comprehensive evaluation confirms the effectiveness of LivePlan in consistently improving the resolution rate of SWE-agent across all models and benchmarks, with consistent gains of up to 15.2% (average: 9.9%). LivePlan not only consistently resolves more GitHub issues than the baselines but also guides the agent more effectively toward solving _medium_ and _hard_ issues. Besides improving the overall resolution rate, LivePlan yields trajectories that are more compliant with the predefined instruction plan in SWE-agent \[ [18](https://arxiv.org/html/2608.06701#bib.bib18 "")\], i.e., explore, localize, repair, and validate \[ [33](https://arxiv.org/html/2608.06701#bib.bib33 "")\].
Our contributions are:

- •

Technique. We propose LivePlan, an online monitoring and intervention technique that _decouples_ judging from advising for agent trajectory steering. LivePlan pairs a deterministic, rule-based monitor to detect _whether and where_ a trajectory is in trouble without invoking an LLM, and thus without the risk of hallucinating a non-existent problem (§ [II-A](https://arxiv.org/html/2608.06701#S2.SS1 "II-A Monitor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")). The LLM advisor is consulted only when the monitor fires and only for a high-level, next-step correction (§ [II-B](https://arxiv.org/html/2608.06701#S2.SS2 "II-B Advisor ‣ II LivePlan Approach ‣ Online Monitoring and Corrective Steering of Programming Agents")).
- •

Empirical Evaluation. We perform a large-scale evaluation to assess the effectiveness of LivePlan and other techniques on two widely used GitHub issue datasets. The study results in 77527752 trajectories, 46684668 of which were generated by intervention approaches, providing a valuable dataset for future research.
=== PAPER 5: arxiv:2608.02464 (Real-Time Detection ESN + CUSUM) ===
# Real-Time Detection and Repair of LLM Agent Failures

Paper ID: 4268277765807657423
IDs: arxiv:2608.02464
Authors: Sunny Dubey
Categories: cs.AI, cs.LG, cs.SE
Dates: created 2026-08-03; updated 2026-08-04

## Abstract
LLM agents fail mid-episode -- they loop, cascade tool errors, drift off goal, fabricate results, or silently absorb corrupted content -- and the standard remedy, judging every step with a second LLM, costs more than the agent itself. We ask how much detection is achievable from observable step telemetry alone, using monitors costing microseconds per step and trained only on healthy runs. On 2,823 committed agent episodes across three frameworks, three local models (qwen2.5 7b/3b, llama3.1 8b) and a commercial API (gemini-2.5-flash), a one-class echo-state-network ensemble with CUSUM alarms detects 0.71 of failures at a 5% false-alarm budget (AUROC 0.872). Its advantage over a memoryless baseline is a monotone function of post-onset horizon (+0.09 at <=3 steps, +0.40 at >=9), predicting its own failure region out of sample on AFTraj-2K. Ranking transfers with no retraining to two corpora from other groups (AFTraj-2K 0.745, ATBench 0.779). Monitors carry two burdens: a per-deployment healthy null (they do not transfer -- AUROC 0.527 cold against 0.885 recalibrated) and a residual false-alarm rate. We add a layer carrying neither: deterministic verification, which recomputes a run's stated total from the tool results it actually received and confirms every required call was made. Head-to-head it catches 60% of failures (96% with the coverage check) at 0 of 63 false positives against the monitor's 54% at 17%, transfers unchanged to llama3.1:8b (110 of 110 at 0 of 10), and trips on 0 of 1825 healthy episodes. Detection is then closed into repair: each flagged run is rolled back and re-run live, recovering 45% of failures against a 16% resampling control (p=0.0005) and lifting task success from 52% to 73% for about one extra model call per run. The system runs at 200 microseconds per step, three orders of magnitude below a judge call. Code, traces and results are released.
$$
674\,\mu\mathrm{s},
$$

## 1 Introduction

An agent episode is a sequence of steps; each step emits observable telemetry: what the agent said,
how confident its tokens were, what tools it called, what they returned, how long everything took.
---

The monitoring question is whether a lightweight, always-on watchdog over this stream can raise a
calibrated alarm at derailment onset—steps before the task fails or the budget burns—without model
internals, without labels, and without a second LLM in the loop [1].
This work answers that question constructively, and documents with equal care what such a
watchdog cannot do. Contributions:

1. **Real-ecosystem validation at scale, and it is the paper’s spine**: 2,823 episodes over 25
datasets, of which 770 use real tools with live agents across bespoke, LangGraph and AutoGen
loops, spanning three local agent models in two families and the gemini-2.5-flash API. Per-class
coverage across nine real corpora is reported in full, including where it is poor.
2. **A controlled testbed with ground-truth onsets**(failure injector, 43-dim telemetry) and an
11-monitor comparison under matched false-alarm budgets, used to expose detector*mechanics*
— ground-truth onsets at arbitrary horizons, and classes the real corpora do not contain. Its
telemetry is constructed, so no deployment claim rests on it.
3. **A diagnosis of when temporal monitoring pays**: the ESN’s detection advantage over a
50*×*-cheaper Mahalanobis baseline is a monotone function of post-onset horizon.
4. **A calibrated hybrid**whose supervised fusion weights learn which regime a deployment is in.
5. **A content-grounding telemetry channel**that closes the content blind spot, with behavioral
detection improved rather than traded: pooled over the 58 malformed_json episodes in
grounding_diagnosis.csv, detection rises from 0.07 for the memoryless parent (0.14
for the ESN) to 0.90 for the content gate.
6. **Fusion lessons**: per-stream “dual-budget” thresholds with a train-max trip restore detections
destroyed by shared thresholds.
7. **Organic-failure validation with a pre-registered replication**: monitors calibrated on healthy
runs and then applied unchanged catch only**1 of 3**organic fabrications and rank the organic
failure set at/below chance (within-organic AUROC 0.31–0.42), while a temperature-matched
null still false-alarms on 36% of healthy episodes — so a dedicated pre-registered fabrication
study is explicitly**underpowered**(2 genuine hallucinations in 55 episodes vs a pre-registered
minimum of 10) and makes no detection claim, and the fabrication class is instead delivered
by a deterministic numeric-grounding verifier. Monitors are blind to silent aborts (a trivial
completion check catches 7/7), and the healthy null is highly specific to the deployment
configuration.
## 2 Related Work

**Foundations.**Our alarms are classical sequential change detection: CUSUM [2] over per-channel
surprise, in the framework of abrupt-change detection [3]. The monitors are one-class [4] — fit
on healthy episodes only, no failure labels — and the baselines follow that tradition: Mahalanobis
detectors from out-of-distribution detection [5, 6] and isolation forests [7]. The temporal backbone is
an echo-state network [8]; reservoir computing [9] gives an untrained recurrent feature map whose
readout fits in closed form, which is what makes the per-deployment recalibration that §5 shows to be
mandatory affordable at all. Calibration is evaluated with expected calibration error [10].
**Agent failure, and detecting it online.**Agent loops interleave reasoning and tool calls [11] and
ship through frameworks such as AutoGen [12]; failure is common and heterogeneous [13], and
MAST makes that concrete with 14 empirical failure modes over 1600+ annotated traces [14] — our
four injected classes are a deliberately narrow, mechanically-verifiable slice of it.
---
# Real-Time Detection and Repair of LLM Agent Failures

Sunny Dubey
ORCID:0009-0002-8296-8631

## Abstract

## https://arxiv.org/abs/2608.02464v1

LLM agents fail mid-episode—they loop, cascade tool errors, drift off their goal, fabricate
results, or silently absorb corrupted content—and the standard remedy, judging every step with a
second LLM, costs more than the agent itself. We ask how much failure detection is achievable
from*observable step telemetry alone*(semantic embeddings of step output, token-level uncertainty,
action metadata), using monitors that cost microseconds per step and train only on healthy runs.
Starting from a one-class echo-state-network (ESN) ensemble with CUSUM alarms, we build and
validate, on 2,823 committed agent episodes across three frameworks, three local agent models
spanning two families (qwen2.5 7b/3b, llama3.1 8b), and a commercial API (gemini-2.5-flash), a
sequence of increasingly capable monitors: (1) the ESN, which wins decisively when failures have
temporal room to develop; (2) a calibrated ESN+Mahalanobis hybrid whose learned fusion weights
track the deployment regime; and (3) a content-grounding telemetry channel that lifts the monitors’
shared blind spot (content corruption) from 0.28 to 0.59 pooled content detection (reaching 1.00
on the research collectors where the corruption is content-visible; honestly inert on frameworks
whose corruption leaves result text unchanged), a +0*.*31 gain that holds at every seed, while
behavioral detection improves rather than degrades (+0*.*045). Validation on organic (non-injected)
failures reveals a taxonomy with an honest boundary: a completion check catches failures of
omission (7/7 silent aborts), the monitors transfer only*weakly*to organic commission (1 of 3
fabrications) and rank the organic set at/below chance without recalibration, and plausible-value
corruption requires external reference (the escalation layer’s job). A pre-registered fabrication
study is explicitly underpowered (2 hallucinations in the pre-registered 55 episodes, 9 across all
175 organic episodes and only 2 of those fabricated*inputs*, against a pre-registered minimum of
10) and makes no detection claim — the models rarely invent — so the fabrication class is covered
by a deterministic numeric-grounding verifier rather than a statistical monitor. Both burdens —
the per-deployment null and the residual false-alarm rate — motivate a complementary layer that
carries neither: **deterministic verification**, which recomputes a run’s stated total from the tool
results that run actually received and confirms every required call was made, needing no null, no
threshold and no calibration. Head-to-head on the same episodes and labels it catches 60% of
failures (96% with the coverage check) at**0 of 63 false positives**against the monitor’s 54% at 17%;
it replicates on 120 later episodes at disjoint seeds scored frozen (54%, 93% with coverage, 0 of
64), transfers unchanged across model families to llama3.1:8b (**110 of 110 at 0 of 10**), and catches
**26 of 26**provoked fabrications — the class on which a one-class monitor structurally cannot be
scored. A third check validates tool results against the shapes their tool can return, flagging**0**
**of 1825**healthy episodes while catching 46% of injected context corruption, 215 of 218 within
one step of onset. Detection is then closed into**repair**: each flagged run is rolled back to its last
fact-gathering step and re-run live, recovering**45%**of failures against a 16% resampling control
(*p*= 0*.*0005) and lifting net task success from**52% to 73%**for about one extra model call per
run. The monitor scores a step in *∼*200 *µ*s and the telemetry adapter that feeds it adds a median
arXiv:2608.02464v1  [cs.AI]  3 Aug 2026674 *µ*s, so the whole path stays under a millisecond per step — against one 7B forward pass for
an auditor that judges every step.
$$
\sim200\,\mu\mathrm{s}
$$
---
Each step emits an observable vector built from three
causal channels — a semantic embedding of the step’s output, token-uncertainty aggregates, and
action metadata:
d
*x* = *e*;*u*;*m ∈*R*, d∈{*43*,*51*,*60*}.*(1)

$$
t=1,\ldots,T
$$

$$
x_{t}\ =\ \left[\:e_{t}\:;\:u_{t}\:;\:m_{t}\:\right]\:\in\mathbb{R}^{d},\:\:\:\:\:\:\:\:\:\:d\in\{43,51,60\}.
$$

An episode is healthy, or contains an onset at unknown step *τ* after which the trajectory distribution shifts and the run ends in failure. From*healthy episodes only*we want a causal score
*s*<sub>t</sub>=*f*(*x₁,...,x*<sub>t</sub>) and an alarm time ˆ= *τ* min*{t*: *s*<sub>t</sub>*> θ}* maximising detection at a fixed
false-alarm budget, with per-step compute far below one model call.
$$
s_{t}\,=\,f(x_{1},\ldots,x_{t})
$$

$$
{\hat{\tau}}\,=\,\operatorname*{m i n}\{t\,:\,s_{t}\,>\,\theta\}
$$

**Reservoir.**Per channel *c*, a sparse random recurrent map is fixed at initialisation and never
(c)
trained; only a ridge readout*A* is fitted, on healthy runs, to predict the next step:

$$
A^{(c)}
$$

$$
h_{t}^{(c)}=\left(1-\alpha\right)h_{t-1}^{(c)}+\alpha\operatorname{t a n h}\bigl(W^{(c)}h_{t-1}^{(c)}+W_{\operatorname{i n}}^{(c)}x_{t}^{(c)}\bigr),
$$

(2)

$$
\hat{x}_{t+1}^{(c)}=A^{(c)}\big[\,h_{t}^{(c)}\,;\,x_{t}^{(c)}\,;\ 1\big].
$$

(3)

(c)
Be<sup>c</sup>ause *W* is frozen, (3) is a closed-form least-squares solve — the reason a fit costs 1.7 s where
a GRU costs 68 s.
$$
W^{(c)}
$$

3

---

**Surprise and accumulation.**The per-step surprise is the normalised one-step prediction error,
averaged over an ensemble of *K* reservoirs, with *σ*<sub>err</sub>the per-dimension residual scale measured on
held-out healthy runs. Slow drift keeps each step locally predictable, so a short-memory statistic
never crosses threshold; a one-sided CUSUM [2] integrates small persistent shifts instead:
 

$$
\sigma_{\mathrm{e r l}}
$$

$$
\boldsymbol{q}_{t}^{(c)}=\frac{1}{K}\sum_{k=1}^{K}\,\mathrm{m e a n}_{d}\left(\frac{\hat{x}_{t\,|\,k}^{(c)}-\boldsymbol{x}_{t}^{(c)}}{\sigma_{\mathrm{e r r}}^{(c)}}\right)^{2},
$$

(4)

$$
S_{t}^{(c)}=\operatorname*{m a x}\bigl(0,\;S_{t-1}^{(c)}+z\bigl(q_{t}^{(c)}\bigr)-\kappa\bigr),\qquad S_{0}^{(c)}=0.
$$

(5)

**Fusion and threshold.**A shift confined to the 4-dimensional uncertainty channel is diluted if it
is averaged across all *d* dimensions, so each channel is accumulated separately and the alarm reads
the loudest:

$$
s _ {t} = \max _ {c \in \{e, u, m \}} S _ {t} ^ {(c)}, \quad \theta = Q _ {1 - \beta} \left(\left\{\max_ {t} s _ {t}: \text {h e a l t h y v a l e p i s o d e s} \right\}\right),
$$

(6)

with *β* the false-alarm budget. Every quantity in (1)–(6) at step *t* depends on *x₁,...,x*<sub>t</sub>and fit-time
constants only, so the monitor is causal by construction; *θ* is read from healthy validation episodes
and never from test data. §6 shows the per-channel max in (6), not the reservoir, carries most of the
margin — giving a GRU the same wrapper lifts it past our ESN — which makes the wrapper the
transferable contribution and the reservoir the cheap way to pay for it.
$$
\beta
$$

$$
x_{1},\ldots,x_{t}
$$

$$
\theta
$$

**Baselines and variants**, all fitted and scored under this same one-class causal protocol: memoryless Mahalanobis and ∆-Mahalanobis [5], cosine and self-drift, rolling entropy, linear AR, and
trained GRU/LSTM/TCN sequence models; hybrids that robust-*z* calibrate the ESN and Mahalanobis
streams and fuse them by weight, max or logistic regression; a grounded stream that joins (6) as a
memoryless robust-*z* max over the content channel *g* (§8); and a five-line completion check that asks
only whether the final step is empty or a bare tool call.
## 4 Telemetry

Each step*t*emits*x*<sub>t</sub>, built in four causal generations:

$$
x_{t}
$$

Table 1: Telemetry vector evolution across versions.
---
Its lower detection at a matched false-alarm budget (0.38 against 0.57)
is a*horizon*effect, not a telemetry one — its positives are far shorter after onset (median 4 steps
against 8), and at matched horizon the two agree (0.53 against 0.56). Ablating the token-surprisal
channel inside four corpora that carry it moves the ESN by AUROC +0*.*000, so the deployment
requirement is structured tool results, not logprob access. Figure 4 compares all monitors across these
real deployments and is deliberately unflattering: the per-dataset spread is wide enough that several
orderings which look decisive are ties once power is accounted for, so only the pooled comparison is
defensible.
**The judge is measured, not assumed.**A real gemini-2.5-flash judge on a labelled subset of 161
distinct prompts scores p_detect**0.548**(95% CI 0.44–0.65) and p_false**0.052**, against the 0.90/0.02
the escalation analysis assumes. Substituting the measured rates across all five master seeds leaves
the call saving intact but drops detection recovery from 82% to**43%**, supported at zero of five seeds.
Figure 3 shows why the layer is still worth having: judge and monitor fail on*different*classes — the
judge is perfect on goal drift and nearly blind on context corruption (0.18), where the monitor is the
reverse (1.00).
## 5.1 External corpora: two benchmarks we did not build

On**AFTraj-2K**[16] — 1,882 trajectories after the same *T≥*4 filter, 1,111 healthy and 771 failed,
imported with no change to the monitors — the channel-max ESN reaches episode AUROC**0.745**
(best hybrid 0.760) but detects only**0.048**at the 5% budget. Ranking transfers to another project’s
agents and frameworks; the operating point does not. The horizon diagnosis predicts exactly that: at
post-onset horizon *≥*9 the ESN detects**0.509**against Mahalanobis’ 0.170, and at *≤*3 neither detects
anything — but only 53 of 771 failures (6.9%) have that much room and 61% end within three steps
of onset. AgentForesight-7B reports 66.44 Exact-F1 here using an LLM auditor at every step; we do
not match it and do not claim to. What this supports is that ranking transfers zero-shot at 163*µ*s per

5

---

[Image: Im1]

Figure 1: **Real agent traces**(ollama7b: qwen2.5:7b against real tools). One-class CUSUM score
streams per failure class; dashed = threshold at the 5% validation FA budget, dotted = verified
injection onset. The healthy run stays two orders of magnitude below the line, and every injected
class — context corruption,*goal drift*, looping and tool cascade — alarms one step after onset. The
sixth panel is*grounding loss*, and it is different in kind: fabrication cannot be injected into a live run,
so this episode is a genuine one from the organic (non-injected) corpus, scored against that corpus’s
own healthy null. The CUSUM stays flat – a fabricated figure perturbs no behavioural channel – and
the class is caught instead by the deterministic grounding verifier. That is the blind spot the verifier
exists to cover, shown rather than asserted. Note the *y* axis is symlog: real streams span twelve orders
of magnitude, because the CUSUM accumulates multiplicatively once a failure takes hold.
step and no model call.
**ATBench**[32] (604 of 1,000 trajectories after the same filter; trajectory-level safe/unsafe labels
only, so no *τ* and no earliness metric) separates the two findings: the ESN reaches AUROC**0.779**and
detects**0.311**of unsafe runs — it alarms here, where on AFTraj it could not — while ∆-Mahalanobis
sits at chance (0.457) and drags every 50/50 fusion down with it (0.438–0.463). Per failure mode
the split is sharp: over-privileged actions 0.508 and unvalidated tool outputs 0.473, against 0.038 for
inaccurate information. What the agent*does*is caught; what it*says*is not — the content blind spot
§8 addresses, on labels we did not write.
6

---

[Image: Im2]
=== PAPER 6: arxiv:2601.05111 (Agent-as-a-Judge) ===
# Agent-as-a-Judge

Paper ID: 1035102137136367812
IDs: arxiv:2601.05111
Authors: Runyang You; Hongru Cai; Caiqi Zhang; Qiancheng Xu; Meng Liu; Tiezheng Yu; Yongqi Li; Wenjie Li
Categories: cs.CL, cs.AI
Dates: created Thu, 08 Jan 2026 16:58:10 GMT; updated 2026-01-09

## Abstract
LLM-as-a-Judge has revolutionized AI evaluation by leveraging large language models for scalable assessments. However, as evaluands become increasingly complex, specialized, and multi-step, the reliability of LLM-as-a-Judge has become constrained by inherent biases, shallow single-pass reasoning, and the inability to verify assessments against real-world observations. This has catalyzed the transition to Agent-as-a-Judge, where agentic judges employ planning, tool-augmented verification, multi-agent collaboration, and persistent memory to enable more robust, verifiable, and nuanced evaluations. Despite the rapid proliferation of agentic evaluation systems, the field lacks a unified framework to navigate this shifting landscape. To bridge this gap, we present the first comprehensive survey tracing this evolution. Specifically, we identify key dimensions that characterize this paradigm shift and establish a developmental taxonomy. We organize core methodologies and survey applications across general and professional domains. Furthermore, we analyze frontier challenges and identify promising research directions, ultimately providing a clear roadmap for the next generation of agentic evaluation.
Planning serves as a core capability in the Agent-as-a-Judge paradigm, enabling the decomposition of high-level evaluation objectives into executable sub-tasks and the dynamic adaptation of assessment trajectories based on intermediate analysis.
This section examines planning capabilities from two perspectives:

#### Workflow Orchestration.
Workflow orchestration in Agent-as-a-Judge systems spans from static frameworks to dynamic agency, primarily characterizing Procedural and Reactive stages of agentic evaluation.
Approaches like MATEval \[ [33](https://arxiv.org/html/2601.05111#bib.bib22 "")\] rely on static decomposition, breaking tasks into fixed sequences of sub-dimensions. While this ensures systematic assessment through predefined control flows, it limits adaptability in complex scenarios.
Conversely, Evaluation Agent \[ [28](https://arxiv.org/html/2601.05111#bib.bib27 "")\] introduces dynamic multi-round planning, where agents adjust strategies based on intermediate feedback. This system further optimizes efficiency through autonomous termination, allowing the agent to self-monitor information gain and proactively halt execution once sufficient evidence is gathered.
#### Rubric Discovery.
Unlike general agents focused on task completion, Judge Agents have the distinct capability to autonomously formulate and refine rubrics, representing a hallmark of the Self-Evolving stage, where agents can refine their internal evaluation components.
EvalAgents \[ [29](https://arxiv.org/html/2601.05111#bib.bib26 "")\] exemplifies this by employing a Query Generator that plans web searches to discover implicit rubrics, while AGENT-X \[ [25](https://arxiv.org/html/2601.05111#bib.bib25 "")\] uses an Adaptive Router to infer domain context and plan bespoke detection guidelines.
ARJudge \[ [34](https://arxiv.org/html/2601.05111#bib.bib66 "")\] adaptively formulates rubrics by iteratively generating context-sensitive questions, and OnlineRubrics \[ [35](https://arxiv.org/html/2601.05111#bib.bib28 "")\] integrates planning into reinforcement learning, evolving rubrics alongside policy optimization to detect reward hacking.
Takeaway Serving as the strategic engine, planning shifts evaluation from rigid flows to adaptive exploration, enabling agents to optimize how they evaluate (workflow orchestration) and what they evaluate (rubric discovery).
### 3.3 Tool Integration

|     |     |     |     |
| --- | --- | --- | --- |
| Tool Purpose | Method | Evaluation Task | Tool Type |
| Evidence collection | Agent-as-a-Judge \[ [20](https://arxiv.org/html/2601.05111#bib.bib30 "")\] | Code generation | Graph, locate, read, search, retrieve |
|  | CodeVisionary \[ [21](https://arxiv.org/html/2601.05111#bib.bib31 "")\] | Code generation | Code execution, static linter, unit tests, screenshot, web browsing |
|  | Evaluation Agent \[ [28](https://arxiv.org/html/2601.05111#bib.bib27 "")\] | Visual generation | Visual generative models |
|  | ARM-Thinker \[ [12](https://arxiv.org/html/2601.05111#bib.bib32 "")\] | Multimodal generation | Instruction following checks, crop/zoom tools, document retrieval tools |
| Correctness verification | HERMES \[ [22](https://arxiv.org/html/2601.05111#bib.bib33 "")\] | Math reasoning | Translator, theorem prover |
|  | VerifiAgent \[ [23](https://arxiv.org/html/2601.05111#bib.bib34 "")\] | Factual & Math reasoning | Search engine, Python interpreter, theorem prover |
|  | Agentic RM \[ [8](https://arxiv.org/html/2601.05111#bib.bib29 "")\] | Factual & Math reasoning | Search engine, Python interpreter |

Table 1: Tool integration in representative Agent-as-a-Judge methods, grouped by primary tool usage purpose.
Tool integration is a defining capability of Agent-as-a-Judge frameworks, enabling judges to ground evaluation in external evidence and explicit checks.
---
As shown in Table [1](https://arxiv.org/html/2601.05111#S3.T1 "Table 1 ‣ 3.3 Tool Integration ‣ 3 Methodologies ‣ A Survey on Agent-as-a-Judge"), existing approaches can be grouped into evidence collection and correctness verification based on the purpose of tool use.
#### Evidence Collection.
A common use of tools in Agent-as-a-Judge frameworks is to collect additional evidence that supports evaluations. Such evidence includes intermediate artifacts, execution results, and perceptual signals that cannot be reliably obtained through text-based reasoning. In code-related tasks, Agent-as-a-Judge \[ [20](https://arxiv.org/html/2601.05111#bib.bib30 "")\] and CodeVisionary \[ [21](https://arxiv.org/html/2601.05111#bib.bib31 "")\] allow judges to inspect execution artifacts or run automated checks to expose execution feedback for evaluation. Similar methods are adopted in multimodal settings. Evaluation Agent \[ [28](https://arxiv.org/html/2601.05111#bib.bib27 "")\] enables judges to invoke external visual models to obtain visual quality or alignment signals, while ARM-Thinker \[ [12](https://arxiv.org/html/2601.05111#bib.bib32 "")\] gathers fine-grained visual and contextual evidence through document access and localized visual operations. Overall, these works integrate tools to surface observable and task-relevant evidence, expanding the judge’s access to execution-level, perceptual, and contextual information, and supporting more reliable evaluation.
#### Correctness Verification.
Another line of work employs tools to verify whether the evaluand’s outputs or intermediate reasoning steps satisfy explicit correctness constraints, such as logical validity, mathematical soundness, or factual consistency. In these frameworks, the judge agent identifies which claims or steps require verification and invokes appropriate tools to check them. The resulting verification signals are then interpreted by the agent in context to inform the final evaluation. HERMES \[ [22](https://arxiv.org/html/2601.05111#bib.bib33 "")\] verifies mathematical reasoning through formal theorem proving, while VerifiAgent \[ [23](https://arxiv.org/html/2601.05111#bib.bib34 "")\] invokes programmatic and symbolic checkers to validate factual and computational claims. Agentic Reward Modeling \[ [8](https://arxiv.org/html/2601.05111#bib.bib29 "")\] further integrates correctness verification by combining fact-checking tools and programmatic validators to produce structured correctness signals that inform the final evaluation.
Takeaway
Tool integration in Agent-as-a-Judge grounds evaluation in observable and verifiable signals by allowing judges to actively gather evidence and check correctness through external tools.
### 3.4 Memory and Personalization

Memory enables Agent-as-a-Judge frameworks to retain information across evaluation steps, supporting multi-step reasoning, consistent judgment, and reuse of prior results. We categorize prior work by the role of memory, including intermediate state tracking and personalized context preservation.
#### Intermediate State.
In multi-step evaluation settings, Agent-as-a-Judge frameworks use memory to retain intermediate evaluation states generated during assessment, providing the necessary context for conditional routing and adaptive decision-making based on intermediate feedback–a fundamental mechanism for Reactive Agent-as-a-Judge.
HERMES \[ [22](https://arxiv.org/html/2601.05111#bib.bib33 "")\] retains intermediate proof states when combining reasoning with formal theorem proving, enabling consistent verification across long reasoning chains. ARM-Thinker \[ [12](https://arxiv.org/html/2601.05111#bib.bib32 "")\] preserves intermediate evidence such as visual reasoning outputs and tool interaction results, which are later reused to ground evaluation.
---
We begin by reviewing the foundational LLM-as-a-Judge and its limitations.
We then examine the shift toward Agent-as-a-Judge, analyzing key dimensions that characterize the agentic approach.
Finally, we summarize Agent-as-a-Judge’s development trend into three progressive stages with distinct levels of autonomy and adaptability.
### 2.1 LLM-as-a-Judge

LLM-as-a-Judge paradigm emerged to overcome the scalability limits of human evaluation and the semantic insensitivity of traditional metrics. Zheng et al., \[ [1](https://arxiv.org/html/2601.05111#bib.bib54 "")\] formalized this approach by introducing benchmarks like MT-Bench to assess model alignment. Building on this, G-Eval \[ [13](https://arxiv.org/html/2601.05111#bib.bib55 "")\] leveraged chain-of-thought prompting for better alignment in natural language generation (NLG), while Prometheus \[ [14](https://arxiv.org/html/2601.05111#bib.bib56 "")\] induced fine-grained evaluation in open-source models via specialized tuning. To mitigate systematic issues like position and verbosity bias \[ [7](https://arxiv.org/html/2601.05111#bib.bib57 "")\], JudgeLM \[ [15](https://arxiv.org/html/2601.05111#bib.bib58 "")\] utilized fine-tuning to develop more robust evaluators.
### 2.2 From LLM-as-a-Judge to Agent-as-a-Judge

As evaluands evolve from simple text responses to complex, multi-step tasks across specialized domains, traditional LLM-as-a-Judge has become increasingly inadequate, focusing on final outputs while failing to verify intermediate actions or satisfy the rigorous standards of professional fields \[ [2](https://arxiv.org/html/2601.05111#bib.bib62 ""), [6](https://arxiv.org/html/2601.05111#bib.bib59 "")\].
To bridge this gap, the paradigm is shifting toward Agent-as-a-Judge that employs decentralized deliberation, executable verification, and fine-grained assessment to mitigate these limitations.
#### Evolving Robustness: From Monolithic to Decentralized.
To mitigate the inherent parametric biases of monolithic LLM judges—such as the tendency to favor verbosity or their own output patterns—Agent-as-a-Judge paradigms employ specialized, decentralized agents that collaborate through autonomous decision-making \[ [10](https://arxiv.org/html/2601.05111#bib.bib16 ""), [16](https://arxiv.org/html/2601.05111#bib.bib24 "")\].
Crucially, this decentralized architecture facilitates the injection of expert prior knowledge: by decomposing complex evaluation goals into sub-tasks or structuring specific interaction workflows, we can enforce domain-specific constraints that a generalist model typically overlooks \[ [17](https://arxiv.org/html/2601.05111#bib.bib53 ""), [18](https://arxiv.org/html/2601.05111#bib.bib20 "")\]. Furthermore, multi-agent deliberation ensures collective robustness; distinct roles can isolate specific information points to neutralize bias, while debate and self-reflection allow agents to audit their own cognitive shortcuts, ensuring the final judgment transcends the heuristics of any single model \[ [19](https://arxiv.org/html/2601.05111#bib.bib65 ""), [7](https://arxiv.org/html/2601.05111#bib.bib57 "")\].
#### Evolving Verification: From Intuition to Execution.
Static LLM judges are fundamentally passive observers, unable to react to real-world feedback. They assess answers based on linguistic plausibility – how correct a response looks – without verification or evidence collection, leading to "hallucinated correctness" in complex tasks \[ [8](https://arxiv.org/html/2601.05111#bib.bib29 "")\].
Agent-as-a-Judge bridges this reality gap by replacing intuition with execution.
---
Multi-agent collaboration can further amplify risks if unsafe behaviors propagate across agents or if adversarial interactions emerge. Moreover, when judge agents are used to provide reward signals for model optimization, systematic biases or errors in agentic judgment may be reinforced and amplified during training, leading to unintended model behaviors.
#### Privacy.
Agent-as-a-Judge also introduces privacy challenges, particularly in settings that involve persistent memory or personalized evaluation. To maintain consistency or adapt judgments to specific users or contexts, judge agents may store intermediate states, user information, or historical interaction data. If not carefully designed, such memory mechanisms can increase the risk of sensitive data leakage or unauthorized inference about user attributes. This issue becomes more pronounced in professional domains such as medicine, law, or education, where evaluation often relies on confidential or personally identifiable information.
### 5.2 Future Directions

#### Personalization.
Current Agent-as-a-Judge systems are constrained by static, one-size-fits-all evaluation criteria, failing to align with diverse individual preferences. To bridge this gap, future research should focus on enhancing the autonomy and adaptivity of judge agents. A critical enabler is proactive memory management: rather than passively retrieving history, agents must actively manage the lifecycle of user-specific knowledge—autonomously deciding when to register new preferences, update evolving standards, or prune obsolete feedback. This agentic control transforms memory into a dynamic belief system, allowing the judge to continuously refine its criteria and maintain alignment with the user’s specific values and usage contexts.
#### Generalization.
Current systems rely on predefined rubrics constructed offline, limiting their ability to generalize across diverse or open-ended tasks. Future judge agents should leverage planning capabilities to dynamically discover and adapt evaluation criteria.
1) Context-Aware Rubric Generation: Agents should synthesize evaluation criteria on-the-fly by analyzing the specific intent and complexity of responses, identifying relevant assessment dimensions not anticipated during design.
2) Adaptive Multi-Granularity Scoring: Rubrics should dynamically scale based on task difficulty—applying high-level holistic criteria for straightforward tasks, while decomposing into fine-grained sub-rubrics for complex workflows.
#### Interactivity.
Current systems operate as passive, one-way observers. Future agents should evolve into interactive evaluators that actively engage with both the environment and human stakeholders.
1) Interactive Environmental Feedback:
Instead of static test suites, judge agents should dynamically tailor evaluation trajectories—autonomously escalating task complexity or isolating edge cases to rigorously probe the evaluand’s failure boundaries.
2) Human-Agent Collaborative Calibration:
To address subjective or ambiguity-rich scenarios, agents should leverage human-in-the-loop mechanisms. By proactively consulting experts to verify intent or resolve conflicts, the judge refines its criteria through multi-turn alignment, ensuring higher trust and interpretability.
#### Optimization.
Current approaches predominantly rely on inference-time engineering, which is fundamentally bottlenecked by the fixed capabilities of frozen backbones. To transcend these limits, the field must pivot towards Training-based Optimization. This paradigm shift entails two key levels: 1) Individual Capability: Utilizing Reinforcement Learning (RL) to internalize complex agentic behaviors—such as sequential planning and adaptive tool use—that are difficult to elicit via prompting alone. 2) Learned Coordination: Extending optimization to multi-agent settings.
