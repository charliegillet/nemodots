# STEVE: Stabilizing Textual Gradient-Based Prompt Optimization via Error-Driven Refinement and Regularized Verification

Paper ID: 7036969638604713515
IDs: arxiv:2609.23716
Authors: Yifan Xu; Yixuan Li; Xinzhuo Li; Yixin Gu; Yifan Shen; Lijun Yu; Haohan Wang
Categories: cs.CL, cs.AI, cs.LG
Dates: created 2026-09-20; updated 2026-09-22

## Abstract
Textual-gradient methods automate prompt optimization through natural-language feedback, but their iterative updates can be unstable. We identify two sources of this instability: noisy gradients produced from already-correct examples and over-specialization to hard cases that degrades performance on simpler inputs. We introduce STEVE, a stabilization framework with two coupled mechanisms. Error-Driven Refinement generates gradients only from incorrectly handled examples, concentrating updates on informative failures. Regularized Verification treats every update as provisional and accepts it only when improvement on hard cases does not cause unacceptable regression on a preservation set. Across ten reasoning benchmarks, three evaluator/optimizer models, and established prompt-optimization baselines, STEVE reduces degradation and produces more robust prompts. Additional evaluations with gpt-5.4-mini/gpt-5.4 on symbolic reasoning, GSM8K-Platinum, and DS-1000 show that these gains persist with newer models and larger test sets. STEVE therefore provides a practical way to improve the stability and effectiveness of textual-gradient prompt optimization.