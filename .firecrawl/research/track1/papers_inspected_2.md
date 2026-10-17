=== PAPER 7: arxiv:2607.13303 (Monty) ===
# Faithful Autoformalization of Natural Language Assertions

Paper ID: 6782959751196304010
IDs: arxiv:2607.13303
Authors: Hongyi Liu; Madhusudan Parthasarathy; Adithya Murali
Categories: cs.SE, cs.AI
Dates: created 2026-07-14; updated 2026-07-20

## Abstract
Formal contracts are essential for software testing and verification, yet writing them remains labor-intensive and error-prone. LLMs offer a promising path toward autoformalization: synthesizing executable assertions from natural-language specifications and thereby bridging the gap between informal developer intent and formal executable specifications. We present Monty: an autoformalization framework for assertions that tackles the challenges of expectations of validity of assertions and ambiguity in natural-language. Our techniques are based on filtering formalizations using a novel conformance score metric and validity scores obtained from testing the code against formalized assertions. We evaluate our approach on 541 assertion-generation tasks derived from 22 collection-like Java classes, and show that our technique produces the ground truth more reliably (improving upto 20 points in precision on average) than when using LLMs naively to translate assertions.
For example, people use the word “positive” in an informal sense to mean both strictly positive and non-negative, depending on the context. Another example documented in prior work on human understanding of LTL [Greenman et al. (2022)](https://arxiv.org/html/2607.13303#bib.bib18 "") is phrases like “the red light is on until the blue light comes on”, which does not clearly specify whether the red light continues to be on or if it turns off when the blue light turns on. Note that both of these translations would be faithful to the original utterance, and are therefore not resolved by our solution to Challenge 1.
### Monty Architecture

We now describe Monty, our methodology for faithful autoformalization of specifications. Our overall pipeline is depicted in Figure [2](https://arxiv.org/html/2607.13303#S4.F2 "Figure 2 ‣ Problem Statement ‣ 4 Problem Statement and Methodology ‣ Faithful Autoformalization of Natural Language Assertions").
We first prompt an LLM with the module and method under consideration, as well as the NL specification ss. We also provide information about the target logic in the prompt, and a few in-context examples. (see Appendix [B](https://arxiv.org/html/2607.13303#A2 "Appendix B Prompt Design ‣ Faithful Autoformalization of Natural Language Assertions") for the full prompt.) We then obtain candidate formalizations ψ1,ψ2,…​ψn\\psi\_{1},\\psi\_{2},\\ldots\\psi\_{n}. The first stage of our architecture then calls, for each candidate formalization ψi\\psi\_{i}, (a) a test generator that evaluates whether ψi\\psi\_{i} is test-valid for the given method, and (b) a conformance measurement module that measures the overlap in the semantic content between ψi\\psi\_{i} and the original NL assertion ss. During this process we also eliminate syntactically malformed generations, or generations that do not compile without errors.
The second stage of our architecture is a decision matrix that takes the scores from the test generator and the conformance checker for all the candidates and returns the subset of them that are the most likely faithful formalizations. One of the key insights of our work is that inductive biases (e.g., presumption of validity) can be used to combat some of the inherent ambiguity in natural-language specifications.
The final stage of our system is an active learning loop that disambiguates between the remaining candidates. We detail the construction of the nontrivial modules in our architecture below.
_Clausal Coverage Conformance Checker._ One of the key contributions of our work is the construction of a conformance checker to address Challenge 1 above, namely the judgment of semantic equivalence between an NL assertion and a formal assertion. Since natural language is inherently ambiguous, we would not want the conformance checker to pick up on details in the formal assertion that were not specified clearly in the NL assertion. Our key insight here is that inherent ambiguity typically manifests _locally_ in the formal assertions, and it is therefore possible to rule out many bad formalizations by looking at the broad structure of the two assertions.
We call the resulting technique _clausal coverage_. We first ask an LLM to describe the given formalization in natural language. We then prompt the LLM to identify all the substantive clauses in the original NL assertion as well as the description, and ask whether the description is both (a) Sound: the description contains all the clauses in the NL assertion and (b) Complete: the description does not contain any information beyond what is given by the clauses in the NL assertion. We ask the LLM to provide a score in the interval \[−1,1\]\[-1,1\] along with the following rubric: Positive scores indicate that the clauses in the original assertion were covered, with +1+1 indicating perfect conformance.
---
(2026)](https://arxiv.org/html/2607.13303#bib.bib43 "") focuses on complex loop functions, using program slicing and LLM-based logical deletion to remove irrelevant or incorrect specifications. AutoReSpec [Ayon and Ahmed (2026)](https://arxiv.org/html/2607.13303#bib.bib44 "") further explores validator-guided collaborative LLM generation for improving verifiable specifications. Recent work has also used LLM-based extraction of specifications for libraries to prove a client correct [Uppar et al. (2026)](https://arxiv.org/html/2607.13303#bib.bib48 "").
Our work differs in that it targets module-level code contexts and explicitly starts from natural-language specifications, with the goal of formalizing them into executable assertions while preserving the user’s intended meaning.
### Round-Trip Techniques for Specification and Verification

Round-trip techniques translate artifacts back into the original representation to expose information loss or semantic mismatch. In NL-to-formal-specification settings, prior systems use back-translation or subformula-to-text mappings to inspect, debug, or refine generated specifications [Cosler et al. (2023)](https://arxiv.org/html/2607.13303#bib.bib38 ""). Clover checks consistency among code, docstrings, and formal annotations through reconstruction tests [Sun et al. (2024)](https://arxiv.org/html/2607.13303#bib.bib45 ""), while Claimcheck back-translates verified Dafny lemmas to detect proof–intent mismatches [Graciolli and Amin (2026)](https://arxiv.org/html/2607.13303#bib.bib46 ""). Round-trip translation has been used for quality control in machine translation and software traceability, but is not always a reliable proxy for forward-translation correctness [Somers (2005)](https://arxiv.org/html/2607.13303#bib.bib47 "").
Our conformance check adapts this idea to assertion autoformalization. Rather than simply prompting an LLM to judge equivalence, it evaluates bidirectional clause-level coverage with relevant code context, including method signatures, arguments, return values, and documentation.
## 8 Conclusions

We present Monty, a pipeline for autoformalizing natural-language specifications into executable assertions by combining LLM-based candidate generation with a decision matrix based on execution-level validity and semantic-level conformance, together with an active-learning loop for disambiguation. Rather than relying on a single raw LLM output, Monty generates multiple candidate formalizations, checks their executable behavior, estimates their alignment with the intended specification, and selects a reliable final formalization when possible. Across multiple datasets and backbone models, our results show that Monty improves the reliability of the formalizations it reports. The ablation studies further show that contextual, roundtrip-based bidirectional clausal coverage provides an effective conformance signal for candidate selection.
## References

- \[1\]R. Alur, P. Černý, P. Madhusudan, and W. Nam (2005)Synthesis of interface specifications for java classes.
SIGPLAN Not.40 (1), pp. 98–109.
External Links: ISSN 0362-1340,
[Link](https://doi.org/10.1145/1047659.1040314 ""),
[Document](https://dx.doi.org/10.1145/1047659.1040314 "")Cited by: [§7](https://arxiv.org/html/2607.13303#S7.SSx1.p1.1 "Traditional Specification Mining and Contract Inference ‣ 7 Related Work ‣ Faithful Autoformalization of Natural Language Assertions").
- \[2\]G. Ammons, R. Bodík, and J. R. Larus (2002)Mining specifications.
In Proceedings of the 29th ACM SIGPLAN-SIGACT Symposium on Principles of Programming Languages,
POPL ’02, New York, NY, USA, pp. 4–16.
---
Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2607.13303v2 \[cs.SE\] 16 Jul 2026

# Faithful Autoformalization of Natural Language Assertions

Hongyi Liu
Affiliation: University of Wisconsin-Madison
Affiliation: {adithyamurali, hliu794}@cs.wisc.eduMadhusudan Parthasarathy
Affiliation: University of Illinois at Urbana-Champaign
Affiliation: madhu@illinois.eduAdithya Murali
Affiliation: University of Wisconsin-Madison
Affiliation: {adithyamurali, hliu794}@cs.wisc.edu

###### Abstract

Formal contracts are essential for software testing and verification, yet writing them remains labor-intensive and error-prone. LLMs offer a promising path toward autoformalization: synthesizing executable assertions from natural-language specifications and thereby bridging the gap between informal developer intent and formal executable specifications. We present Monty: an autoformalization framework for assertions that tackles the challenges of expectations of validity of assertions and ambiguity in natural-language.
Our techniques are based on filtering formalizations using a novel conformance score metric and validity scores obtained from testing the code against formalized assertions. We evaluate our approach on 541 assertion-generation tasks derived from 22 collection-like Java classes, and show that our technique produces the ground truth more reliably (improving upto 20 points in precision on average) than when using LLMs naively to translate assertions.
## 1 Introduction

Formal specifications for modular code, in terms of contracts or postcondition assertions, have been a cornerstone in enabling robust and effective software development. Formal specifications realized as runtime checks enable testing code at the unit level, enable formal verification efforts, and enable evolution of software where modules can be swapped with others that satisfy the same specifications. The paradigm of Design by Contract [Meyer (1992a)](https://arxiv.org/html/2607.13303#bib.bib2 "") concretizes this approach to development of software, and several specification languages for contracts have been developed over decades, ranging from Eiffel [Meyer (1992b)](https://arxiv.org/html/2607.13303#bib.bib3 ""), JML [Leavens et al. (1999)](https://arxiv.org/html/2607.13303#bib.bib4 ""), Spec# [Barnett et al. (2004)](https://arxiv.org/html/2607.13303#bib.bib5 ""), and Code Contracts [Logozzo (2013)](https://arxiv.org/html/2607.13303#bib.bib6 ""), the latter two at Microsoft. However, despite the advantages, we have always struggled in getting programmers to write formal specifications, primarily due to it being perceived as a “burden” that slows the time to ship out software.
The advent of AI opens up two avenues that transform the framework of writing code with contracts. First, AI opens up the exciting possibility of _natural language specifications_ that are then autoformalized into formal and executable contracts (executable logics). This considerably lowers the burden of writing formal specifications, and is akin to current documentation that is used for understanding code between human software developers.
Second, AI-based automated coding/programming has made great advances in recent years, allowing programmers to simply state the intent of their programming task. This however creates a large gap between the intent of the programmer and the code [Lahiri (2026)](https://arxiv.org/html/2607.13303#bib.bib7 "").
---
Negative scores indicate that parts of the formalization conflict with the original assertion, with greater negative scores indicating more serious contradictions between the two assertions. A zero score is a neutral judgment that encompasses many cases like unrelated content in the formalization, or a failure to clearly detect either conformance or contradiction. This method of using an LLM as a scoring function is known as LLM-as-a-Judge in the Machine Learning literature [Zheng et al. (2023)](https://arxiv.org/html/2607.13303#bib.bib17 ""). We repeat this evaluation multiple times and average the scores, accepting a formalization as faithful only if it exceeds a certain threshold. In our experiments we repeat the check 88 times and set the threshold to be 0.60.6. We provide the prompt that we use for conformance checking in Appendix [B](https://arxiv.org/html/2607.13303#A2 "Appendix B Prompt Design ‣ Faithful Autoformalization of Natural Language Assertions").
Though the above technique is intuitive, to our knowledge we are the first to utilize this approach for conformance checking. In fact, in our initial version of the architecture we used a conformance checking method based on Natural Language Inference (NLI) [Bowman et al. (2015)](https://arxiv.org/html/2607.13303#bib.bib19 ""), similar to the recommendations found in contemporary works that mention conformance checking [Fazelnia et al. (2024)](https://arxiv.org/html/2607.13303#bib.bib20 ""). These contemporary techniques also recommend doing a “reverse translation”, and ask whether it is equivalent to the original input. However, we found that this only amplified the inherent ambiguity problem, and LLMs turned out to be overly sensitive to differences in phrasing. We evaluate ablations of our conformance checking technique in Section [6](https://arxiv.org/html/2607.13303#S6 "6 Evaluation ‣ Faithful Autoformalization of Natural Language Assertions").
_Decision Matrix and Inductive Biases._ The second insight of our work is that the inherent ambiguity in natural language can be addressed in part by incorporating inductive biases specific to the application domain. For example, if the statement “xx is positive” yields both x>0x>0 and x≥0x\\geq 0 as faithful candidate formalizations where only one of them is test-valid for the given method, we may be able to pick the valid one if we assume that the application demands a presumption of validity of the assertion on the part of the user writing the NL specification. This is often the case in documentation of code, and has been the default incorporated by other related works on specification mining (see Section [7](https://arxiv.org/html/2607.13303#S7 "7 Related Work ‣ Faithful Autoformalization of Natural Language Assertions")). In contrast, if the user is writing assertions to identify edge cases and finding bugs, we may in fact want to choose the formalization that is _not_ test-valid for the given method, and return the inputs that raise the assertion violation.
In our work we assume a more general setting with no presumptions about the validity of the assertions. Instead, we separate the generated assertions into test-valid and test-invalid ones, and choose the candidates with the highest conformance score from each category. Of course, we do not pick any candidates whose conformance score is below the acceptable threshold. The intuition behind our approach is that the best test-valid and test-invalid formalizations together capture the range of ambiguity in the original natural-language assertion. This is similar to the idea of a version space bounded by a general hypothesis and a specific hypothesis in traditional work on learning theory [Mitchell (1977)](https://arxiv.org/html/2607.13303#bib.bib21 "").
_Active Learning Loop._ The final stage of our pipeline utilizes active learning to disambiguate between faithful candidate formalizations.
=== PAPER 8: arxiv:2610.12375 (OnTrack) ===
# OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport

Paper ID: 7456578192949344382
IDs: arxiv:2610.12375
Authors: Babak Barazandeh; Connor Swanson; Chinmay Kulkarni; Nikhil Mungel
Categories: cs.AI, cs.CL, cs.CY, cs.LG
Dates: created 2026-10-08; updated 2026-10-09

## Abstract
Agents are deployed in applications from trip planners and stock trading to IT incident triage. In most cases, LLM agents work autonomously with minimal rule-based safeguarding, leading to cost and safety issues from irreversible actions. Recent works resolve this either by using a safeguard agent to monitor behavior or evaluating logs post-hoc. The first adds cost and latency to every step; the second delivers its verdict after the run, when tokens are burned and damage is done. To overcome this, we propose OnTrack, a streaming monitoring mechanism that compares an agent's steps and dependencies against recorded successful runs to alert users or block the agent in about a millisecond per step. We study this problem in three regimes of decreasing access: full reference access (historical runs and tool schemas), intermediate access (only tool schemas), and no prior knowledge (only step logs as generated). Expectation of OnTrack's monitoring capabilities reduces as data access drops, ranging from plan violation detection to identifying loops, stalls, and repeated tool calls. Finally, we evaluate OnTrack using SWE-bench trajectories. Based on the first 8 steps, our method ranks failing trajectories below succeeding ones better than content similarity approaches (+0.057 AUROC). With an abort policy, we save about 18% of compute that would be burned on failing runs, where 83% of interrupted runs were actually heading to failure (5 out of 6 aborts were correct).
The evaluator must produce a verdict before the
agent’s next tool call. Re-solving the full alignment from scratch at every
step is unnecessary and, as the trajectory grows, quickly becomes
infeasible.
S4 (decisions, not scores).
Post hoc evaluation methods can output a score, and the operator can define a threshold to evaluate if the execution was successful or not. The streaming monitoring mechanism can’t. It instead outputs an action: continue, warn, or halt. To better understand this, consider an agent at step 5 that takes one hallucinated step. This is one fifth of all steps, so this will result in the aggregated score going under the threshold, while if this happened at step 30, it might move the score slightly. As a result, the same score value means different things at different lengths. So, the score is informative, but it should not be used as a trigger and no fixed threshold can drive the decision. A streaming monitoring mechanism should focus on per-step signals whose meaning stays the same as the trajectory grows.
OnTrack addresses all four challenges. For S1, the monitor only expects
the parts of the reference the agent could have reached so far, so an
agent is never punished for being early (Sec. [4.2](https://arxiv.org/html/2610.12375#S4.SS2 "4.2 The prefix problem: frontier-masked marginals ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport")). For
S2, a new step’s structural influence starts at zero and phases in as
later steps use its output; edges discovered late are inserted into the
graph in place (Sec. [4.4](https://arxiv.org/html/2610.12375#S4.SS4 "4.4 Provisional structure ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport")). For S3, instead of re-solving
the alignment at every step, we take one warm-started iteration of the
batch solver per event — about a millisecond per step — and run the
solver to convergence only before acting on an intervention
(Sec. [4.3](https://arxiv.org/html/2610.12375#S4.SS3 "4.3 Keeping the quadratic term: streaming conditional gradient ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport")). For S4, decisions come from per-step signals with a
short grace window for new steps, never from the aggregate score
(Sec. [4.5](https://arxiv.org/html/2610.12375#S4.SS5 "4.5 Signals, lifecycle, and verdicts ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport")). At the end of the run, one final solve makes
the monitor’s output identical to the batch evaluator’s — provided the
dependencies discovered online match what batch extraction would find
(Prop. [1](https://arxiv.org/html/2610.12375#Thmproposition1 "Proposition 1 (Anytime reduction to the implemented batch procedure). ‣ 5 Theoretical Properties ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport")).
## 2 Related Work

#### Trajectory evaluation.
Evaluating an agent trajectory still means choosing between a cheap score and a detailed one. Outcome-only benchmarks \[ [5](https://arxiv.org/html/2610.12375#bib.bib9 ""), [6](https://arxiv.org/html/2610.12375#bib.bib10 ""), [7](https://arxiv.org/html/2610.12375#bib.bib11 "")\] collapse a run to pass or fail, so the steps that produced the outcome never enter the score. Text metrics that match a trace against a reference (exact match, BLEU/ROUGE, embedding alignment \[ [8](https://arxiv.org/html/2610.12375#bib.bib12 "")\]) do look inside the run, but they assume the task has one correct wording.
---
Cobbe (2024)Let’s verify step by step.
In International Conference on Learning Representations (ICLR),
Cited by: [§1](https://arxiv.org/html/2610.12375#S1.p3.1 "1 Introduction ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[4\]B. Barazandeh, S. Majumdar, and G. Michailidis (2026)Otap: structure-aware optimal transport for evaluating planning and execution in agent trajectories.
arXiv preprint arXiv:2607.17082.
Cited by: [item S2 (provisional structure).](https://arxiv.org/html/2610.12375#S1.I1.ix2.p1.1 "In 1 Introduction ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§1](https://arxiv.org/html/2610.12375#S1.p5.1 "1 Introduction ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px3.p1.1 "Transport-based trajectory scoring. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§3](https://arxiv.org/html/2610.12375#S3.p7.1 "3 Problem Formulation ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4](https://arxiv.org/html/2610.12375#S4.SS0.SSS0.Px1.p1.1 "Ingredients: the cost table and the alignment. ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4.2](https://arxiv.org/html/2610.12375#S4.SS2.p4.1 "4.2 The prefix problem: frontier-masked marginals ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4.3](https://arxiv.org/html/2610.12375#S4.SS3.p1.1 "4.3 Keeping the quadratic term: streaming conditional gradient ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4.4](https://arxiv.org/html/2610.12375#S4.SS4.p3.1 "4.4 Provisional structure ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4.5](https://arxiv.org/html/2610.12375#S4.SS5.p1.1 "4.5 Signals, lifecycle, and verdicts ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§4.6](https://arxiv.org/html/2610.12375#S4.SS6.p1.1 "4.6 Multi-reference streaming and reference regimes ‣ 4 The OnTrack Evaluator ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§5](https://arxiv.org/html/2610.12375#S5.SS0.SSS0.Px1.p1.1 "Complexity. ‣ 5 Theoretical Properties ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§5](https://arxiv.org/html/2610.12375#S5.p3.1.1 "Proof sketch.
---
‣ 5 Theoretical Properties ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport"),
[§7](https://arxiv.org/html/2610.12375#S7.p1.1 "7 Limitations and Future Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[5\]G. Mialon, C. Fourrier, T. Wolf, Y. LeCun, and T. Scialom (2024)GAIA: a benchmark for general AI assistants.
In International Conference on Learning Representations (ICLR),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[6\]S. Zhou, F. F. Xu, H. Zhu, X. Zhou, R. Lo, A. Sridhar, X. Cheng, T. Ou, Y. Bisk, D. Fried, U. Alon, and G. Neubig (2024)WebArena: a realistic web environment for building autonomous agents.
In International Conference on Learning Representations (ICLR),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[7\]X. Liu, H. Yu, H. Zhang, Y. Xu, X. Lei, H. Lai, Y. Gu, H. Ding, K. Men, K. Yang, S. Zhang, X. Deng, A. Zeng, Z. Du, C. Zhang, S. Shen, T. Zhang, Y. Su, H. Sun, M. Huang, Y. Dong, and J. Tang (2024)AgentBench: evaluating LLMs as agents.
In International Conference on Learning Representations (ICLR),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[8\]T. Zhang, V. Kishore, F. Wu, K. Q. Weinberger, and Y. Artzi (2020)BERTScore: evaluating text generation with BERT.
In International Conference on Learning Representations (ICLR),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px1.p1.1 "Trajectory evaluation. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[9\]M. Cuturi (2013)Sinkhorn distances: lightspeed computation of optimal transport.
In Advances in Neural Information Processing Systems (NeurIPS),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px2.p1.1 "Optimal transport. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[10\]L. Chizat, G. Peyré, B. Schmitzer, and F. Vialard (2018)Scaling algorithms for unbalanced optimal transport problems.
Mathematics of Computation87, pp. 2563–2609.
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px2.p1.1 "Optimal transport. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[11\]F. Mémoli (2011)Gromov–Wasserstein distances and the metric approach to object matching.
Foundations of Computational Mathematics11, pp. 417–487.
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px2.p1.1 "Optimal transport. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[12\]T. Vayer, N. Courty, R. Tavenard, L. Chapel, and R. Flamary (2019)Optimal transport for structured data with application on graphs.
In Proceedings of the 36th International Conference on Machine Learning (ICML),
Cited by: [§2](https://arxiv.org/html/2610.12375#S2.SS0.SSS0.Px2.p1.1 "Optimal transport. ‣ 2 Related Work ‣ OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport").
- \[13\]G. Peyré and M. Cuturi (2019)Computational optimal transport.
---
A broken plan that resembles the reference can then rank above a valid plan written differently, and \[ [4](https://arxiv.org/html/2610.12375#bib.bib1 "")\] shows that this ranking can fall below chance. LLM-as-a-judge \[ [2](https://arxiv.org/html/2610.12375#bib.bib7 "")\] and process reward models \[ [3](https://arxiv.org/html/2610.12375#bib.bib8 "")\] score individual steps, so they are not stuck on a single reference. The cost is practical: a judge adds latency, cost, and run-to-run noise, and a reward model needs step-level annotation before it can be trained. These methods also wait until the run has finished. Observability platforms that sit on live traffic store detailed traces, but the checks they apply while a run is open are schema validation, token heuristics, and judges applied asynchronously to spans that have already closed. We are not aware of a deployed system that reasons about the structure of the execution graph while that graph is still growing.
#### Optimal transport.
The solver is built from standard parts. Entropic regularization and Sinkhorn iterations \[ [9](https://arxiv.org/html/2610.12375#bib.bib2 "")\] made optimal transport usable in practice. Unbalanced variants \[ [10](https://arxiv.org/html/2610.12375#bib.bib3 "")\] relax exact conservation of mass, so mass that should not be matched can be discarded. Gromov–Wasserstein \[ [11](https://arxiv.org/html/2610.12375#bib.bib4 "")\] compares relational structure, and its fused form \[ [12](https://arxiv.org/html/2610.12375#bib.bib5 "")\] does the same for attributed graphs. Warm-started incremental Sinkhorn schemes already exist for problems that change slowly \[ [13](https://arxiv.org/html/2610.12375#bib.bib6 "")\]. OnTrack uses that warm start. What changes between solves is more specific: the support grows by one row with each event, and the reference marginal moves as the agent progresses. That combination, as far as we know, is new.
#### Transport-based trajectory scoring.
The closest prior work is Otap\[ [4](https://arxiv.org/html/2610.12375#bib.bib1 "")\], which scores a completed trajectory after the fact by aligning attributed execution DAGs. We adopt its graph formalism and its node costs. Three findings from its ablations constrained the streaming design. The structure term is load-bearing. Restricting the method to a single reference costs 16.9 AUROC points. And the largest source of error is heuristic dependency extraction. From there, this paper asks a different question. Frontier masking, the streaming solver, provisional-structure handling, the verdict engine, and the calibration finding have no counterpart in the batch setting, because a batch scorer only has to say how good a finished run was. OnTrack has to decide whether the run should be allowed to continue.
## 3 Problem Formulation

To formulate the agent behavior, consider how an agent tackles a problem. It generates a stream of steps in which, at each step it describes what it is doing, calls a tool with the required arguments, and receives its result. Steps here are not independent from one another; the artifact (a queried database, a tool result) produced at this step can be consumed as input to other steps down the road. As a result, this execution is not a flat sequence; it is a growing dependency graph. Importantly, these links are not always visible at the moment a step is taken. The importance of one step may only become clear when a later step uses its output. The following definition formalizes this trajectory.
###### Definition 1(Streamed trajectory prefix).
We define the agent’s execution procedure as a stream of events s1,s2,…s\_{1},s\_{2},\\dots, where each event is a tuple consisting of st=(at,τt,ct,et,ζt)s\_{t}=(a\_{t},\\tau\_{t},c\_{t},e\_{t},\\zeta\_{t}).
=== PAPER 9: arxiv:2608.01428 (BRACE Budgeted Replanning) ===
# When Replanning Becomes the Bottleneck: Budgeted Replanning for Embodied Agents

Paper ID: 6131140761557304212
IDs: arxiv:2608.01428
Authors: Shuaijun Liu; Feiyang You; Xingwei Chen; Ningxin Su
Categories: cs.RO, cs.AI, cs.LG
Dates: created 2026-08-02; updated 2026-08-04

## Abstract
Embodied agents replan frequently to recover from execution drift, partial observability, and coordination hazards, but each LLM-based replanning call can consume an accumulated textual context that grows over time and across agents. Once this context becomes large, replanning latency develops heavy tails and can miss real-time deadlines even when task success remains high, a failure mode that is hard to detect from average latency or success alone. We present BRACE, a controller that formulates replanning as a budgeted control loop by deciding whether to replan, selecting a replanning mode, and allocating an explicit token budget and latency service-level objective (SLO) while accounting for optional efficiency modules. As a reusable component, we introduce E-RECAP, a cost-aware progressive token pruning method that predicts token utility and prunes replanning contexts across transformer layers while preserving critical head and tail tokens. Across Meta Habitat, RoboFactory, and AirSim, BRACE with E-RECAP reduces replanning-call token counts by 62-92% and SLO violation rates from 85.5-100.0% to 4.7-50.0% in settings where task success is already saturated. In a harder RoboFactory setting where open-loop, frozen-plan, and No BRACE all fail, BRACE + E-RECAP reaches 80.0% success with 4.6% SLO violations, demonstrating that tail-aware per-call budgeting is effective across embodied platforms.
In LLM/VLA-based systems, a replanning request typically carries a large textual prompt including task specification, recent observations/actions, failure traces, and, in multi-agent settings, messages or summaries from other agents. We denote this accumulated replanning context at controller step tt by CtC\_{t} and its token length by NtN\_{t}. As episodes progress and more agents contribute, NtN\_{t} increases and replanning becomes slower and more variable.
BRACE treats each _potential_ replanning point as a controller decision. At step tt, the controller decides whether to invoke the planner. If it does, we call that a _replanning call_. A replanning call is not just the planner forward pass: it may include context compression, retrieval, or clarification. We measure and enforce budgets on this end-to-end call path.
Budgets and the replanning call path.
BRACE exposes two per-call budget variables: (1) a _token budget_ BtB\_{t}, defined as the number of tokens passed into the planner _after_ any compression or budgeting, and (2) a _latency target_ SLOt\\mathrm{SLO}\_{t} (ms), interpreted as a deadline for the end-to-end replanning call latency (including enabled modules). Our accounting and evaluation are therefore call-level: we report tokens, latency percentiles, and deadline-miss rates across replanning calls rather than only episode-level aggregates.
Figure [2](https://arxiv.org/html/2608.01428#S3.F2 "Figure 2 ‣ 3.1 Replanning Under Context Growth and Deadlines ‣ 3 Method ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents") summarizes the BRACE controller and the modules that can appear on the replanning call path.
![Refer to caption](https://arxiv.org/html/2608.01428v1/overview.png)Figure 2: Overview of BRACE: a closed-loop controller that determines whether to invoke replanning and selects the per-call token budget and latency SLO, with E-RECAP as a composable token-pruning module on the replanning call path.
### 3.2 BRACE Controller: When to Replan and How Much to Spend

BRACE maps trigger signals and a small controller state to replanning decisions and per-call budgets. It has two responsibilities: (1) decide whether a trigger should result in a planner invocation, and (2) if replanning is executed, choose the replanning mode and budgets.
Let τt\\tau\_{t} denote a trigger indicator (or vector of trigger flags) at step tt. Triggers can be periodic, failure-driven (e.g., repeated action failures or divergence from an expected trajectory), or hazard-driven (e.g., safety or coordination signals in multi-agent settings). BRACE does not hard-code a single “always replan on trigger” rule. Instead, triggers are inputs to a controller that can skip replanning, replan with a constrained budget, or temporarily relax budgets after repeated failures.
Controller state and stability policies.
BRACE maintains a controller state σt\\sigma\_{t} that summarizes short-horizon execution and replanning history. In practice, σt\\sigma\_{t} includes counters and flags such as the number of steps since the last replanning call, the number of steps since the last plan change, and counts of consecutive failures. These variables support stabilization policies that reduce rapid back-to-back replanning, which can otherwise amplify latency spikes and coordination delays.
We implement two simple stabilization mechanisms:
_cooldown_ and _commit_ windows. Intuitively, cooldown prevents the controller from calling the planner again immediately after a recent call. Commit prevents the controller from discarding a newly produced plan before it has been executed for a minimum horizon. BRACE also supports _failure-aware overrides_: when failures persist, the controller can bypass or relax these gates and increase budgets to promote recovery.
A minimal formalization.
---
Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2608.01428v1 \[cs.RO\] 02 Aug 2026

# When Replanning Becomes the Bottleneck:   Budgeted Replanning for Embodied Agents

Shuaijun Liu
Affiliation: IoT, Information Hub, The Hong Kong University of Science and Technology (Guangzhou), Guangzhou, Guangdong, China
Feiyang You
Affiliation: IoT, Information Hub, The Hong Kong University of Science and Technology (Guangzhou), Guangzhou, Guangdong, China
Xingwei Chen
Affiliation: IoT, Information Hub, The Hong Kong University of Science and Technology (Guangzhou), Guangzhou, Guangdong, China
Ningxin Su
Affiliation: IoT, Information Hub, The Hong Kong University of Science and Technology (Guangzhou), Guangzhou, Guangdong, China
Correspondence to: [ningxinsu@hkust-gz.edu.cn](mailto:ningxinsu@hkust-gz.edu.cn "")

###### Abstract

Embodied agents replan frequently to recover from execution drift, partial observability, and coordination hazards, but each LLM-based replanning call can consume an accumulated textual context that grows over time and across agents. Once this context becomes large, replanning latency develops heavy tails and can miss real-time deadlines even when task success remains high, a failure mode that is hard to detect from average latency or success alone. We present BRACE, a controller that formulates replanning as a budgeted control loop by deciding whether to replan, selecting a replanning mode, and allocating an explicit token budget and latency service-level objective (SLO) while accounting for optional efficiency modules. As a reusable component, we introduce E-RECAP, a cost-aware progressive token pruning method that predicts token utility and prunes replanning contexts across transformer layers while preserving critical head and tail tokens. Across Meta Habitat, RoboFactory, and AirSim, BRACE with E-RECAP reduces replanning-call token counts by 62–92% and SLO violation rates from 85.5–100.0% to 4.7–50.0% in settings where task success is already saturated. In a harder RoboFactory setting where open-loop, frozen-plan, and No BRACE all fail, BRACE + E-RECAP reaches 80.0% success with 4.6% SLO violations, demonstrating that tail-aware per-call budgeting is effective across embodied platforms.
###### Keywords:

Embodied AI, Replanning, Systems, Token Pruning, Latency Service-Level Objective (SLO)

††affiliationnotice: †Corresponding author.
Project Website:[https://nebulis-lab.com/BRACE](https://nebulis-lab.com/BRACE "")

## 1 Introduction

Embodied agents operate under partial observability, actuation noise, and changing environments, so long-horizon plans can become invalid after only a few steps ( [Nasiriany et al., 2024](https://arxiv.org/html/2608.01428#bib.bib23 ""); [Feng et al., 2025](https://arxiv.org/html/2608.01428#bib.bib9 "")). Modern systems therefore run an _observe →\\rightarrow plan →\\rightarrow act →\\rightarrow replan_ loop and rely on frequent replanning for recovery ( [Kwon et al., 2025](https://arxiv.org/html/2608.01428#bib.bib15 ""); [Wu et al., 2025](https://arxiv.org/html/2608.01428#bib.bib39 ""); [Shcherba et al., 2025](https://arxiv.org/html/2608.01428#bib.bib32 ""); [Feng et al., 2025](https://arxiv.org/html/2608.01428#bib.bib9 "")). While recent vision-language-action (VLA) and LLM-based planners improve plan quality, the _systems cost_ of replanning is rarely treated as a first-class object.
---
Let Δt\\Delta\_{t} and κt\\kappa\_{t} be counters encoded in σt\\sigma\_{t}: Δt\\Delta\_{t} is the number of steps since the last replanning call (cooldown counter), and κt\\kappa\_{t} is the number of steps since the last plan update (commit counter). Let δ\\delta and ω\\omega be the corresponding thresholds. BRACE first applies a stability gate

|     |     |     |     |
| --- | --- | --- | --- |
|  | ut=𝕀⁡\[τt∧(Δt≥δ)∧(κt≥ω)\],u\_{t}=\\mathbb{I}\\!\\left\[\\tau\_{t}\\wedge(\\Delta\_{t}\\geq\\delta)\\wedge(\\kappa\_{t}\\geq\\omega)\\right\], |  | (1) |

where ut=1u\_{t}=1 means replanning is allowed at step tt (subject to any failure-aware override rules in σt\\sigma\_{t}). If ut=0u\_{t}=0, the agent continues executing the current plan without invoking the planner.
Absent failure-aware overrides, Eq. ( [1](https://arxiv.org/html/2608.01428#S3.E1 "Equation 1 ‣ 3.2 BRACE Controller: When to Replan and How Much to Spend ‣ 3 Method ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents")) also implies a deterministic anti-churn property: consecutive replanning calls must be separated by at least δ\\delta controller steps, and a newly changed plan must survive at least ω\\omega steps before the gate allows another plan replacement. Appendix [B](https://arxiv.org/html/2608.01428#A2 "Appendix B Controller Sweep (Proxy Environment) ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents") states this property explicitly and gives a short proof sketch. We use it as controller-side structure and empirical auditability, rather than presenting it as a full theorem-level stability guarantee.
If ut=1u\_{t}=1, BRACE selects a replanning mode and budgets:

|     |     |     |     |
| --- | --- | --- | --- |
|  | (mt,Bt,SLOt)=f⁡(τt,σt),(m\_{t},B\_{t},\\mathrm{SLO}\_{t})=f(\\tau\_{t},\\sigma\_{t}), |  | (2) |

where mtm\_{t} chooses which call-path modules are enabled and which planner prompt template is used. The token budget BtB\_{t} constrains the planner input length after any compression, and SLOt\\mathrm{SLO}\_{t} specifies the latency target for the end-to-end replanning call.
Explicit token budgets make comparisons cleaner. Given a target BtB\_{t}, any context-reduction baseline (e.g., recency truncation, random truncation, or structured summaries) can be forced to satisfy the same planner-input constraint. This isolates effects due to budgeting and selection from effects due to simply spending more tokens.
### 3.3 E-RECAP: Pruning for Replanning Context

BRACE is designed to compose with modules that reduce replanning cost or reuse prior computation: (1) token pruning (E-RECAP) to compress long contexts before the planner is called, (2) retrieval to reuse prior subplans or failure cases (RAG), (3) caching of previously generated plans or subplans, and (4) optional compression of coordination messages in multi-agent settings. These modules can reduce planner input size but also add latency, so BRACE treats the entire replanning call path as the object of budgeting and measurement and attributes overhead via phase accounting (Section [3.4](https://arxiv.org/html/2608.01428#S3.SS4 "3.4 Phase Accounting and Audit Logging ‣ 3 Method ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents")).
E-RECAP is a context-compression module that enforces a planner-input token budget by pruning the replanning context. The key difference from common VLM/VLA pruning settings is the object being pruned: E-RECAP targets the _long-horizon replanning prompt_ accumulated over time and across agents, rather than per-frame visual tokens or single-step queries.
Context growth model.
In a multi-agent setting with KK agents, a simple decomposition of context length is

|     |     |     |     |
| --- | --- | --- | --- |
|  | Nt=N0+∑i=1t∑a=1Kni,a,N\_{t}=N\_{0}+\\sum\_{i=1}^{t}\\sum\_{a=1}^{K}n\_{i,a}, |  | (3) |
---
A replanning call is not a lightweight query: prompts include task specification, recent history, failure traces, and, in multi-agent settings, messages and coordination summaries ( [Chang et al., 2025](https://arxiv.org/html/2608.01428#bib.bib4 ""); [Zhang et al., 2025a](https://arxiv.org/html/2608.01428#bib.bib43 ""); [Zu et al., 2025](https://arxiv.org/html/2608.01428#bib.bib45 ""); [Kang et al., 2025](https://arxiv.org/html/2608.01428#bib.bib20 ""); [Li et al., 2025c](https://arxiv.org/html/2608.01428#bib.bib17 "")). As this context grows, transformer planners become slow and bursty; in a closed loop, slow calls delay execution and can trigger more replanning.
Most embodied evaluations emphasize task success or mean latency, which can mask deadline misses. In our experiments, a baseline without budgeting or compression (“No BRACE”) achieves 100% success on three platforms while violating the replanning latency service-level objective (SLO) on most replanning calls, showed in Table [2](https://arxiv.org/html/2608.01428#S4.T2 "Table 2 ‣ 4.3 Results ‣ 4 Experiments ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents"). This motivates treating replanning as a budgeted systems primitive and reporting tail latency and SLO violations at call granularity.
We propose BRACE (Budgeted Replanning for Agentic Control in Embodied Systems), a budgeted replanning systems framework with an explicit controller/accounting interface for each replanning call. At each trigger, BRACE decides whether replanning should occur, selects a replanning mode, and sets a token budget BtB\_{t} (planner input after compression) together with a latency target SLOt\\mathrm{SLO}\_{t}. To reduce instability from rapid oscillations, BRACE supports cooldown/commit windows and failure-aware overrides that temporarily relax budgets after repeated failures. BRACE is modular and can include context-compression and reuse mechanisms on the replanning call path (e.g., token pruning, retrieval, plan caching, and communication compression).
To make composition comparable, BRACE instruments the replanning call path with phase accounting and audit logs. For each replanning call, we record tokens and latency for context compression, retrieval, planning, and optional modules, and summarize results with tail percentiles and SLO violation rates. This also enables _budget-matched_ baselines, where alternative context-reduction strategies are constrained to the same token budget to separate token count from matched-budget quality retention.
As an efficiency primitive for replanning, we introduce E-RECAP (Embodied REplanning with Cost-Aware Pruning), a progressive token-pruning module that compresses replanning context while preserving critical tokens. E-RECAP is trained to predict token importance and prunes across selected transformer layers, keeping head/tail tokens and selecting the remainder by predicted utility. On Habitat-Lab navigation with multi-agent context growth, E-RECAP reduces tokens per replanning call by 71–76% and replanning latency by 2.1–2.6×\\times with minimal changes in success and success weighted by path length.
#### Motivating example: tail latency and SLO violations.
In Meta Habitat navigation with shortest-path-noise execution and a replanning SLO of 2500 ms, No BRACE violates the SLO on 85.5% of replanning calls despite 100% success (Table [2](https://arxiv.org/html/2608.01428#S4.T2 "Table 2 ‣ 4.3 Results ‣ 4 Experiments ‣ When Replanning Becomes the Bottleneck:Budgeted Replanning for Embodied Agents")).
