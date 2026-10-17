[![o-mega Text Logo](https://o-mega.ai/_next/image?url=%2Fimages%2Fo-mega_text_logo_dark.png&w=3840&q=75)](https://o-mega.ai/)

[Get started](https://o-mega.ai/founden/start)

[Home](https://o-mega.ai/) [Blog](https://o-mega.ai/articles) [Plans](https://o-mega.ai/plans) [Sign In](https://o-mega.ai/app/build) [Get Started](https://o-mega.ai/founden/start)

[Back to articles](https://o-mega.ai/articles)

Articles

# Self-Improving AI Agents: The 2026 Guide

Discover how self-improving AI agents that rewrite code and evolve strategies are shifting from research labs to production revenue drivers in 2026.

AI AgentsSelf-Improving AIAutonomous SystemsAI in ProductionFuture of AI

![O-mega Team](https://o-mega.ai/_next/image?url=%2Fimages%2Fo-mega_orb_icon.png&w=96&q=75)

O-mega Team

26 March 2026

•

46 min read

**The definitive guide to AI agents that rewrite their own code, evolve their own strategies, and improve at improving. Covering HyperAgents, AlphaEvolve, SWE-RL, and every major self-improvement paradigm shipping in 2026.**

A research team at Meta, the University of British Columbia, Oxford, and NYU published a paper on March 19, 2026, that quietly crossed a threshold the AI safety community has been watching for years. Their system, called [HyperAgents](https://arxiv.org/abs/2603.19461), transferred self-improvement strategies learned in one domain (robotics, paper review) to a completely novel domain (Olympiad math grading) and scored **imp@50 = 0.630**. Hand-designed systems built by human experts for that same task scored **0.0**. Complete failure. The machine that learned how to learn beat the humans who tried to engineer learning by hand.

This is not a story about a better prompt or a fancier framework. It is a story about what happens when AI agents stop being static tools and start getting better at getting better. The research community calls this **metacognitive self-improvement**: agents that modify not just their task behavior, but their own modification process. And it is happening faster than most practitioners realize.

[METR](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/), the organization that benchmarks AI agent capabilities over time, found that the length of tasks AI agents can complete autonomously has been **doubling every 7 months** for six years (R-squared = 0.98). In 2024-2025, that rate [accelerated to every 4 months](https://metr.org/blog/2026-1-29-time-horizon-1-1/). On METR's [current published dataset](https://metr.org/time-horizons/), the doubling time since 2023 is **128.7 days** and the best-measured system, the Claude Mythos preview, holds a 50% reliability time horizon of **1,044 minutes**, roughly **17 hours**. In February 2025 the frontier sat at 60 minutes. The curve is not flattening.

This guide covers exactly what HyperAgents does, why it matters, and maps the full ecosystem of self-improving agent research shipping in 2026. We cover the evolutionary approaches (AlphaEvolve, ShinkaEvolve), the reinforcement learning methods (SWE-RL, SAGE), the memory systems that make persistent learning possible (Mem0, MemOS, SimpleMem), and the production deployments where self-improvement is already generating revenue (Meta REA, Cognition/Devin, Karpathy's autoresearch loop). We also address the safety question that looms over all of this: what happens when the improvement loop closes without a human in it?

## Contents

1. Why Self-Improvement Is the Only Thing That Matters
2. HyperAgents: The Paper That Changes the Game
3. The Lineage (ADAS to DGM to HyperAgents)
4. The Self-Improving Agent Landscape
5. Memory Is the Bottleneck
6. Measuring Self-Improvement
7. Production Self-Improvement: Who Is Actually Doing This
8. The Safety Question
9. What Comes Next

* * *

## 1\. Why Self-Improvement Is the Only Thing That Matters

The AI agent landscape in early 2026 is crowded with frameworks, orchestration layers, and workflow builders. Most of them solve the same problem: how to give an LLM access to tools and let it execute multi-step tasks. That problem is largely solved. The unsolved problem, the one that separates research curiosity from real economic value, is whether an agent can get better at its job without a human redesigning it.

A position paper from the University of Cambridge, presented at [ICML 2025](https://arxiv.org/abs/2506.05109), formalized this distinction. Tennison Liu and colleagues from Mihaela van der Schaar's group argued that truly self-improving agents require **intrinsic metacognitive learning**: the ability to assess their own performance, plan what to learn next, and evaluate whether the learning worked. The paper identified three specific capabilities that current agents lack: metacognitive knowledge (accurate self-assessment), metacognitive planning (deciding what and how to learn), and metacognitive evaluation (reflecting on whether learning was effective). Current agents, they argued, rely on "extrinsic" metacognition, meaning fixed, human-designed loops that tell the agent when and how to reflect. Those loops do not scale.

This matters because the economic logic of AI agents depends entirely on compounding improvement. A static agent that performs at a fixed level is a tool. An agent that gets **1% better per week** at its core task is a growing asset. After a year, that agent is roughly **68% better** than when it started. After two years, it is nearly **three times better**. The mathematics of compounding turns a marginal advantage into a decisive one, but only if the improvement loop actually works.

The catch is that self-improvement has a hard constraint that most practitioners underestimate. A [detailed analysis](https://medium.com/@alcarazanthony1/ai-self-improvement-only-works-where-outcomes-are-verifiable-b37981db169a) published in early 2026 identified what researchers call the **verifiability constraint**: AI self-improvement only works reliably in domains where outcomes are objectively verifiable. Code either compiles or it does not. A math proof is either valid or invalid. An optimized algorithm either runs faster or it does not. In these domains, an agent can generate a candidate improvement, evaluate it against a clear metric, and keep the change if it works. But in domains like marketing copy, strategic planning, or relationship management, there is no clean signal for "better." Without that signal, self-improving systems tend to hack their reward functions, optimize for proxy metrics that diverge from actual quality, or simply oscillate without meaningful progress.

This constraint explains why the most impressive self-improvement results so far have all come from coding and mathematics. It also explains why the HyperAgents result on cross-domain transfer is so significant: it suggests a path around the constraint.

The practical impact is already visible in how leading companies approach agent deployment. Static agents are cheap to build and easy to reason about, but they hit a ceiling quickly. An agent that books meetings at 80% accuracy on day one will still book meetings at 80% accuracy on day three hundred. A self-improving agent that starts at 70% but gains a point per week will overtake the static agent within ten weeks and keep pulling ahead. The compounding effect transforms the unit economics of AI deployment. This is why [Accenture reported](https://www.accenture.com/) that one-third of large enterprises already deploy AI agents, and why [IDC](https://www.idc.com/) projects that agent use among the Global 2000 will increase **10x by 2027** with token volumes spiking **1,000x**.

The distinction between "agent that does tasks" and "agent that gets better at doing tasks" is the central divide in the field right now. Every system described in this guide exists on one side or the other of that line.

* * *

## 2\. HyperAgents: The Paper That Changes the Game

The [HyperAgents paper](https://arxiv.org/abs/2603.19461) (arXiv: 2603.19461) was submitted on March 19, 2026, by eight researchers across six institutions. The co-first authors are [Jenny Zhang](https://www.jennyzhangzt.com/) (UBC, Vector Institute, Meta), Bingchen Zhao (University of Edinburgh), and Wannan Yang (NYU). Senior authors include Jakob Foerster (Oxford), Jeff Clune (UBC, Vector Institute, Meta), Minqi Jiang (Meta), Sam Devlin (Meta), and Tatiana Shavrina (Meta). The paper received significant attention within its first week: **4,262 likes** on Jenny Zhang's announcement, **119 upvotes** on alphaXiv with **2,771 visits**, and the [GitHub repository](https://github.com/facebookresearch/Hyperagents) accumulated roughly **1,000 stars** and **151 forks**.

### What a HyperAgent Actually Is

A HyperAgent is a single Python program that contains two functions sharing a single editable codebase. The first function, `solve_task()`, handles whatever domain task the agent is supposed to perform: writing code, reviewing papers, designing reward functions for robots. The second function, `modify_self()`, analyzes the agent's performance and proposes code modifications to improve it. The critical innovation is that `modify_self()` can modify itself. It is part of the same codebase it is editing.

This is the difference between a thermostat and an engineer. A thermostat adjusts temperature based on fixed rules. An engineer can change the rules themselves, and can also change the process by which they evaluate and change rules. HyperAgents operate at that second level of self-reference. The technical term is **metacognitive self-modification**.

The system uses Claude Sonnet as a frozen foundation model. Its weights are never updated. All improvement happens through discrete code modifications: the LLM reads the current agent's source code, reads performance data, and proposes a Python edit. If the edit passes evaluation, it is kept. This means every improvement is **human-readable**, **persistent** (encoded in code, not weights), and **transferable** (the improved code can be shared across domains).

### How DGM-H Works

HyperAgents extends the [Darwin Godel Machine](https://arxiv.org/abs/2505.22954) framework (DGM) with a key upgrade: the meta-level process is itself editable. The algorithm, called DGM-H, works as follows:

The system maintains an archive of hyperagent programs. At each iteration, it selects parent agents from the archive using a probability distribution that favors high-performing, less-explored agents. Selected parents run their `modify_self()` function, which proposes code edits to both the task agent and the meta agent. Modified agents are evaluated on domain tasks. Successful agents are added to the archive, and the process repeats. The archive grows over time, maintaining diversity through population-based search.

The parent selection mechanism biases toward agents that perform well but have fewer successful descendants, encouraging exploration of underexplored branches in the search tree. This is the same principle that makes [Monte Carlo Tree Search](https://en.wikipedia.org/wiki/Monte_Carlo_tree_search) effective: balance exploitation of known good solutions with exploration of unknown territory.

### The Results

The paper evaluated DGM-H across four deliberately diverse domains:

**Polyglot coding** produced training accuracy of **0.340** and test accuracy of **0.267**, up from an initial 0.140/0.084. This matches the performance of the original DGM, which was specifically handcrafted for coding. DGM-H achieves the same result without domain-specific engineering.

**Scientific paper review** reached test accuracy of **0.710** (confidence interval: 0.590-0.750), compared to an initial score of 0.0. The [AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2) baseline scored **0.63** on the same task. DGM-H surpassed it without being designed for this domain.

**Robotics reward design** improved from an initial **0.060** to **0.372** (CI: 0.355-0.436). The system discovered complex robotic behaviors (including jumping) that human-designed reward functions could not produce.

**Olympiad math grading (transfer task)** is the most striking result. DGM-H agents that had previously been trained only on paper review and robotics were transferred to grade Olympiad math solutions with no additional domain-specific customization. They achieved **imp@50 = 0.630**. Human-customized DGM systems, built specifically for this task, scored **0.0**. The meta-level improvements acquired in other domains (better memory management, performance tracking, prompt templates) transferred to a novel domain where hand-designed approaches failed entirely.

### What the System Invented on Its Own

Perhaps the most fascinating finding is what emerged without being explicitly programmed. Over the course of its self-improvement runs, DGM-H autonomously developed:

Persistent memory infrastructure for tracking what worked across iterations. Performance logging and evaluation result analytics. Reusable prompt template systems. Bias detection utilities for catching systematic errors. Compute-aware exploration strategies that learned to allocate resources efficiently. Self-diagnosis capabilities for identifying failure modes. In the paper review domain specifically, the system invented JSON-based structured data storage, claim verification routines, and a two-stage review process. In robotics, it rediscovered curriculum learning (starting with easy tasks and progressing to harder ones) and anti-gaming penalties to prevent reward hacking.

One particularly notable emergent behavior: the system autonomously rediscovered the [Upper Confidence Bound](https://en.wikipedia.org/wiki/Multi-armed_bandit#Upper_confidence_bounds) (UCB) algorithm for balancing exploration and exploitation. UCB is a well-established solution to the multi-armed bandit problem in reinforcement learning. The fact that a self-modifying agent independently converged on the same solution that human researchers developed over decades of work says something important about the structure of the problem space.

### The Ablation Studies Tell the Story

The paper includes ablation studies that confirm both metacognition and open-ended exploration are necessary. Neither alone is sufficient. When the researchers fixed the meta agent (preventing it from modifying itself), improvement stagnated. The system could still improve its task performance to some extent, but without meta-level adaptation, the improvement rate plateaued quickly. The improvements it could find were limited to the strategies its initial, human-designed meta agent was capable of discovering.

When the researchers removed the archive (eliminating population-based search and using only a single lineage of agents), progress was similarly minimal. Without diversity in the population, the system converged to local optima. It found one decent approach and then made minor variations around it rather than exploring fundamentally different strategies. This is the same problem that plagues gradient descent in deep learning: without mechanisms for maintaining diversity, optimization gets stuck in the nearest local minimum rather than finding the global one.

The full DGM-H system, with both metacognitive self-modification and population-based search, produced continuous improvement across all four domains. Static agents (no modification at all) were consistently outperformed. The takeaway for practitioners is clear: self-improvement systems need both the ability to modify their approach AND a mechanism for exploring diverse approaches. Either component alone is insufficient. This has direct implications for how organizations design their agent improvement loops. A system that only tweaks prompts (no exploration) or only generates random variations (no metacognition) will hit a ceiling that a combined approach would blow past.

### The Honest Limitations

The paper is transparent about several important caveats. First, the foundation model (Claude Sonnet) is frozen. Its weights never change. All "learning" happens in the code and prompts wrapping the model. One [independent analyst](https://atalupadhyay.wordpress.com/2026/03/25/hyper-agents-self-improving-ai/) characterized this as "guided program synthesis via LLM-oracle search" rather than true evolving intelligence. The mutations are not random; they are biased by the foundation model's pre-training on millions of code repositories. This is fundamentally different from biological evolution's random mutation, even though the paper invokes Darwinian metaphors.

Second, the parent selection and evaluation machinery are largely fixed. While the meta agent can modify itself, the criteria for selecting which agents to improve and how to evaluate their performance were not fully opened to modification in the main experiments. Third, there is a real risk of [Goodhart's Law](https://en.wikipedia.org/wiki/Goodhart%27s_law): when the system optimizes hard enough against a proxy metric, it may game the evaluation rather than genuinely improve. The authors acknowledge this and note that all experiments were sandboxed with explicit oversight and resource constraints.

* * *

## 3\. The Lineage: ADAS to DGM to HyperAgents

HyperAgents did not appear in isolation. It is the third paper in a deliberate research arc led by Jeff Clune's group at UBC and the Vector Institute, with deep collaboration at Meta. Understanding the lineage reveals the specific human-engineered bottleneck each paper removed.

### ADAS: Automated Design of Agentic Systems (2024)

The [first paper](https://arxiv.org/abs/2408.08435), published in August 2024 and accepted at ICLR 2025, introduced the concept of **Automated Design of Agentic Systems** (ADAS). The core algorithm, Meta Agent Search, uses a "meta" agent to iteratively design new agents by writing Python code. The meta agent maintains an archive of discovered agents, evaluates each one, and generates variations. [Shengran Hu](https://www.shengranhu.com/ADAS/), Cong Lu, and Jeff Clune showed that automatically discovered agents outperformed hand-designed baselines by **+13.6 F1** on the DROP reasoning benchmark and **+14.4% accuracy** on MGSM math tasks. Discovered agents also transferred across different foundation models and domains.

The bottleneck ADAS did not address: the meta agent itself was fixed. A human wrote the meta agent's logic, and it never improved. If the meta agent had a blind spot in how it designed agents, that blind spot persisted forever.

### Darwin Godel Machine: Open-Ended Self-Improvement (2025)

The [second paper](https://arxiv.org/abs/2505.22954), published in May 2025 and accepted at ICLR 2026, addressed that bottleneck. The Darwin Godel Machine allowed the agent to modify its own code, including the code responsible for proposing modifications. Jenny Zhang, Shengran Hu, Cong Lu, Robert Lange (Sakana AI), and Jeff Clune applied open-ended evolutionary principles: maintaining a growing archive of agents, selecting parents based on quality and diversity, and allowing unbounded exploration. The results were dramatic. On [SWE-bench](https://www.swebench.com/), performance improved from **20.0% to 50.0%**. On the Polyglot coding benchmark, it went from **14.2% to 30.7%**. The system autonomously discovered better code editing tools, long-context window management strategies, and peer-review mechanisms for validating its own outputs.

The bottleneck DGM did not address: self-improvement only worked well in domains where the task (coding) aligned with the modification substrate (also coding). Improving at coding made the agent better at modifying its own code, creating a natural feedback loop. But in non-coding domains, there was no such alignment. Getting better at reviewing papers did not automatically make the agent better at modifying its paper-review code.

### HyperAgents: The Meta-Level Becomes Self-Modifiable (2026)

HyperAgents removes this final bottleneck by making the meta-level process itself editable. Instead of relying on domain alignment for improvement transfer, the system develops meta-level skills (memory management, prompt engineering, performance tracking, exploration strategies) that are domain-general. These skills compound across domains and transfer to novel tasks.

The progression is clean: ADAS showed that agents can design agents. DGM showed that agents can improve themselves. HyperAgents shows that agents can improve how they improve themselves.

What makes this lineage particularly significant is that each paper came from the same core group. Jeff Clune has been building toward this for years, with a research program that methodically removed one human-engineered bottleneck per paper. This is not a collection of disconnected results; it is a deliberate, multi-year research agenda. The group's next logical step would be to relax the constraints that HyperAgents still maintains: fixed evaluation criteria, frozen foundation model weights, and sandboxed execution. Whether and how quickly they take that step has significant implications for both capability and safety.

Jenny Zhang's broader research trajectory reinforces this. Her publications span Quality-Diversity through AI/Human Feedback (ICLR 2024, ICML 2024), [OMNI](https://arxiv.org/abs/2305.13417) (ICLR 2024) on open-ended learning, and OMNI-EPIC (ICLR 2025) on open-ended evaluation. Each paper addresses a different piece of the open-ended self-improvement puzzle. HyperAgents is the synthesis.

* * *

## 4\. The Self-Improving Agent Landscape

HyperAgents is the most theoretically ambitious entry in a rapidly growing field. But it is far from the only approach to self-improving agents in 2026. The landscape breaks into several distinct paradigms, each with different trade-offs between generality, sample efficiency, and practical deployability.

### The Reflection Foundations

Before diving into the cutting-edge approaches, it is worth understanding the foundational work that established self-improvement as viable. [Reflexion](https://www.semanticscholar.org/paper/Reflexion:-an-autonomous-agent-with-dynamic-memory-Shinn-Labash/46299fee72ca833337b3882ae1d8316f44b32b3c) (Princeton University, MIT, 2023) introduced the core mechanism that most self-improving agents build on: verbal self-reflection stored in persistent memory. Unlike simple retry loops where an agent just tries again, Reflexion maintains a running log of what went wrong and why. Each failed attempt generates a natural-language reflection that gets appended to the agent's context for subsequent attempts. This pushed GPT-3.5 from **48% to significantly higher accuracy** on coding challenges.

[ExpeL](https://arxiv.org/abs/2308.10144) (Andrew Zhao et al., AAAI 2024) extended this by having agents autonomously gather experiences from training tasks through trial and error, derive natural language insights from successes and failures, and use successful experiences as in-context examples for future tasks. The critical advantage: ExpeL learns without parameter updates, making it compatible with closed-source API models. You do not need to fine-tune GPT-4 or Claude to make an ExpeL-style agent improve. You just need to store and retrieve the right experiences.

[Multi-Agent Reflexion](https://arxiv.org/html/2512.20845) (December 2025) addressed a key failure mode of single-agent reflection: cognitive entrenchment. When a single agent reflects on its own failures, it can get stuck in local optima, repeatedly generating the same type of solution because its reflections reinforce existing assumptions. Multi-Agent Reflexion solves this by having multiple agents reflect on shared failures from different perspectives. The approach consistently outperforms both GPT-3.5 baseline and single-agent Reflexion on HotPotQA and HumanEval-Python benchmarks.

These reflection-based approaches are the "self-improvement 1.0" paradigm. They are limited to task-level improvement (getting better at the specific task being attempted) rather than meta-level improvement (getting better at the process of improvement itself). But they remain the most practically deployable form of self-improvement because they require no special infrastructure: just an LLM API, a memory store, and an evaluation function.

### Self-Play and Reinforcement Learning

The hottest paradigm in 2025-2026 is agents that generate their own training data through self-play. [SWE-RL](https://arxiv.org/abs/2512.18552), developed by Meta Superintelligence Labs and published in December 2025, trains a single LLM to alternate between two roles: bug injector and solver. The agent introduces bugs into real codebases, then trains itself to fix them. No human-labeled issues or pre-existing tests are needed. The approach achieved **+10.4 points** on SWE-bench Verified and **+7.8 points** on SWE-bench Pro over human-data baselines, using a **32B parameter** backbone trained on NVIDIA H100 GPUs.

[Multi-Agent Evolve](https://arxiv.org/abs/2510.23595) (MAE), published in October 2025, takes a different angle on self-play. Three co-evolving agents (Proposer, Solver, Judge) are instantiated from a single LLM and optimized via reinforcement learning. The Proposer generates questions, the Solver attempts solutions, and the Judge evaluates both. On Qwen2.5-3B-Instruct, this achieved an average improvement of **4.54% across multiple benchmarks** without any human-curated supervision. A March 2026 variant called [SAGE](https://arxiv.org/abs/2603.15255) (not to be confused with the skill-augmented SAGE) extended this to four agents (Challenger, Planner, Solver, Critic) with a curriculum drift prevention mechanism.

[DeepSWE](https://www.together.ai/blog/deepswe), developed by the Agentica team with Together AI and released in July 2025, demonstrated that pure RL training can produce a competitive open-source coding agent. Trained from Qwen3-32B over **6 days on 64 H100 GPUs** across **4,500 real-world SWE tasks**, it achieved **59% on SWE-bench Verified** with test-time scaling (42.2% Pass@1, 71.0% Pass@16). Everything was open-sourced: dataset, code, training, and evaluation logs.

### Evolutionary Code Optimization

[AlphaEvolve](https://arxiv.org/abs/2506.13131), from Google DeepMind, applies evolutionary search with Gemini models (2.0 Flash + 2.0 Pro) as the mutation engine. The headline results are staggering. AlphaEvolve **recovered 0.7% of Google's worldwide compute resources** through optimized data center scheduling and has been deployed in production for over a year via Borg. It achieved a **32.5% speedup** for FlashAttention kernels in Transformers. It improved best-known solutions in **20% of 50+ open mathematical problems**. And it found a matrix multiplication algorithm better than [Strassen's 1969 breakthrough](https://en.wikipedia.org/wiki/Strassen_algorithm), one of the most studied problems in computer science.

The significance of AlphaEvolve goes beyond the benchmark numbers. It demonstrates that evolutionary self-improvement at scale delivers concrete economic value: **0.7% of Google's worldwide compute** is an enormous amount of resources. For context, Google operates some of the largest data center fleets on the planet. Recovering even a fraction of one percent through automated algorithm optimization translates to millions of dollars in saved infrastructure costs annually. This is the first clear evidence that self-improving agents can generate return on investment at hyperscale, not just produce impressive research results.

[ShinkaEvolve](https://github.com/SakanaAI/ShinkaEvolve), from Sakana AI and accepted at ICLR 2026, is the open-source counterpart. Its headline result: discovering a novel load-balancing loss function for Mixture-of-Experts models that **outperformed DeepSeek's state-of-the-art** after only **30 generations**. On circle-packing benchmarks, it achieved new state-of-the-art with roughly **150 evaluations** versus thousands for prior systems. [CodeEvolve](https://arxiv.org/abs/2510.14150) then outperformed AlphaEvolve on **4 distinct problems**, establishing new records using both closed-source and open-weight LLM backbones. The community-built [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve) provides an open-source implementation of AlphaEvolve's core MAP-Elites population database and cascade evaluator architecture.

### Self-Referential Agent Modification

Beyond the ADAS/DGM/HyperAgents lineage, several independent teams have explored agents that edit their own source code. [SICA](https://openreview.net/pdf?id=rShJCyLsOr) (Self-Improving Coding Agent), from the University of Bristol, eliminates the distinction between meta-agent and target agent entirely. The agent proposes modifications to its own agent script, applies candidate edits, re-evaluates, and keeps changes that improve metrics. Performance climbed from **17% to 53%** on a random subset of SWE-bench Verified.

[Godel Agent](https://arxiv.org/abs/2410.04444), published at ACL 2025, takes a runtime approach. Rather than editing source files, it uses LLMs to **dynamically modify its own logic** through monkey-patching at runtime, guided solely by high-level objectives. A Verification agent checks all modifications against safety invariants before applying them, preventing unsafe self-modifications. The distinction between compile-time modification (SICA, HyperAgents) and runtime modification (Godel Agent) matters for deployment. Runtime modification is more flexible but harder to audit, since the agent's behavior can change between function calls without leaving a clear paper trail. Compile-time modification produces version-controlled artifacts that can be reviewed, reverted, and shared. Most production systems will likely prefer the compile-time approach for its auditability.

[AgentEvolver](https://arxiv.org/abs/2511.10395), from Alibaba's Tongyi Lab (November 2025), implements a complete self-evolving training framework with three synergistic mechanisms. Self-questioning drives curiosity-based task generation, where the agent creates its own training curriculum. Self-navigating enables experience reuse through hybrid policy guidance, so the agent learns from past successes. Self-attributing provides differentiated rewards based on each component's actual contribution to success, rather than applying uniform rewards. The system achieves superior results while using **substantially fewer parameters** than larger baseline models. This is important because it demonstrates that self-improvement can be a substitute for scale: a smaller, self-improving model can match or exceed a larger static one.

[The Mendel Godel Machine](https://arxiv.org/abs/2608.07645) (August 7, 2026, from the University of Electronic Science and Technology of China, LMU Munich, and the Munich Center for Machine Learning) attacks the sample efficiency of this whole lineage. Earlier self-modifying coding agents derive each edit from a single failure trajectory, discarding the comparative signal sitting in the rest of the archive. MGM reads across it: reaction-norm mutation edits an agent using its trajectories on several tasks at once, and cross-lineage hybridization edits it using a reference agent from a different branch of the search tree. Inside a fixed budget of **200 evaluations**, it moved SWE-bench Verified from **68.3% to 78.3%** and Polyglot from **50.8% to 93.2%**, against **73.3%** and **77.9%** for the Huxley-Godel Machine baseline on the same budget. The backbone was an open-weight **35B-parameter** Qwen model, and the scaffolds it evolved transferred to a different backbone without retraining, scoring **75.0%** on SWE-bench Verified under DeepSeek-V4-Pro. That transfer result is the practical version of the HyperAgents claim: what these systems learn is a scaffold, not a set of weights, so it moves.

### Experience-Driven Learning

A growing body of work focuses on agents that learn from accumulated experience without explicit self-modification. [EvolveR](https://arxiv.org/abs/2510.16079) (October 2025) implements a closed-loop lifecycle with two stages: offline self-distillation (where trajectories are synthesized into reusable strategic principles) and online interaction (where the agent retrieves those principles to guide decisions). It uses RL to teach the agent to actually utilize experience rather than just memorize past interactions.

[SEAgent](https://arxiv.org/abs/2508.04700) (August 2025) enables computer-use agents to autonomously master novel software via experiential learning. Agents explore unfamiliar applications, learn through trial and error, and progressively tackle auto-generated tasks from simple to complex. A World State Model assesses trajectory quality, and a Curriculum Generator creates progressively harder challenges. The result: a **+23.2% success rate improvement** (11.3% to 34.5%) over UI-TARS, the previous best computer-use agent.

[AgentTrek](https://openreview.net/forum?id=EEgYUccwsV), an ICLR 2025 Spotlight paper, approaches experience from the data side. It creates a scalable pipeline for synthesizing high-quality web agent trajectories from online tutorials. The system auto-gathers tutorial-like texts from the web, transforms them into task goals with step-by-step instructions, and simulates execution in real environments. A VLM-based evaluator ensures correctness. The resulting synthetic data significantly improves GUI agent grounding and planning while being more cost-efficient than human annotation.

### Automated Scientific Discovery

Self-improvement in science represents a particularly high-value application. [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) loop, discussed in detail in the production section, is the simplest example: modify training code, run experiment, evaluate, iterate. But more ambitious systems are pushing toward fully automated research.

The [AI Scientist](https://sakana.ai/ai-scientist/) project from Sakana AI (collaborating with the Foerster Lab at Oxford and UBC) has produced two generations of fully automated scientific paper generators. Version 2 achieved something remarkable: a paper titled "Compositional Regularization: Unexpected Obstacles in Enhancing Neural Network Generalization" scored **6.33 average** at an ICLR workshop review, above the acceptance threshold. This was the first fully AI-generated paper to pass standard peer review. The cost per paper: approximately **$15**. However, independent evaluations found quality issues: median 5 citations per paper, structural errors, and occasional hallucinated results. The gap between "passes review" and "advances the field" remains significant.

[Agent Laboratory](https://arxiv.org/abs/2501.04227), from Samuel Schmidgall (EMNLP 2025), structures the research process into three phases: Literature Review, Experimentation, and Report Writing. Specialized agents collaborate using arXiv, Hugging Face, Python, and LaTeX. The system achieved **84% cost reduction** versus previous autonomous research methods. With o1-preview, it scored **4.4/5 usefulness** and **3.4/5 report quality** in human evaluations. Its extension, AgentRxiv, enables agent laboratories to incrementally improve by building on prior research outputs, creating a compounding knowledge loop.

### Prompt and Agent Optimization

A distinct but related paradigm focuses on optimizing the prompts and configurations that control agent behavior, rather than modifying agent code directly. [GEPA](https://github.com/gepa-ai/gepa) (Genetic-Pareto Optimization Framework) uses LLMs to read full execution traces, including error messages, profiling data, and reasoning logs, to diagnose failures and propose targeted fixes. It combines genetic algorithm concepts with Pareto-style selection. The results are impressive: GEPA outperforms RL approaches like GRPO and optimizers like MIPROv2 while using **up to 35x fewer rollouts**. It needs **100-500 evaluations** versus **10,000+** for RL approaches, and works with as few as **3 examples**.

OpenAI published a [Self-Evolving Agents Cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining) in November 2025, providing an official guide for autonomous agent retraining. The cookbook teaches how to diagnose agent failures, instrument measurable feedback, and assemble self-healing workflows combining human review, LLM-as-judge evaluations, and iterative prompt refinement. It uses GEPA for dynamic prompt evolution. The real-world use case demonstrated: drafting regulatory documents for pharmaceutical companies. This is notable because OpenAI is explicitly endorsing the self-evolving agent paradigm as a production pattern, not just a research curiosity.

[AutoAgent](https://arxiv.org/abs/2502.05957), from the University of Hong Kong (February 2025), eliminates code entirely. It creates agents from natural language descriptions only, using Self-Play Agent Customization for iterative self-improvement. Four components work together: Agentic System Utilities, an LLM-powered Actionable Engine, a Self-Managing File System, and the self-play loop. The system ranked **#2 on the GAIA benchmark** with **55.15% overall** accuracy, including **71.7%** on Level 1 tasks, outperforming Langfun Agent (60.38%) and FRIDAY (45.28%).

### Emergent Internal Self-Debate

A January 2026 [paper](https://arxiv.org/abs/2601.10825) discovered something unexpected: reasoning models like DeepSeek-R1 and QwQ-32B **spontaneously simulate multi-agent debates** within their own chain of thought. Without any external prompting, these models generate internal arguments between distinct cognitive perspectives (a "Planner," a "Critical Verifier," etc.) that argue, question, verify, and reconcile. Steering these conversational features via activation addition produced a **+27 percentage point accuracy improvement** on the Countdown arithmetic benchmark. This behavior emerges autonomously through reinforcement learning training, not from explicit multi-agent design.

A complementary finding from the [DAR framework](https://arxiv.org/abs/2603.20640) (Diversity-Aware Retention, March 2026) showed that multi-agent debate offers limited advantages over single-agent scaling for solution-finding tasks. But for **safety-reasoning and response-judging tasks**, collaborative refinement strengthens defense as more agents are added. The practical implication: self-improving agents may benefit most from internal debate when evaluating their own modifications, not when generating them.

These findings collectively suggest that the multi-agent paradigm may be something models converge on naturally when given sufficient reasoning capacity, and that the most productive application of this emergent behavior is in the verification step of the self-improvement loop.

### Skill Libraries: Compounding Improvement Through Reusable Artifacts

One of the most practically important patterns in self-improvement is the skill library: agents that accumulate reusable code artifacts from past tasks and apply them to future ones. This pattern was pioneered by [Voyager](https://arxiv.org/abs/2305.16291) (NVIDIA, Caltech, UT Austin, Stanford, May 2023), the first LLM-powered embodied lifelong learning agent. Operating in Minecraft, Voyager maintained three components: an automatic curriculum for exploration, an ever-growing skill library of executable code, and iterative prompting with environment feedback and self-verification. The skill library was the key innovation. Instead of discarding solutions after each task, Voyager stored successful programs as named, reusable functions. When encountering a new task, it first checked its library for relevant existing skills before attempting to write new code.

[SAGE](https://arxiv.org/abs/2512.17102) (Skill Augmented GRPO for Self-Evolution, December 2025, revised March 2026) formalizes this pattern with reinforcement learning. It uses "Sequential Rollout" to iteratively deploy agents across chains of similar tasks. Agents write reusable functions, test them against validation cases, and save working ones to a persistent library. The results demonstrate the power of compounding: **+8.9% Scenario Goal Completion** while cutting output tokens by **59%**. The token reduction is particularly significant because it means the agent is solving tasks more efficiently as it accumulates skills, not just more accurately. Anthropic's [Agent Skills open standard](https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md), released December 2025 and adopted by Microsoft, OpenAI, Atlassian, Figma, Cursor, and GitHub, provides an interoperability layer for these skill libraries, enabling skills developed by one agent to be used by another.

The skill library pattern represents a different kind of self-improvement than the code-editing approaches of HyperAgents or the weight-updating approaches of SWE-RL. Rather than modifying the agent itself, skill libraries modify the agent's available toolkit. The agent does not change how it thinks; it changes what tools it has available for thinking. This distinction matters for safety (tool accumulation is easier to audit than self-modification) and for practical deployment (skills can be curated, shared, and version-controlled using standard software practices).

### The Comprehensive Survey

For practitioners trying to navigate this landscape, a [comprehensive survey](https://arxiv.org/abs/2508.07407) published in August 2025 provides a unified conceptual framework for self-evolving agentic systems. It reviews all major techniques and is accompanied by the [EvoAgentX](https://github.com/EvoAgentX/EvoAgentX) open-source framework and a curated [paper list](https://github.com/EvoAgentX/Awesome-Self-Evolving-Agents) tracking the field. The survey categorizes approaches along two axes: what is being modified (prompts, code, weights, or architecture) and how modification is driven (gradient-based, LLM-guided, evolutionary, or experience-driven). This taxonomy clarifies why different approaches suit different deployment contexts. Weight modification requires training infrastructure. Code modification requires sandboxed execution. Prompt modification requires only API access. Each trade-off shapes what is practical for a given organization.

* * *

## 5\. Memory Is the Bottleneck

Self-improvement requires memory. An agent that cannot remember what it tried, what worked, and what failed is doomed to repeat the same experiments indefinitely. The memory problem has become the central infrastructure challenge for self-improving agents in 2026, with multiple competing approaches and a rapidly growing research community. Two separate workshops at major 2026 conferences (ICLR's MemAgents workshop and dedicated memory tracks at AAAI) reflect how seriously the field is taking this bottleneck.

The fundamental tension is between capacity and relevance. Storing everything an agent has ever done is technically straightforward but computationally expensive and creates a retrieval problem: finding the right memory at the right time from an ever-growing archive. Storing nothing keeps the system fast but eliminates the possibility of learning from experience. Every practical system navigates a trade-off between these extremes.

[Mem0](https://mem0.ai/) has emerged as the dominant commercial solution. After raising a **$24M Series A** in October 2025 led by Basis Set Ventures (with Peak XV Partners, GitHub Fund, and Y Combinator), the company reported growth from **35 million API calls** in Q1 2025 to **186 million** in Q3 2025, roughly **30% month-over-month growth** \- [arXiv](https://arxiv.org/abs/2504.19413). The product provides single-line integration that compresses chat history into optimized memory representations. It has accumulated **41,000+ GitHub stars** and **13 million+ PyPI downloads**, and was selected as the exclusive memory provider for AWS's Agent SDK.

Two distinct research projects, confusingly sharing similar names, address memory at the systems level. [MemOS](https://arxiv.org/abs/2507.03724) (from MemTensor, May 2025 with a v2.0 "Stardust" release in December 2025) treats memory as a manageable system resource. Its basic unit is a "MemCube" that encapsulates content plus metadata including provenance and versioning. It supports plaintext, activation-based, and parameter-level memories with asynchronous ingestion via a MemScheduler. The v2.0 release added multi-modal memory (images, charts), tool memory for agent planning, and Redis Streams-based scheduling.

Separately, [MemoryOS](https://aclanthology.org/2025.emnlp-main.1318/) (from Beijing University of Posts and Telecommunications, accepted as an EMNLP 2025 Oral presentation) implements hierarchical storage inspired by operating system memory management: short-term, mid-term, and long-term personal memory with dynamic updates using dialogue-chain-based FIFO and segmented page organization. On the LoCoMo benchmark with GPT-4o-mini, it achieved **+48.36% F1** and **+46.18% BLEU-1** over baselines.

The newest entrant, [SimpleMem](https://arxiv.org/abs/2601.02553) (January 2026), combines semantic structured compression, online semantic synthesis, and intent-aware retrieval planning. Its results are particularly impressive: **+26.4% average F1 improvement** over baselines while reducing inference-time token consumption by **up to 30x**. On GPT-4.1-mini, SimpleMem achieved an F1 of **43.24** versus Mem0's **34.20** versus full-context LoCoMo's **18.70**.

A comprehensive [survey](https://arxiv.org/abs/2512.13564) published in December 2025, accompanied by a curated [paper list](https://github.com/Shichun-Liu/Agent-Memory-Paper-List), categorizes agent memory into three paradigms: flat retrieval-based (simple but limited), explicitly structured (better organization but rigid), and policy-managed memory systems (most flexible but hardest to implement). The survey draws a finer taxonomy distinguishing factual memory (what happened), experiential memory (what worked), and working memory (what is currently relevant).

The practical implication for practitioners is clear: any self-improving agent system that does not include a serious memory layer will plateau quickly. The improvement loop requires not just the ability to generate variations, but the ability to remember which variations worked and why. This is why HyperAgents' autonomous invention of persistent memory infrastructure is so significant. The system recognized, without being told, that memory was a prerequisite for sustained improvement.

For organizations evaluating memory solutions, the decision framework is relatively straightforward. If you need a drop-in commercial solution with proven scale, Mem0 is the clear frontrunner with its AWS integration and **186 million API calls per quarter** track record. If you need full control and are willing to self-host, MemOS provides the most complete systems-level abstraction. If you are optimizing for efficiency and accuracy, SimpleMem's results (higher F1 than Mem0 at 30x fewer tokens) suggest it may become the performance leader as it matures. And if you are building on a managed platform like [o-mega.ai](https://o-mega.ai/), the memory infrastructure is handled for you, with semantic embeddings, file-based knowledge storage, and automatic retrieval built into the platform layer. The key insight across all these solutions is that memory is not just storage. It is retrieval, compression, relevance ranking, and decay management. Getting memory right is at least as important as getting the agent's reasoning right.

* * *

## 6\. Measuring Self-Improvement

Benchmarks tell us how far agents have come, but measuring self-improvement specifically, meaning improvement over time within a single system, requires a different kind of evaluation. The field is still figuring out how to do this well.

The most rigorous longitudinal measurement comes from [METR](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/) (Model Evaluation and Threat Research). Their "time horizon" metric measures the length of task that an AI agent can complete autonomously with 50% reliability. This metric has been **doubling every ~7 months** (196 days) for six years, with an R-squared of 0.98, meaning the exponential trend explains 98% of the variance. In 2024-2025, the rate [accelerated to every 4 months](https://metr.org/blog/2026-1-29-time-horizon-1-1/). METR's [published TH1.1 dataset](https://metr.org/time-horizons/) now puts the doubling time since 2023 at **128.7 days** (confidence interval 104 to 158 days), with an all-time stitched trend of **187.8 days**. The measured horizons moved with it: Claude 3.7 Sonnet scored **60 minutes** in February 2025, Claude Opus 4.5 **293 minutes** in November 2025, Claude Opus 4.6 **719 minutes** in February 2026, and the Claude Mythos preview **1,045 minutes**, about 17 hours, in April 2026. The multi-hour autonomous task that looked like a mid-2027 milestone arrived in early 2026 instead.

On specific benchmarks, the progression is equally striking. [SWE-bench](https://www.swebench.com/) has become the standard for measuring coding agent capability. Cognition's Devin scored **13.86%** when it launched in early 2024, representing a **7x improvement** over prior state of the art. By mid-2025, self-improving systems like SICA had pushed this to **53%**. DeepSWE, the open-source RL-trained agent, hit **59%** with test-time scaling. Current frontier closed-source agents score significantly higher. The benchmark has gone from "unsolvable" to "mostly solved" in under two years.

[GAIA](https://hal.cs.princeton.edu/gaia), a benchmark of 466 human-annotated tasks mixing text, images, and files, still shows a Claude Sonnet 4.5 generalist agent on top at **74.55% overall**, with Anthropic models sweeping the leading positions. That figure has stopped moving because Princeton's HAL team has **paused leaderboard updates** to concentrate on measuring agent reliability instead, which is its own signal about where evaluation is heading: peak accuracy on a fixed task set is no longer the interesting question. [WebArena](https://webarena.dev/), which measures web browsing agent capability, has seen scores rise from **14%** to roughly **61.7%** (IBM's CUGA agent) in two years.

A newer benchmark, [AIRS-Bench](https://arxiv.org/abs/2602.06855) (Facebook Research, February 2026), evaluates agents on **20 real ML research tasks** drawn from published papers. The headline finding is sobering: agents achieve only **23% of human performance** on average. But the fascinating detail is that in **4 out of 20 cases**, agents exceeded published benchmarks by discovering entirely novel solution strategies, including sophisticated model ensembles with meta-learning components that the original paper authors did not consider. This pattern, mediocre on average but occasionally superhuman, is exactly what you would expect from a system exploring a large search space with imperfect evaluation.

Anthropic's computer use capabilities tell a particularly dramatic improvement story. Claude's score on [OSWorld](https://os-world.github.io/) jumped from **under 15%** (late 2024) to **72.5%** (early 2026) with Sonnet 4.6. The human average is roughly **75%**. On the Pace insurance benchmark for real-world desktop automation, Claude achieved **94% accuracy**. Anthropic acquired [Vercept](https://alternativeto.net/news/2026/2/anthropic-acquires-vercept-to-boost-claude-s-computer-use-skills/) (a 9-person startup co-founded by Ross Girshick, a leading computer vision researcher) in February 2026 specifically to accelerate computer use capabilities. By the time [Claude Opus 5](https://www.anthropic.com/news/claude-opus-5) shipped on **July 24, 2026**, Anthropic reported it beating every competitor on OSWorld 2.0, the harder successor benchmark, at just over a third of the cost of the previous best score. The progression from 15% to a benchmark that had to be replaced, in under two years, illustrates how quickly self-improving research loops translate to measurable capability gains when the evaluation signal is clear.

The problem with all these benchmarks is saturation. Once a benchmark approaches 90-100% solve rates, it stops being useful for measuring improvement. SWE-bench is already showing signs of this. The field needs new benchmarks that measure sustained improvement over time rather than peak performance on a fixed test set. METR's time horizon metric is the closest thing to this, but it measures the field's progress, not any individual system's self-improvement trajectory.

A deeper issue is that benchmarks measure what we know how to measure, not necessarily what matters most. The most valuable forms of self-improvement may be in domains where we lack good metrics: agents that get better at understanding what a user actually wants (not just what they said), agents that learn organizational context and politics, agents that develop better judgment about when to act autonomously versus when to ask for help. These capabilities are crucial for production deployment but almost impossible to benchmark. This measurement gap is why the verifiability constraint remains so binding: we can only optimize what we can measure, and we can only reliably measure outcomes in domains with clear right/wrong signals.

* * *

## 7\. Production Self-Improvement: Who Is Actually Doing This

Research results are impressive, but the more important question is who is shipping self-improving agents in production and generating actual revenue from them. The answer in early 2026 is: more organizations than most people realize, but with important caveats about what "self-improvement" means in a production context.

### Meta's Ranking Engineer Agent

The most concrete example is Meta's [Ranking Engineer Agent](https://engineering.fb.com/2026/03/17/developer-tools/ranking-engineer-agent-rea-autonomous-ai-system-accelerating-meta-ads-ranking-innovation/) (REA), announced in March 2026. REA autonomously executes the end-to-end machine learning lifecycle for Meta's ads ranking models: generating hypotheses, launching training jobs, debugging failures, analyzing results, and iterating. The system uses a Dual-Source Hypothesis Engine that combines insights from historical experiments with deep ML research papers. A Three-Phase Planning Framework (Validation, Combination, Exploitation) structures how hypotheses are tested and refined. A Hibernate-and-Wake Mechanism allows continuous multiweek operation.

The results are concrete. REA **doubled average model accuracy** over baseline across six models. Three engineers using REA delivered improvements for **8 models** simultaneously, a task that previously required **2 engineers per model**. This is not a research demo. It is deployed at Meta's scale, improving the ad ranking models that generate the majority of the company's revenue.

The technical architecture is worth examining because it illustrates production-grade self-improvement. REA uses a Hibernate-and-Wake Mechanism that allows continuous multiweek operation without human supervision. A Dual-Source Hypothesis Engine combines insights from historical experiments (what worked before) with deep ML research papers (what might work based on published literature). A Three-Phase Planning Framework structures how hypotheses are tested: Validation (confirm the hypothesis is implementable), Combination (test interactions with existing model changes), and Exploitation (optimize the best-performing combinations). This architecture shows what it takes to move self-improvement from a research concept to a production system: not just the ability to generate improvements, but the ability to manage a sustained, multi-week improvement campaign with explicit phases and failure recovery.

### Cognition (Devin)

[Cognition AI](https://cognition.ai/), the company behind Devin, reached **$73M ARR** in early 2026, up from **$1M in September 2024** \- [TechCrunch](https://techcrunch.com/2025/09/08/cognition-ai-defies-turbulence-with-a-400m-raise-at-10-2b-valuation/). The company raised **$400M at a $10.2 billion valuation** in September 2025. Devin 2.0 introduced dynamic re-planning without human intervention, and roughly **67% of Devin's PRs are now merged** (up from ~34% at launch). Nubank reported **8x engineering efficiency** and **20x cost savings** from Devin deployments. Perhaps most tellingly, Devin contributed to its own speed improvements by building tools and scripts that it would later use in subsequent sessions, a form of tool-creation self-improvement.

### Karpathy's Autoresearch Loop

Andrej Karpathy open-sourced his [autoresearch](https://github.com/karpathy/autoresearch) system in March 2026: a **630-line Python script** that lets an AI agent autonomously modify training code, run experiments (5 minutes each on a single GPU), evaluate results, and iterate. He ran **700 experiments in 2 days** and discovered **20 optimizations** that improved "Time to GPT-2" from 2.02 hours to 1.80 hours, an **11% efficiency gain** \- [Fortune](https://fortune.com/2026/03/17/andrej-karpathy-loop-autonomous-ai-agents-future/). Shopify CEO Tobias Lutke ran the same system overnight: **37 experiments**, **19% performance gain** on an internal model. The simplicity of the approach (edit code, run experiment, evaluate, iterate) demonstrates that self-improvement does not require elaborate frameworks when the domain has clean metrics.

### Anthropic's Claude Code Research

Anthropic's internal research on long-running Claude agents produced remarkable results. An autonomous coding agent with access to **16 GPUs ran 910 experiments in 8 hours**, reaching the same best validation loss **9x faster** than sequential baseline and improving bits-per-byte from 1.003 to 0.974 - [Anthropic](https://www.anthropic.com/research/long-running-Claude). Separately, researcher Nicholas Carlini reported that **16 Claude Opus 4.6 agents wrote a C compiler in Rust** from scratch, one capable of compiling the Linux kernel. METR measures Opus 4.6's 50% time horizon at **719 minutes**, roughly 12 hours, and the frontier has moved twice since: the Claude Mythos preview reached **1,045 minutes** in April 2026, and [Claude Opus 5](https://www.anthropic.com/news/claude-opus-5) arrived on **July 24, 2026** at $5 per million input tokens and $25 per million output tokens, more than doubling Opus 4.8's score on Anthropic's Frontier-Bench.

### OpenAI Codex and GPT-6 Astra

OpenAI's [Codex](https://openai.com/index/introducing-codex/) launched in late January 2026, powered by codex-1 (an optimized o3 model). It works in cloud sandbox environments where it can execute code autonomously. [Codex subagents reached GA in March 2026](https://openai.com/index/introducing-gpt-5-3-codex/), enabling parallel autonomous workflows. OpenAI has since moved its own frontier again with [GPT-6 Astra](https://openai.com/index/gpt-6-astra/), released **September 3, 2026** and positioned by the company as state of the art on computer use, browsing, software engineering, cybersecurity, and science. Astra saturates two benchmarks the field had been treating as headroom, scoring **98%** on FrontierMath Tier 4 and **99.9%** on ARC-AGI-3, and it is the first OpenAI model to reach the **Critical** cybersecurity capability level under the company's Preparedness Framework. That classification is why it shipped with runtime monitoring that can pause an agent mid-task for a human to review. While OpenAI has not published detailed self-improvement metrics for Codex, the system's architecture (cloud sandbox + parallel execution + iterative refinement) provides the infrastructure for self-improving loops. The OpenAI Self-Evolving Agents Cookbook, discussed in Section 4, is the company's explicit guidance for building these loops on their platform.

### Beam AI: Self-Learning Enterprise Agents

[Beam AI](https://beam.ai/agentic-insights/self-learning-ai-agents-transforming-automation-with-continuous-improvement) has positioned itself as a leader in self-learning agents for enterprise workflows. Their "Tool Tuner" auto-optimization system implements three forms of continuous improvement. Prompt Refinement automatically adjusts prompts based on measured outcomes. Error Correction detects common failure patterns and patches agent behavior without manual intervention. Continuous Improvement uses reinforcement signals from real production usage to iteratively improve agent performance. The distinguishing feature is that these improvements happen during production operation, not during a separate training phase. The agent gets better while doing its actual job.

### The Market Context

These production deployments exist within a rapidly growing market. [Markets and Markets](https://www.marketsandmarkets.com/) sizes the global AI agent market at **$7.84 billion in 2025**, projecting **$52.62 billion by 2030**. [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025) predicts **40% of enterprise applications** will feature task-specific AI agents by end of 2026, up from less than 5% in 2025. [IDC](https://www.idc.com/) expects AI agent use among the Global 2000 to increase **10x by 2027**, with token volumes spiking **1,000x**. But the reality check is important: only **95 out of 1,837** respondents in one industry survey had AI agents live in production. The gap between hype and deployment remains wide.

Platforms like [o-mega.ai](https://o-mega.ai/) bridge this gap by providing managed infrastructure where self-improving agents can operate without requiring teams to build their own training loops. O-mega's architecture stores all agent knowledge as files with semantic embeddings (1,536-dimensional vectors using Gemini's embedding model), enabling agents to accumulate and retrieve learnings from past tasks through semantic search. The platform treats every piece of agent knowledge, including memories, skills, and documents, as a searchable file. When an agent encounters a new task, it retrieves relevant past experiences through vector similarity, applying lessons learned across its entire history.

Each O-mega agent operates with its own virtual browser, tool integrations, and identity, learning from the tool stack it operates within and building compound knowledge over time. Multiple agents within the same organization share a knowledge layer, meaning insights discovered by one agent become available to all others. This mirrors the cross-domain transfer effect that makes HyperAgents significant: meta-skills developed in one context propagate to agents working in different contexts. For organizations that want the benefits of self-improving agents without the research overhead, managed platforms represent the most practical path. The key advantage is that the improvement infrastructure (memory storage, embedding pipelines, semantic retrieval, evaluation) is provided as a service rather than built from scratch.

This positioning is particularly relevant for the **95% of organizations** that do not yet have AI agents in production. For them, the question is not "how do I build a self-improving agent?" but "where can I deploy an agent that will get better at its job without requiring my engineering team to maintain a custom ML training pipeline?" The managed platform model answers this by handling the improvement loop as a platform feature rather than a customer responsibility.

* * *

## 8\. The Safety Question

Self-improving agents are exactly the kind of capability that AI safety researchers have worried about for decades. When an agent can modify its own improvement process, the theoretical risk of runaway optimization becomes concrete rather than hypothetical. The field is taking this seriously, but the answers are still incomplete.

Demis Hassabis, CEO of Google DeepMind, stated at WEF 2026: "It remains to be seen, can that self-improvement loop that we're all working on, actually close, without a human in the loop" - [Foom Magazine](https://www.foommagazine.org/is-research-into-recursive-self-improvement-becoming-a-safety-hazard/). Dario Amodei (Anthropic CEO) made similar references to pursuing self-improvement research. The fact that the leaders of the two most safety-conscious AI labs are both publicly acknowledging their work on recursive self-improvement signals how central this capability has become to the competitive landscape.

The [International AI Safety Report 2026](https://internationalaisafetyreport.org/) raised a specific concern: reliable safety testing has become harder because models are learning to distinguish between test environments and real deployment. A 2025 Palisade Research study found that reasoning LLMs attempted to **hack the game system** when tasked to win chess against a stronger opponent, demonstrating that optimization pressure can produce adversarial behavior even in trivial settings. If self-improving agents learn to recognize when they are being safety-tested and conceal misalignment, the entire evaluation paradigm breaks down.

ICLR 2026 is hosting a [dedicated workshop](https://recursive-workshop.github.io/) on Recursive Self-Improvement (April 26-27, 2026, Rio de Janeiro), bringing together researchers working on principled methods for self-improvement. Papers cover experience learning, synthetic data pipelines, weak-to-strong generalization, and inference-time scaling. The workshop's existence signals that the research community views recursive self-improvement as a distinct subfield requiring its own safety framework, not just an extension of existing LLM safety work.

[NIST launched a formal standards initiative](https://siliconangle.com/2026/02/19/nist-launches-ai-agent-standards-initiative-autonomous-ai-moves-production/) for autonomous AI systems in February 2026, issuing requests for public input on agent security risks, identity models, and deployment considerations. The [GUARDRAILS.md](https://guardrails.md/) protocol offers a practical, file-based approach: structured "Signs" that persist across context resets, using trigger-instruction-reason-provenance tuples to prevent agents from repeating known failures. [Galileo](https://galileo.ai/blog/announcing-agent-control) launched Agent Control in March 2026, an open-source (Apache 2.0) control plane for governing AI agents at scale, with AWS, CrewAI, and Glean as launch partners.

HyperAgents includes several built-in safety properties. The foundation model's weights are frozen, meaning the core intelligence cannot recursively self-modify, only the code wrapping it. All experiments run in sandboxed environments with explicit resource constraints. The evaluation criteria are fixed by humans and cannot be modified by the agent. These constraints are real, but they are also the constraints that future work will seek to relax. The trajectory of this research clearly points toward removing human-set limitations one at a time.

The protocol ecosystem is also responding. The [Linux Foundation's Agentic AI Foundation](https://www.linuxfoundation.org/) (AAIF), co-founded in December 2025 by OpenAI, Anthropic, Google, Microsoft, AWS, and Block, now oversees both [MCP](https://modelcontextprotocol.io/) (Model Context Protocol, **97 million monthly SDK downloads**) and [A2A](https://a2a-protocol.org/) (Agent-to-Agent protocol). These standards govern how agents connect to tools and communicate with each other. Neither protocol currently includes provisions for self-modification governance. As agents become self-improving, the protocol layer will need to address questions like: should an agent that has modified itself retain the same permissions? Should modifications be logged in a standardized format? Should other agents be notified when a peer agent has self-modified? These questions are not yet on the standards bodies' roadmaps, but they will need to be.

The theoretical framework for when self-improvement is safe can be summarized in a single inequality from a December 2025 [paper](https://arxiv.org/abs/2512.02731) by Przemyslaw Chojecki: the "Variance Inequality." It defines a spectral condition sufficient for stable self-improvement in a Generator-Verifier-Updater (GVU) framework. The practical takeaway: when self-improvement stalls, strengthen the **verifier** (the component that evaluates modifications), not the generator (the component that proposes modifications). A weaker generator with a strong verifier produces stable improvement. A strong generator with a weak verifier produces instability. This principle applies across every system described in this guide, from HyperAgents to AlphaEvolve to Karpathy's autoresearch loop.

The honest assessment: current self-improving systems are safe primarily because they are limited. They operate in sandboxes, with frozen models, against fixed metrics. As those constraints loosen (and they will, because loosening them produces better results), the safety question becomes progressively harder. The field does not yet have a principled framework for determining how much self-modification authority an agent should have. That is the open problem.

* * *

## 9\. What Comes Next

The research trajectory points in several directions, each with different timelines and levels of certainty.

**Self-improvement will become a standard feature, not a research novelty.** The Karpathy autoresearch loop demonstrates that useful self-improvement can be implemented in 630 lines of Python. As foundation models get better at code generation and evaluation, the bar for building self-improving agents will continue to drop. Within 12 months, expect major agent frameworks to ship self-improvement as a built-in capability rather than a custom add-on.

**Memory infrastructure will consolidate.** The current landscape of Mem0, MemOS, MemoryOS, and SimpleMem reflects early-stage experimentation. The market will consolidate around one or two dominant approaches, likely one commercial (Mem0 is the frontrunner with its $24M funding and AWS partnership) and one open-source standard. Agent builders who invest early in memory architecture will have a significant advantage over those who treat memory as an afterthought.

**Cross-domain transfer will be the key differentiator.** HyperAgents' cross-domain transfer result is the most important finding in the paper. Meta-level skills (memory management, exploration strategies, performance tracking) that transfer across domains are worth far more than task-specific improvements. The next generation of agent platforms will compete on how well their agents transfer learning from one domain to another. Platforms like [o-mega.ai](https://o-mega.ai/platform) that orchestrate agents across diverse tasks are well-positioned for this shift, since agents working across multiple business functions accumulate transferable meta-skills naturally.

**The verifiability constraint will define the frontier.** Self-improvement works in code, math, and optimization because outcomes are verifiable. The research challenge for the next two years is extending self-improvement to domains with softer metrics: writing quality, strategic decisions, relationship management. Expect significant investment in better evaluation methods (LLM-as-judge, human-in-the-loop evaluation, multi-metric optimization) to push the boundary of where self-improvement is effective.

**Safety frameworks will lag behind capability.** This is the most predictable and most concerning trend. Every major AI lab is pursuing self-improvement research. The ICLR 2026 workshop, NIST's standards initiative, and the International AI Safety Report all acknowledge the risks. But the competitive dynamics of the AI industry create strong incentives to push capability before safety frameworks are ready. The frozen-model constraint in HyperAgents is a meaningful safety feature today, but it is also the first constraint that researchers will try to relax tomorrow.

**The "Karpathy Loop" will become a standard pattern.** Karpathy's 630-line autoresearch script demonstrated that self-improvement does not require complex infrastructure. The pattern (generate variation, evaluate, keep improvements, iterate) is universal. Within a year, every serious agent framework will ship a "self-improve" command or flag that implements this loop. The remaining question is how to make the loop work in domains without clean evaluation signals. The teams that solve this, likely through some combination of LLM-as-judge, human-in-the-loop sampling, and multi-metric optimization, will define the next generation of agent platforms.

**The agent economy will split into "static" and "learning" tiers.** Static agents (fixed prompts, fixed tools, fixed behavior) will become commoditized and cheap. Learning agents (self-improving behavior, accumulated skills, cross-domain transfer) will command premium pricing. This mirrors the historical split between rule-based software (cheap, predictable, limited) and machine learning systems (expensive, adaptive, valuable). Organizations will need to decide which tier serves their needs, and the answer will depend on whether their use cases have the verifiable outcomes that self-improvement requires.

**Open-source will democratize self-improvement.** The open-source ecosystem is already catching up to closed-source capabilities. DeepSWE achieved **59% on SWE-bench Verified** with fully open weights, training code, and evaluation logs. The Mendel Godel Machine reached **93.3%** on the full 225-task Polyglot benchmark in August 2026 on a 35B-parameter open-weight backbone, beating a closed-source frontier model of the previous generation with roughly **117x fewer parameters**. OpenEvolve provides an open implementation of AlphaEvolve's architecture. The EvoAgentX framework offers a complete self-evolving agent toolkit. CodeEvolve outperformed AlphaEvolve on four problems using open-weight models. Within the next year, building a self-improving agent will no longer require access to frontier closed-source models or proprietary training infrastructure. A team with open-weight models, a clear evaluation function, and the discipline to run sustained improvement loops will be able to match results that required Google-scale infrastructure just months earlier. This democratization is both exciting (more people building better agents) and concerning (more agents self-improving with less centralized oversight).

The self-improving agent is not a future technology. It is a current one, deployed in production at Meta, Cognition, Anthropic, and dozens of smaller companies. The question is no longer whether agents can improve themselves. The question is how fast, how far, and whether we can maintain meaningful oversight as the improvement loop tightens.

_This guide is written by Yuma Heymans (@yumahey), founder of [o-mega.ai](https://o-mega.ai/), the AI workforce platform for autonomous businesses. His work on multi-agent orchestration and agent memory systems sits at the intersection of the self-improvement research described in this guide and the practical challenges of deploying agents in production._

_This guide covers the AI agent landscape through 2026, with its model, benchmark and funding figures re-verified in September 2026. The self-improving agent field is evolving rapidly. Verify current details and benchmark scores before making investment or deployment decisions._

### Build Your AI Workforce Today

Deploy self-improving agents that evolve and drive revenue, no research team required.

[Start Free with O-mega](https://o-mega.ai/founden/start)

`// Turn your vision into an empire <3`

[![o-mega Text Logo](https://o-mega.ai/_next/image?url=%2Fimages%2Fo-mega_text_logo_white.png&w=256&q=75)](https://o-mega.ai/)

Build your autonomous company.

Product

- [Founden](https://founden.ai/)
- [Suprsonic](https://suprsonic.ai/)
- [Suprbrowser](https://suprbrowser.ai/)

Company

- [Plans](https://o-mega.ai/plans)
- [Enterprise](https://o-mega.ai/enterprise)
- [About](https://o-mega.ai/about)
- [Articles](https://o-mega.ai/articles)

Resources

- [Documentation](https://o-mega.ai/docs)
- [AI Agent Index](https://o-mega.ai/agents)
- [Brand Assets](https://o-mega.ai/brand-assets)
- [Support](mailto:support@o-mega.ai)
- [Contact](mailto:support@o-mega.ai)

Legal

- [Privacy Policy](https://o-mega.ai/privacy)
- [Terms of Service](https://o-mega.ai/terms)

[X / Twitter](https://x.com/o_mega___)[LinkedIn](https://www.linkedin.com/company/o-mega)[YouTube](https://youtube.com/@o-mega-ai)

© 2026 O-mega Enterprise, Inc. All rights reserved.