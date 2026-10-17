# Prompt Optimization Is a Coin Flip: Diagnosing When It Helps in Compound AI Systems

Paper ID: 790271246201660936
IDs: arxiv:2604.14585
Authors: Xing Zhang; Guanghui Wang; Yanwei Cui; Wei Qiu; Ziyuan Li; Bing Zhu; Peiyang He
Categories: cs.AI, cs.CL
Dates: created Thu, 16 Apr 2026 03:23:46 GMT; updated 2026-05-28

## Abstract
Prompt optimization in compound AI systems is statistically indistinguishable from a coin flip: across 72 optimization runs on Claude Haiku 4.5 (6 methods × 4 tasks × 3 repeats), 49% score below zero-shot; on Amazon Nova Lite, the failure rate is even higher. Yet on one task, all six methods improve over zero-shot by up to +6.8 points. What distinguishes success from failure? We investigate with 18,000 grid evaluations and 144 optimization runs, testing two assumptions behind end-to-end optimization tools like TextGrad and DSPy, in the order they must be answered: (A) agent prompts interact, requiring joint rather than independent optimization, and (B) individual prompts are worth optimizing at all. Interaction effects are never significant (p > 0.52, all F < 1.0), and optimization helps only when the task has exploitable output structure: a format the model can produce but does not default to. We further give a mechanistic account: instruction-tuning compresses input phrasing into a narrow output distribution, eliminating the very phrasing-sensitivity that joint optimization assumes. We provide a two-stage diagnostic: an $80 ANOVA pre-test for agent coupling, and a 10-minute headroom test that predicts whether optimization is worthwhile, turning a coin flip into an informed decision.