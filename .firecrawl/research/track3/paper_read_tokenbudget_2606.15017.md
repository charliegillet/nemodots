The last row corresponds to Vanilla-IB.\
\
The extended horizon is the main success-rate improvement, while pruning is primarily a token-reduction mechanism.\
Pruning consistently reduces token usage at both horizons and more than offsets the cost of five additional interaction steps, so Vanilla-IB uses fewer tokens than the plain 10-step baseline while matching or improving success rate.\
Its effect on success rate is smaller and domain-dependent, which is expected: the purpose of pruning is to remove redundant accessibility-tree text, not to add new reasoning capability.\
When pruning helps, we suspect it is because removing duplicate entries makes the context more information-dense and shortens token distances between related elements, such as labels and fields.\
These effects may make actionable content easier to track, but the mixed domain results suggest that this benefit is not uniform.\
\
## 6 Practical Advantages of Stateless Evaluation\
\
Beyond success rate and token cost, two practical properties differ between Vanilla-IB and the augmented methods, both stemming from the absence of cross-task state.\
\
#### Parallelism.\
\
Vanilla-IBtreats tasks as independent episodes and maintains no shared cross-task state.\
As a result, with NN workers, tasks can be executed concurrently, reducing end-to-end wall-clock time by up to a factor of NN.\
In contrast, AWM, ASI, and ReasoningBank are inherently sequential: each task must finish before the next begins because the memory or skill state derived from its trajectory is reused in subsequent tasks.\
This makes parallel deployability an additional practical advantage of Vanilla-IB, beyond its token efficiency.\
\
#### Fault tolerance.\
\
Web benchmarks are run against live or simulated website environments that are not always perfectly reliable: a server may become temporarily unresponsive, a page may time out, or a browser session may crash mid-task for reasons unrelated to the agent (kara-etal-2025-waber).\
For Vanilla-IB, any such failure is local: the affected task can simply be re-run in isolation and the result substituted, since no other task depends on its outcome.\
For AWM, ASI, and ReasoningBank, this repair is not possible in general.\
If task kk fails due to an environment glitch, the knowledge state used by all subsequent tasks k+1,k+2,…k{+}1,k{+}2,\\ldots was already formed without a potential successful trajectory from task kk.\
Re-running task kk in isolation does not retroactively correct the downstream state; a proper repair would require re-running the entire experiment, which can be expensive.\
A single transient environment failure can therefore silently degrade the reported performance of an online augmentation method in a way that is hard to detect.\
In our experiments, when we identified a failure caused by the evaluation infrastructure rather than the agent’s decisions, such as a network issue or browser crash, we re-ran the affected task immediately so that the augmentation methods could still potentially induce knowledge from it, and so that the reported numbers reflect each method’s performance under its intended operating conditions.\
\
## 7 Conclusion\
\
We re-evaluated online web-agent augmentation under a fixed total inference budget, asking whether test-time tokens are better spent on memory, workflow, or skill modules, or directly on additional actor steps. Across three WebArena domains and three models (Gemini 3 Flash, GPT-5.4-mini, and Qwen 3.6-27B), a token-matched vanilla actor matches or surpasses AWM, ASI, and ReasoningBank in aggregate success rate while often using fewer total tokens. We observed the same trend on WorkArena-L1 with Qwen 3.6-27B, indicating that the effect extends beyond consumer web tasks to enterprise knowledge-work settings. These results do not imply that skills or workflow memory are useless: they can provide gains in domains where task structure supports reuse.
---
Values are means over three independent seeds per task type.\
\
#### WorkArena-L1.\
\
The enterprise setting is more balanced but supports the same basic conclusion.\
Table [2](https://arxiv.org/html/2606.15017#S4.T2 "Table 2 ‣ Reddit step-sweep. ‣ 4 Main Results ‣ Are Online Skill and Memory Modules Always Worth Their Tokens? A Budget-Constrained Study of Web Agents") shows that, under Qwen 3.6-27B, Vanilla-IB is effectively tied with ReasoningBank for the best success rate, outperforms AWM and ASI, and uses fewer tokens than ASI and ReasoningBank.\
Thus, Vanilla-IB remains on the success–cost frontier rather than being dominated by an augmented method.\
\
#### Where Does the Token Budget Go?\
\
To identify the source of the token overhead, we decompose total usage into actor tokens from environment interaction and module tokens from workflow induction, skill synthesis, retrieval, and verification, in Table [3](https://arxiv.org/html/2606.15017#S4.T3 "Table 3 ‣ Where Does the Token Budget Go? ‣ 4 Main Results ‣ Are Online Skill and Memory Modules Always Worth Their Tokens? A Budget-Constrained Study of Web Agents").\
The overhead has two sources.\
First, augmented methods pay explicit module costs.\
Second, and less obvious, augmentation methods also inflate the actor’s prompt by injecting retrieved workflows, memories, or available skill functions at each step.\
This implicit cost cannot be removed by making module calls cheaper: as long as retrieved knowledge is inserted into the actor context, the per-step actor cost rises with the size of that content.\
Augmentation therefore imposes a double cost, combining auxiliary inference with larger actor prompts.\
\
|  | Shopping | Reddit | Admin |\
| --- | --- | --- | --- |\
|  | Actor | Modules | Actor | Modules | Actor | Modules |\
| --- | --- | --- | --- | --- | --- | --- |\
| Method | Prompt | Compl. | Prompt | Compl. | Prompt | Compl. | Prompt | Compl. | Prompt | Compl. | Prompt | Compl. |\
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\
| Vanilla-IB | 45.2 | 0.5 | 0 | 0 | 71.3 | 0.4 | 0 | 0 | 98.4 | 0.6 | 0 | 0 |\
| AWM | 64.1 | 0.4 | 6.1 | 0.2 | 82.9 | 0.4 | 3.7 | 0.2 | 135.0 | 0.5 | 6.9 | 0.3 |\
| ASI | 61.8 | 0.5 | 20.0 | 0.5 | 84.6 | 0.4 | 9.3 | 0.3 | 118.1 | 0.5 | 20.2 | 0.6 |\
| ReasoningBank | 36.6 | 1.1 | 16.5 | 0.4 | 53.3 | 1.0 | 22.1 | 0.4 | 96.9 | 1.2 | 26.1 | 0.4 |\
\
Table 3: Token breakdown by component under Gemini 3 Flash on WebArena, per task in thousands (K). Actor: tokens from LLM calls made during interaction steps. Modules: tokens from auxiliary components (workflow induction, skill synthesis, retrieval, verification). Both are further split into prompt and completion tokens. Values are means over three runs. Vanilla-IB has no module calls by construction.![Refer to caption](https://arxiv.org/html/2606.15017v1/x2.png)Figure 2: Vanilla-IB horizon sweep on Reddit under Gemini 3 Flash. Success rate (left) and total tokens per task (right) are reported as a function of interaction steps. The available budget is the token usage of the best-performing augmentation baseline, in this case AWM, shaded in orange (right). At the 10-step mark, Vanilla-IB SR is below AWM, which in isolation might seem to justify augmentation. However, the right panel shows AWM already spends roughly twice as many tokens at that point. Extending the Vanilla-IB horizon up to 25 steps closes this gap: Vanilla-IB surpasses AWM in SR while still using fewer tokens than AWM.\
\
#### Headroom for Vanilla-IB.\
\
We set the Vanilla-IB horizon to 15 steps as a clean, domain-agnostic choice, but in most cases it is a conservative setting.\
As the Reddit sweep shows (Figure [2](https://arxiv.org/html/2606.15017#S4.F2 "Figure 2 ‣ Where Does the Token Budget Go? ‣ 4 Main Results ‣ Are Online Skill and Memory Modules Always Worth Their Tokens?
---
A Budget-Constrained Study of Web Agents") illustrates this tradeoff.\
Under the same total inference budget, an online augmented agent splits its budget between direct environment interaction and auxiliary memory, workflow, or skill machinery.\
A budget-matched vanilla actor instead redirects that budget toward additional observe-act steps.\
The bottom panel previews the main empirical pattern we observe on WebArena (zhou-etal-2024-webarena): once total token usage is counted, a budget-matched vanilla agent achieves the highest average success rate while using fewer tokens than the online augmentation methods.\
\
Prior work on augmentation methods largely assumed that base models lacked the capability to complete tasks end-to-end (wang-etal-2024-agent; wang-etal-2025-asi); more recent frontier models, however, may no longer face that constraint and may require less external scaffolding.\
We therefore ask a direct question: under a fixed inference budget, is it better to allocate tokens to online memory and skill modules, or can a vanilla actor achieve comparable performance by spending the same budget on additional interaction steps?\
We focus on the _online_ setting, where agents update their behavior using trajectories collected during evaluation, rather than relying on offline skill libraries constructed before deployment.\
In this setting, auxiliary costs are incurred repeatedly, the knowledge accumulated by memory or skill modules depends on the order in which tasks are encountered rather than the full task distribution, and task-level parallelism is constrained by the sequential dependence between tasks.\
\
To study this tradeoff, we compare three online augmentation methods, Agent Workflow Memory (AWM; wang-etal-2024-agent), Agent Skill Induction (ASI; wang-etal-2025-asi), and ReasoningBank (ouyang-etal-2025-reasoningbank), against a budget-matched vanilla actor.\
Unlike the augmented methods, which use the default 10-step actor horizon, this baseline allocates the same inference budget to a longer interaction horizon; we refer to it as Vanilla-Increased-Budget (Vanilla-IB).\
We do not present Vanilla-IB as a new agent scaffold, but rather as a simple budget-aware control designed to test whether the overhead of online augmentation is justified.\
\
We evaluate this comparison on WebArena (zhou-etal-2024-webarena) and WorkArena-L1 (drouin-etal-2024-workarena).\
WebArena provides the broadest sweep in our study, spanning three models, four agent configurations, and three domains: Shopping, Reddit, and Admin.\
WorkArena-L1 tests the same budget-matching question in enterprise knowledge-work tasks under Qwen 3.6-27B.\
\
Our main findings are as follows:\
(1) On WebArena, Vanilla-IB achieves the highest aggregate success rate across all three models we test, while mostly using fewer total tokens than AWM, ASI, and ReasoningBank.\
(2) On WorkArena-L1, Vanilla-IB remains competitive with the best-performing augmented methods, indicating that the budget-matching question is not specific to WebArena or consumer-style websites.\
(3) Beyond these aggregate results, we show that single-run success rate hides high task-level variance, and that reporting a method’s performance from a single run is a weak basis for comparison.\
\
These findings suggest three evaluation principles for online web agents. First, comparisons should report _total token usage_ across all modules, not only the actor.\
Second, online augmentation methods should be compared against _baselines within the same budget_.\
Third, evaluations should report _multi-run variance_, since agent evaluation introduces stochasticity that aggregate single-run metrics do not capture.\
\
## 2 Related Work\
\
#### Web-agent benchmarks.\
\
Mind2Web (deng-etal-2024-mind2web) and WebArena (zhou-etal-2024-webarena) introduced large-scale benchmarks for realistic multi-step browser interaction.
---
is the mean over all tasks of Shopping, Reddit, and Admin domains.\
\
### 3.3 Models and Budget Accounting\
\
We evaluate under three models, Gemini 3 Flash(gemini-team-2025-gemini3), GPT-5.4-mini(openai-2026-gpt54mini), and Qwen 3.6-27B(qwen-team-2025-qwen36), each across three independent runs on each domain.\
On WorkArena-L1, we report the results under Qwen 3.6-27B.\
For every configuration, we report task success rate (SR) and total token usage, which aggregates all LLM calls made by the system: actor and any auxiliary module calls (i.e., workflow induction, skill synthesis, memory construction, retrieval, and verification).\
Token usage is averaged per task in thousands of tokens (K).\
For both WebArena and WorkArena-L1, metrics are reported as means and standard deviations over three runs.\
Prior work typically reports metrics on one run, and often does not report token usage; we treat this accounting as a first-class evaluation criterion.\
\
## 4 Main Results\
\
#### Performance and token usage.\
\
Table [1](https://arxiv.org/html/2606.15017#S3.T1 "Table 1 ‣ 3.2 Studied Systems ‣ 3 Experimental Settings ‣ Are Online Skill and Memory Modules Always Worth Their Tokens? A Budget-Constrained Study of Web Agents") summarizes WebArena success rate and total token usage across domains, methods, and models.\
Across WebArena domains, Vanilla-IB achieves the best average success rate for all three base models and, for Gemini 3 Flash and Qwen 3.6-27B, is also the most token-efficient configuration.\
The augmented methods therefore do not simply trade extra tokens for higher accuracy; their workflow, skill, or memory modules often increase cost without producing proportional gains in task success.\
This complicates the interpretation of scaffolded-agent gains: auxiliary reasoning can make a system appear stronger by giving it more computation, but much of that advantage disappears when compared with a vanilla actor that spends a similar budget on additional environment interaction.\
The effect is strongest for GPT-5.4-mini, suggesting that scaffold quality is itself model-dependent: weaker models can produce noisy workflows, skills, or reasoning memories that are difficult for the actor to ignore.\
For stronger models, the augmented methods are less prone to bad insights but still do not overtake Vanilla-IB, consistent with modern actors already internalizing many of the planning and navigation abilities that earlier scaffolds attempted to externalize.\
\
#### Reddit step-sweep.\
\
The closest case for augmentation is Reddit with Gemini 3 Flash, where AWM and Vanilla-IB have identical success rates.\
We probe this case by extending the Vanilla-IB actor horizon further (Figure [2](https://arxiv.org/html/2606.15017#S4.F2 "Figure 2 ‣ Where Does the Token Budget Go? ‣ 4 Main Results ‣ Are Online Skill and Memory Modules Always Worth Their Tokens? A Budget-Constrained Study of Web Agents")).\
As the actor horizon increases, Vanilla-IB steadily improves, matching AWM from 15 steps onward and surpassing it at larger horizons while still using fewer tokens up until 25 steps.\
This comparison also clarifies the role of step count: the augmented methods already exceed the 15-step Vanilla-IB token budget at their standard 10-step horizon, so giving them the same longer horizon would increase rather than resolve the cost imbalance.\
The apparent benefit of workflow memory on Reddit is therefore at least partly explained by budget asymmetry rather than by a robust advantage of the auxiliary module itself.\
\
MethodSR (%) ↑\\uparrowTok (K) ↓\\downarrowVanilla-IB55.56±\\pm2.9109.4±\\pm14.8AWM53.53±\\pm3.8102.8±\\pm2.6ASI48.49±\\pm4.3113.8±\\pm10.2ReasoningBank55.56±\\pm2.8120.3±\\pm5.7\
\
Table 2: Success rate (%) and total token usage per task (K) on WorkArena-L1 for Qwen 3.6-27B.