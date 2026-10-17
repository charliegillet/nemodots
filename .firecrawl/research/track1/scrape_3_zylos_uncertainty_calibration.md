[![Zylos Logo](https://zylos.ai/zylos-logo.png)Zylos](https://zylos.ai/) [Features](https://zylos.ai/#features) [Research](https://zylos.ai/research/) [Docs](https://zylos.ai/docs/)

EN [中](https://zylos.ai/zh/research/2026-04-18-llm-calibration-uncertainty-production-agents/)

[![Coco](https://zylos.ai/coco-logo.png)](https://coco.xyz/)

[Back to Notes](https://zylos.ai/research/)

2026-04-18

# LLM Calibration and Uncertainty Quantification in Production AI Agents

uncertaintycalibrationagentsproductionsafetyreliability

## Executive Summary

Large language models deployed as autonomous agents face a fundamental reliability problem: they are simultaneously powerful reasoners and poor judges of their own limitations. Alignment training — particularly RLHF — systematically degrades calibration, rewarding confident-sounding answers whether or not the model actually knows the answer. As agents take longer chains of action and operate with greater autonomy, a miscalibrated confidence signal becomes more than an inconvenience: it becomes a root cause of cascading failures. This article examines the state of the art in LLM calibration research through early 2026, covering the mechanisms behind overconfidence, the emerging toolkit of uncertainty quantification methods, and the design patterns that production teams are using to build agents that act on uncertainty appropriately — deferring, clarifying, or abstaining rather than hallucinating forward.

* * *

## The Calibration Deficit in Aligned Models

Well-calibrated probabilistic predictions are a foundational requirement for trustworthy decision-making systems. A calibrated model is one where a stated 80% confidence corresponds, empirically, to being correct 80% of the time. Pre-trained language models, somewhat surprisingly, tend to exhibit reasonable calibration when measured via token-level log-probabilities on factual questions. The problem begins at alignment.

Research presented at ICML 2025 in "Restoring Calibration for Aligned Large Language Models: A Calibration-Aware Fine-Tuning Approach" documents the mechanism clearly. RLHF training introduces preference collapse: the model learns that confident-sounding completions score higher on reward models regardless of whether the underlying claim is accurate. The reward model itself is biased toward high-confidence scores. The result is that verbalized confidence — when a model says "I'm certain that..." — becomes decoupled from actual epistemic state. A February 2025 empirical study, "Mind the Confidence Gap," finds that large RLHF-tuned models primarily emit verbalized confidence scores between 80% and 100%, with ECE (Expected Calibration Error) values that can reach 0.30 or higher on knowledge-intensive tasks — meaning the model's stated confidence overshoots reality by 30 percentage points.

An even more pointed framing comes from "The Dunning-Kruger Effect in Large Language Models" (arXiv:2603.09985), which argues that RLHF-trained models replicate the human cognitive bias of overconfidence in areas of genuine ignorance while being more accurately calibrated in domains of strong pre-training coverage. The miscalibration is not uniform; it concentrates precisely where it is most dangerous — at the knowledge boundary.

OpenAI's September 2025 investigation into LLM hallucinations identified a structural contributor: next-token training objectives and standard accuracy-focused benchmarks reward confident guessing over calibrated uncertainty. A model that says "I don't know" on 20% of questions while being right 95% on the remainder will score lower on standard accuracy metrics than a model that guesses on all questions and hits 80%. This creates a systematic selection pressure against epistemic humility throughout the entire model training and evaluation pipeline.

* * *

## A Taxonomy of Uncertainty in Agents

Before examining solutions, it is important to distinguish the types of uncertainty that arise in agentic settings. Classical machine learning distinguishes two forms: aleatoric uncertainty (irreducible randomness in the data) and epistemic uncertainty (lack of knowledge that could in principle be reduced with more data or computation). A position paper accepted at ICML 2025, "Uncertainty Quantification Needs Reassessment for Large Language Model Agents," argues compellingly that this binary is insufficient for interactive, open-ended agents.

The paper identifies several additional categories relevant to deployed agents:

**Underspecification uncertainty**: The user's request does not fully specify the intended behavior. The model can produce a valid output under multiple interpretations. In single-turn QA this is handled by picking the most probable interpretation; in long-horizon agentic tasks, the wrong interpretation compounds over many steps.

**Interaction uncertainty**: Agents operate in dynamic environments — web pages change, APIs return unexpected data, tool calls fail. Uncertainty is not just over internal knowledge but over the state of the world the agent is interacting with.

**Temporal uncertainty**: Knowledge has a freshness date. An agent's factual confidence about a domain should decay as a function of how rapidly that domain changes and how old the training data is.

**Compounded trajectory uncertainty**: In sequential decision-making, individual step uncertainties combine. A 90% confident agent making 20 sequential decisions faces a trajectory reliability of only 0.9^20 ≈ 12% if all uncertainties are independent. In practice they are correlated, sometimes canceling but often amplifying.

The "Agentic Uncertainty Quantification" paper (arXiv:2601.15703, January 2026) from Salesforce Research captures this dynamic with the evocative phrase "Spiral of Hallucination": early epistemic errors, undetected by passive monitoring, propagate irreversibly through reasoning chains, each step building on a flawed premise. This is qualitatively different from the hallucination problem in chatbot settings, where a user can immediately correct a factual error.

* * *

## Measuring Uncertainty: The Technical Toolkit

The field has converged on four broad classes of uncertainty estimation methods for language models, each with different computational costs, accuracy, and applicability to production settings.

### Token-Level Methods

The simplest approach uses the model's own output probabilities. For a given generated sequence, uncertainty can be estimated from the entropy of the next-token distribution, the mean log-probability of generated tokens, or derived metrics like the predictive entropy of the full output. These methods are computationally free — the log-probabilities are computed as part of the forward pass — but they have significant limitations. Log-probability is a proxy for the model's internally represented uncertainty, not necessarily its epistemic state about the real world. A model that has learned to produce confident-sounding text will reflect that learned style in its token probabilities regardless of actual knowledge.

The Token-Entropy Conformal Prediction (TECP) approach, published in _Mathematics_ (2025), integrates token entropy with split conformal prediction to construct prediction sets with finite-sample coverage guarantees. This bridges the gap between raw probability signals and statistically rigorous uncertainty bounds.

### Semantic Uncertainty Methods

A significant advance came with Semantic Entropy (SE), published in _Nature_ in 2024 and widely adopted through 2025. SE generates multiple samples from the model, clusters them by semantic meaning (using an entailment model to determine whether two outputs express the same claim), and computes entropy over the distribution of semantic clusters rather than surface-level token sequences. This sidesteps the problem of surface-level variation masking semantic agreement — if the model consistently generates semantically equivalent but lexically varied answers, SE correctly reports low uncertainty.

The LM-Polygraph benchmark (published in _Transactions of the ACL_, March 2025) is the first comprehensive empirical comparison of over a dozen UQ methods across eleven text generation tasks. Its findings establish SE as "the gold standard for fact-based tasks" while noting its unsuitability for instruction-following, where semantic equivalence is harder to define. The benchmark also identifies Shifting Attention to Relevance (SAR), an SE extension using soft semantic similarity aggregation, as "consistently one of the most effective methods for both short and long outputs."

For longer generations, "Beyond Semantic Entropy" (ACL Findings 2025) identifies a degradation in standard SE: it assumes independence between clusters but this breaks down when responses are long and inter-cluster similarity matters. The paper proposes pairwise semantic similarity estimates of entropy, achieving better calibration on summarization and translation tasks.

### Conformal Prediction Approaches

Conformal prediction (CP) provides a model-agnostic framework for constructing prediction sets with guaranteed coverage probabilities under minimal assumptions (exchangeability of the calibration data). Applied to language models, CP can construct sets of plausible answers such that the true answer is contained with a specified probability — say, 95% — regardless of the underlying model.

Several CP variants for LLMs have been published in 2025. Selective Conformal Uncertainty (SConU, ACL 2025) uses conformal p-values to determine whether a given sample falls within the model's calibrated uncertainty distribution. Adaptive Conformal Prediction for Factuality (arXiv:2604.13991) improves on marginal coverage guarantees by enabling prompt-dependent calibration via conditional quantile regression. The appeal of CP for production is that it provides interpretable, statistically meaningful uncertainty bounds rather than raw scores — an agent can report "I am 95% confident the answer is in this set" with a guarantee that holds empirically.

### Mechanistic Interpretability Methods

The most recent frontier involves probing the model's internal representations directly rather than relying on output distributions. Semantic Entropy Probes (SEPs) train linear classifiers on LLM hidden states to predict whether a given generation is likely to be a hallucination. Because they operate on internal activations rather than output tokens, they can in principle detect uncertainty that the model fails to verbalize. Semantic Energy (arXiv:2508.14496) proposes a related approach: rather than clustering outputs by semantic meaning, it estimates response uncertainty directly from logits to address cases where the model is uncertain but all samples agree on an incorrect answer.

* * *

## The Verbalization Gap: When Words Don't Match Internal State

A critical finding in recent research is that verbalized confidence — when a model explicitly states how confident it is — often diverges substantially from both token-level probabilities and actual accuracy. "Are LLM Decisions Faithful to Verbal Confidence?" (arXiv:2601.07767, January 2026) finds a critical limitation: while models can often accurately verbalize their uncertainty in isolation, they fail to use this information to guide their own decisions. A model might say "I'm not entirely sure about this" and then proceed to take an irreversible action as if fully certain.

A February 2025 study in the _International Journal of Human-Computer Studies_ examined the downstream effect on users: medium verbalized uncertainty consistently led to higher user trust, satisfaction, and task performance compared to both high and low verbalized uncertainty. This has important implications for agent design — users do not benefit from either false certainty or reflexive hedging. Calibrated communication of uncertainty ("I'm fairly confident this is correct, but you may want to verify the specific date") produces better human-AI collaboration outcomes than either extreme.

The practical implication is that verbalized confidence cannot be used as a reliable internal control signal. An agent that checks its own verbalized confidence and makes a decision based on it is operating on a noisy, potentially biased proxy. The more reliable signal for internal use is the semantic entropy or conformal bounds computed from actual generations — but these require significant compute investment, discussed below.

* * *

## Training-Time Solutions

If miscalibration is introduced during alignment, the most principled fix is to correct it during training. Three approaches have gained significant traction through 2025-2026.

### Calibration-Aware Fine-Tuning (CFT)

The ICML 2025 paper introduces CFT as a modification of the fine-tuning objective that explicitly preserves calibration properties alongside optimizing for helpfulness. The key insight is that the tradeoff between alignment and calibration is not fundamental — it is an artifact of current training procedures that ignore calibration in the loss function. By adding a calibration regularization term, CFT dramatically reduces ECE while maintaining or improving accuracy. The paper categorizes models into "calibratable" and "non-calibratable" regimes defined by ECE bounds, providing a theoretical foundation for understanding when training-time calibration fixes are possible.

### Reward Calibration in RLHF

"Taming Overconfidence in LLMs: Reward Calibration in RLHF" (arXiv:2410.09724) addresses the root cause directly by modifying the PPO training procedure. It proposes two variants: PPO-M (with calibrated reward modeling) and PPO-C (with calibrated reward calculation), both designed to prevent the reward model from systematically favoring high-confidence outputs. The result is an alignment procedure that preserves the model's epistemic humility while still producing helpful, preference-aligned responses.

### Behaviorally Calibrated Reinforcement Learning

"Mitigating LLM Hallucination via Behaviorally Calibrated Reinforcement Learning" (arXiv:2512.19920) takes a different approach: rather than modifying the reward model, it trains the model to stochastically abstain when uncertain, using calibration as an explicit RL objective. The model learns that admitting uncertainty is rewarded when the model is genuinely uncertain, breaking the incentive to always answer confidently.

* * *

## Inference-Time Techniques: Abstention, Deferral, and Confidence Gating

For deployed systems where retraining is not practical, the field has developed a toolkit of inference-time mechanisms that can layer calibration behavior onto existing models.

### Abstention as a Core Safety Mechanism

"Know Your Limits: A Survey of Abstention in Large Language Models" (published in _Transactions of the ACL_, 2025) provides the most comprehensive treatment of the abstention literature. It organizes the field across five mechanism categories: reflective prompting, uncertainty quantification, selective prediction and abstention, retrieval-based verification, and confidence calibration. The survey documents the shift in community consensus: abstention — refusing to answer when confidence is below a threshold — is now widely recognized as a positive capability, not a failure mode.

The confidence-gating pattern implements abstention as follows: estimate the model's uncertainty using any of the methods above, compare it to a threshold τ, and withhold or flag the response if uncertainty exceeds τ. Experimental results cited in "Confidence-Based Response Abstinence" (arXiv:2510.13750) show that a well-tuned confidence model can achieve precision of 0.95 with a 70.1% display rate — meaning 29.9% of responses are masked rather than delivered, with the displayed responses being highly reliable.

I-CALM (arXiv:2604.03904, April 2026) presents an entirely prompt-based approach to incentivizing abstention in black-box settings. By framing the task with explicit reward schemes ("You receive +2 for a correct answer, -2 for an incorrect answer, and +0 for abstaining") combined with humility-oriented normative principles, I-CALM shifts answer/abstain behavior toward rational epistemic humility without any model modification. The work demonstrates that even black-box models have latent abstention capabilities that appropriate prompting can activate.

### Uncertainty-Aware Deferral

ReDAct: Uncertainty-Aware Deferral for LLM Agents (arXiv:2604.07036, April 2026) addresses a concrete production challenge: large models are more reliable but expensive; small models are cheap but hallucinate more. ReDAct equips an agent with both a small model and a large model, using the small model's uncertainty signal to decide when to defer to the large model. On ALFWorld and MiniGrid benchmarks, deferring only 15% of decisions to the large model is sufficient to match its full performance — at a fraction of the inference cost. This creates a practical, cost-optimized reliability architecture that production teams can deploy today.

### Agentic Uncertainty Quantification (AUQ)

The most architecturally sophisticated inference-time approach is the Dual-Process AUQ framework from Salesforce Research (arXiv:2601.15703). Inspired by Kahneman's dual-process theory of cognition, AUQ treats uncertainty as an active control signal rather than a passive metric. System 1 (Uncertainty-Aware Memory) propagates verbalized confidence and semantic explanations through the agent's memory, preventing downstream steps from making decisions blind to upstream uncertainty. System 2 (Uncertainty-Aware Reflection) uses accumulated uncertainty cues to trigger targeted recomputation only when uncertainty exceeds thresholds — not reflexively, but selectively.

The performance improvements are substantial: 74.3% success rate (+10.7 percentage points) on ALFWorld and 42.5% success rate (+13.6 percentage points) on WebShop, compared to baselines without AUQ. Critically, this is a training-free intervention — it works by modifying how the agent uses its existing uncertainty signals, not by retraining the underlying model.

* * *

## Calibration Benchmarks and Evaluation Infrastructure

The field is developing dedicated infrastructure for measuring calibration in production LLM systems. Expected Calibration Error (ECE) remains the standard metric: it measures the weighted average deviation between stated confidence and empirical accuracy across confidence buckets. However, ECE was designed for classification and requires adaptation for open-ended language generation.

Flex-ECE (Flexible Expected Calibration Error) is a 2025 adaptation that accounts for partial correctness — a model that gives a partially correct answer should receive partial calibration credit rather than the binary correct/incorrect treatment that standard ECE applies.

LM-Polygraph (TACL March 2025, GitHub: IINemo/lm-polygraph) provides the most complete evaluation harness: an open-source framework unifying over a dozen UQ and calibration algorithms, covering tasks from factual QA to summarization to machine translation. The paper's large-scale empirical investigation across eleven tasks provides actionable recommendations: for short outputs, SAR and SE outperform token-level methods; for longer outputs, sample diversity methods (SE, DegMat, Lexical Similarity) are preferable; temperature scaling remains the simplest and most effective post-hoc calibration fix.

"Uncertainty Quantification and Confidence Calibration in Large Language Models: A Survey" (KDD 2025) provides a taxonomy of the current methods and identifies the major open research challenges: no single metric captures all aspects of calibration, multi-metric evaluation is recommended, and no benchmark yet covers the full range of agent deployment scenarios including sequential decision-making under uncertainty.

The ICML 2025 position paper on UQ for LLM agents calls for a dedicated benchmark suite for agentic UQ — distinct from static QA benchmarks — that evaluates uncertainty estimation in interactive, long-horizon settings. As of early 2026, this benchmark does not yet exist in mature form, representing a significant gap between research and deployment needs.

* * *

## Production Patterns and Industry Adoption

Industry deployment of calibrated agents follows patterns that, while not always framed in academic calibration terminology, implement the same underlying mechanisms.

**Confidence-gated escalation** is the dominant pattern: when an agent's internal confidence falls below a threshold, it pauses and routes the case to a human owner rather than proceeding autonomously. Google Cloud's 2025 retrospective on agent deployment ("AI Grew Up and Got a Job") identifies this pattern as critical to building organizational trust in autonomous agents — humans can calibrate their trust in the agent by seeing, over time, that escalations are well-targeted rather than over-triggering.

**Tiered model routing** as implemented in ReDAct mirrors a pattern already in production at several organizations: a small, fast model handles routine cases where confidence is high, and a large, expensive model is reserved for cases where the small model signals uncertainty. This provides cost efficiency alongside reliability guarantees.

**Calibration as a quality dimension** alongside accuracy is gaining ground. A 2025 study on LLM calibration in biomedical research ( _bioRxiv_) documents that LLMs can achieve high classification accuracy (up to 100% on some tasks) while remaining severely miscalibrated, with ECE values as high as 0.427 — far exceeding acceptable thresholds. This argues for adding calibration metrics to model selection criteria alongside accuracy, particularly for high-stakes deployments.

Gartner projects that 40% of enterprise applications will embed AI agents by end of 2026. As agent deployments scale from prototypes to production pipelines touching consequential decisions — HR processes, customer service resolutions, code deployments — calibration will move from an academic concern to an operational requirement. Organizations that build calibration measurement and improvement into their agent infrastructure now will have a structural advantage as autonomous AI systems take on higher-stakes workloads.

* * *

## Design Principles for Calibrated Agents

Synthesizing the research, several actionable principles emerge for practitioners building production AI agents:

**Principle 1: Instrument uncertainty, don't assume it.** Token log-probabilities are available at zero cost. For fact-critical tasks, invest in semantic entropy estimation at inference time. Use LM-Polygraph or equivalent frameworks to establish a calibration baseline before deployment.

**Principle 2: Don't trust verbalized confidence as a control signal.** The decision-action gap documented in recent research means that a model saying "I'm not sure" does not reliably translate into appropriate cautious behavior. Build uncertainty gating at the infrastructure level rather than relying on the model's self-reported confidence to drive decisions.

**Principle 3: Design for graceful abstention.** Define the abstention policy explicitly: what questions should the agent refuse to answer autonomously? What confidence threshold triggers escalation? What is the fallback path? I-CALM shows that prompting strategies can shift behavior significantly; pair this with training-time calibration (CFT, reward calibration) for deeper fixes.

**Principle 4: Propagate uncertainty through multi-step chains.** AUQ's key contribution is treating uncertainty as a first-class memory object, not a per-step metric. In a multi-step agentic pipeline, uncertainty from step N should influence the confidence with which step N+1 interprets its inputs. This prevents the Spiral of Hallucination.

**Principle 5: Calibration is a product of the training pipeline, not just inference.** If your deployment involves fine-tuning base models on domain data, add calibration measurement to your fine-tuning evaluation suite. CFT and reward calibration techniques are now available to apply during RLHF — use them proactively rather than discovering miscalibration after deployment.

**Principle 6: Match uncertainty communication to the human context.** The verbalization research shows that medium-expressed uncertainty — specific hedging rather than confident assertion or reflexive "I don't know" — produces the best human-AI collaboration outcomes. Design agent response templates that communicate calibrated uncertainty in user-appropriate language.

* * *

## The Road Ahead

Several open problems remain active research areas as of early 2026:

The **agentic benchmark gap** is the most pressing: evaluations of calibration in sequential, interactive settings remain largely absent. Static QA calibration metrics do not transfer to multi-step agents operating in dynamic environments. The community needs benchmarks that measure trajectory-level calibration — not just whether individual answers are calibrated, but whether an agent's evolving confidence tracks its actual success rate over long horizons.

**Underspecification uncertainty** remains under-theorized. Current methods focus on factual uncertainty (does the model know the answer?) but not interpretive uncertainty (is the model solving the right problem?). As agents handle more complex, open-ended tasks, the latter becomes increasingly important.

**The cost-reliability tradeoff** at scale will shape adoption patterns. Semantic entropy requires multiple model generations and an entailment model, multiplying inference costs. Conformal prediction requires calibration data collection. For teams deploying agents at scale, there is significant pressure toward token-level methods that are cheap but less accurate. Research that improves the cost-accuracy frontier — as SEPs and Semantic Energy attempt — will have high practical impact.

The field is converging on a clear architectural principle: uncertainty is not a diagnostic to monitor after the fact, but a runtime signal to act on in real time. The agent systems that perform reliably over long horizons will be those that treat uncertainty as a first-class runtime value — something to propagate, reason about, and act on — rather than a byproduct of computation to be logged and ignored.

* * *

## References

01. Wang et al., "Restoring Calibration for Aligned Large Language Models: A Calibration-Aware Fine-Tuning Approach," ICML 2025. [https://arxiv.org/abs/2505.01997](https://arxiv.org/abs/2505.01997)

02. Leng et al., "Taming Overconfidence in LLMs: Reward Calibration in RLHF," arXiv:2410.09724. [https://arxiv.org/abs/2410.09724](https://arxiv.org/abs/2410.09724)

03. "Mind the Confidence Gap: Overconfidence, Calibration, and Distractor Effects in Large Language Models," arXiv:2502.11028. [https://arxiv.org/html/2502.11028](https://arxiv.org/html/2502.11028)

04. "The Dunning-Kruger Effect in Large Language Models: An Empirical Study of Confidence Calibration," arXiv:2603.09985. [https://arxiv.org/html/2603.09985v1](https://arxiv.org/html/2603.09985v1)

05. Zhang et al., "Agentic Uncertainty Quantification," arXiv:2601.15703. [https://arxiv.org/abs/2601.15703](https://arxiv.org/abs/2601.15703)

06. "Uncertainty Quantification in LLM Agents: Foundations, Emerging Challenges, and Opportunities," arXiv:2602.05073. [https://arxiv.org/html/2602.05073v2](https://arxiv.org/html/2602.05073v2)

07. "Position: Uncertainty Quantification Needs Reassessment for Large Language Model Agents," ICML 2025. [https://arxiv.org/abs/2505.22655](https://arxiv.org/abs/2505.22655)

08. Fadeeva et al., "Benchmarking Uncertainty Quantification Methods for Large Language Models with LM-Polygraph," TACL Vol. 13, March 2025. [https://direct.mit.edu/tacl/article/doi/10.1162/tacl\_a\_00737/128713](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00737/128713)

09. Farquhar et al., "Detecting hallucinations in large language models using semantic entropy," _Nature_, 2024\. [https://www.nature.com/articles/s41586-024-07421-0](https://www.nature.com/articles/s41586-024-07421-0)

10. "Beyond Semantic Entropy: Boosting LLM Uncertainty Quantification with Pairwise Semantic Similarity," ACL Findings 2025. [https://aclanthology.org/2025.findings-acl.234](https://aclanthology.org/2025.findings-acl.234)

11. "I-CALM: Incentivizing Confidence-Aware Abstention for LLM Hallucination Mitigation," arXiv:2604.03904. [https://arxiv.org/abs/2604.03904](https://arxiv.org/abs/2604.03904)

12. "ReDAct: Uncertainty-Aware Deferral for LLM Agents," arXiv:2604.07036. [https://arxiv.org/abs/2604.07036](https://arxiv.org/abs/2604.07036)

13. "Know Your Limits: A Survey of Abstention in Large Language Models," TACL 2025. [https://direct.mit.edu/tacl/article/doi/10.1162/tacl\_a\_00754/131566](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00754/131566)

14. "Confidence-Based Response Abstinence: Improving LLM Trustworthiness via Activation-Based Uncertainty Estimation," arXiv:2510.13750. [https://arxiv.org/html/2510.13750](https://arxiv.org/html/2510.13750)

15. "Mitigating LLM Hallucination via Behaviorally Calibrated Reinforcement Learning," arXiv:2512.19920. [https://arxiv.org/abs/2512.19920](https://arxiv.org/abs/2512.19920)

16. "Are LLM Decisions Faithful to Verbal Confidence?" arXiv:2601.07767. [https://arxiv.org/html/2601.07767](https://arxiv.org/html/2601.07767)

17. "Confronting verbalized uncertainty: Understanding how LLM's verbalized uncertainty influences users in AI-assisted decision-making," _International Journal of Human-Computer Studies_, February 2025. [https://www.sciencedirect.com/science/article/pii/S1071581925000126](https://www.sciencedirect.com/science/article/pii/S1071581925000126)

18. "Selective Conformal Uncertainty in Large Language Models," ACL 2025. [https://aclanthology.org/2025.acl-long.934](https://aclanthology.org/2025.acl-long.934)

19. "Adaptive Conformal Prediction for Improving Factuality of Generations by Large Language Models," arXiv:2604.13991. [https://arxiv.org/abs/2604.13991](https://arxiv.org/abs/2604.13991)

20. "A Study of Calibration as a Measurement of Trustworthiness of Large Language Models in Biomedical Research," _bioRxiv_, February 2025. [https://www.biorxiv.org/content/10.1101/2025.02.11.637373v1](https://www.biorxiv.org/content/10.1101/2025.02.11.637373v1)