# Track 1 Research Synthesis: "Done Means Done" — Autonomous Specification Synthesis, Heterogeneous Verification, Loop/Drift Detection, and Calibrated Escalation

> **Track 1 Problem Statement (Crusoe Recursive Agents Hackathon):**
> *"Agents fill in vague goals with their own assumptions, then confidently report success. Build an agent team on Crusoe Managed Inference that writes its own definition of done, checks its work with tests or independent verifier agents, catches itself drifting or looping, and decides whether to continue, re-plan, stop or (rarely) ping a human. How can agents turn a one-line goal into checks they can run without you, so you can actually walk away?"*

---

## Executive Architectural Summary

Recent empirical research across software engineering agents (`arXiv:2506.18824`, `arXiv:2608.06701`, `arXiv:2608.02464`) proves that standard autonomous loops fail for four structural reasons:
1. **The Intent Gap & Silent Assumption-Filling:** When given a 1-line prompt (e.g., *"given a list of integers, remove duplicates"* or *"add an endpoint for compliance records"*), LLMs resolve underspecification via statistical pattern-matching against training priors (`arXiv:2603.17150`, [RiSE MSR](https://risemsr.github.io/blog/2026-03-05-shuvendu-intent-formalization/)). Furthermore, when an agent writes both the specification/tests and the implementation, **narrow/weak specifications** pass verification while failing user intent (`claimcheck`, `arXiv:2610.17358`).
2. **Self-Preference & Correlated Judge Failure:** Using the same LLM family to verify its own work fails due to **perplexity-driven self-preference bias** ([NeurIPS 2024 #106181](https://neurips.cc/virtual/2024/106181)) and **unbounded linear bias under Huber $\epsilon$-contamination** in arithmetic-mean LLM juries (`RoPoLL`, `arXiv:2606.30931`). Moreover, a single-pass LLM judge misses **82% of context corruption** (`p_detect = 0.18`) and achieves only `p_detect = 0.548` overall on mid-episode failures (`arXiv:2608.02464`).
3. **High-Activity Stagnation ("Doom Loops") & Trajectory Drift:** In SWE-bench Verified and SWE-bench Pro, **78.33% to 86.16% of vanilla agent trajectories exhibit behavioral drift** (`LivePlan`, `arXiv:2608.06701`), and OpenHands failing runs burn a median of **900K–1.2M tokens** (52$\times$ more than structured retrieve-locate-fix pipelines) up to the 100-iteration cap (`arXiv:2506.18824`). In field studies of 220+ autonomous 15-minute loops, **45% of loops are problematic stagnation/spinning** while the agent's self-reported status claims progress ([DEV.to Boucle Study](https://dev.to/boucle2026/how-to-tell-if-your-ai-agent-is-stuck-with-real-data-from-220-loops-4d4h)).
4. **The Verbalization Gap & Miscalibrated Stopping:** RLHF alignment causes preference collapse toward high-confidence completions, yielding Expected Calibration Error (**ECE $\ge 0.30$–$0.427$**) with verbalized confidence clustered in $[80\%, 100\%]$ (`arXiv:2502.11028`, `arXiv:2505.01997`, `bioRxiv:10.1101/2025.02.11.637373v1`). Crucially, `arXiv:2601.07767` (*"Are LLM Decisions Faithful to Verbal Confidence?"*) proves that even when models accurately verbalize uncertainty in isolation, **they fail to use their own verbalized uncertainty to alter their action decisions**.

---

## Pillar A: Turning a 1-Line Goal into an Executable Definition of Done (DoD Compilation)

### 1. Core Empirical Claims & Citations
* **Pre/Post-Condition Contracts + TDD-First Lifts:** Across empirical evaluations of AI coding failures (`arXiv:2601.13118`), explicit pre/post-conditions are the second highest-leverage intervention after algorithmic detail. Test-first specification synthesis improves pass@1 by **+12% on MBPP** (`TGen`, `arXiv:2402.13521`) and **+38% pass@1** when paired with ambiguity-targeted discriminative tests (`TiCoder`, `arXiv:2208.05950`, [RiSE MSR](https://risemsr.github.io/blog/2026-03-05-shuvendu-intent-formalization/)). Full contracts combining pre-conditions, post-conditions, and invariants produce significantly fewer false alarms than post-conditions alone (`NL2Contract`, `arXiv:2510.12702`).
* **Postconditions Catch Real Bugs Missed by Dynamic Invariant Miners:** On Defects4J, LLM-synthesized executable postconditions catch **1 in 8 real-world production Java bugs**, including bugs missed by Daikon (`Endres et al., FSE 2024`, cited in `arXiv:2603.17150`).
* **Soundness vs. Completeness of Synthesized Specs:** Even expert human reviewers mislabel incomplete specifications as "strong" (e.g., writing `ensures forall x :: x in result ==> (InArray(a,x) && InArray(b,x))` with `==>` instead of `<==>`, which is trivially satisfied by returning an empty list `[]`) (`Lahiri et al., FMCAD 2024`, cited in `arXiv:2603.17150`). Automated mutation-based completeness metrics combined with symbolic test evaluation boost downstream proof/verification accuracy by **3.6$\times$ over GPT-4o zero-shot** (`Auto-Verus`, `arXiv:2412.06176`).

### 2. Concrete Algorithm: 4-Stage DoD Compiler (`PromptContract` + `Monty` + `claimcheck`)

To compile a 1-line user prompt $g$ into an executable, non-trivial Definition of Done $\mathcal{D}(g)$ without human hand-holding, combine the **8-Section Prompt Contract** ([UnderstandingData / Rentier Digital](https://understandingdata.com/posts/prompt-contracts-specification-before-code/)), **Monty's Version-Space Clausal Conformance** (`arXiv:2607.13303`), and **claimcheck's Blind Back-Translation** (`arXiv:2610.17358`):

#### Stage A1: Environment Grounding & 8-Section Contract Synthesis
Before generating any code or tests, a **Spec Architect Agent** scans the repository (`LocalContextMiddleware` pattern from [LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)) and compiles $g$ into a structured machine-readable `PromptContract`:
1. `objective`: Single-sentence canonical goal statement.
2. `pre_conditions`: Discovered runtime, framework versions, auth mechanisms, existing schemas.
3. `invariants` (**DO NOT MODIFY**): Explicit list of protected file paths, existing test suites, and regression boundaries.
4. `scope_and_deliverables`: Exact allowlist of file paths permitted to be created or edited (enforced by a deterministic `PreToolUse` Scope Guard hook that blocks `Edit`/`Write` outside this list).
5. `implementation_contract`: Typed input/output schemas, error codes, and boundary conditions.
6. `test_first_spec`: Executable test cases (happy path, boundary values, property-based invariants, and negative tests).
7. `acceptance_criteria`: 5C Rubric checks (**C**ountable, **C**onstrained, **C**omparable, **C**heckable via CLI command, **C**heap/deterministic).
8. `anti_patterns`: Task-specific forbidden shortcuts (e.g., *"no mock-only tests"*, *"no hardcoded return literals"*, *"no catching broad exceptions to mask failures"*).

#### Stage A2: Blind Back-Translation Faithfulness Gate (`claimcheck`, `arXiv:2610.17358`)
When an agent writes formal assertions or acceptance tests $\psi$ from a natural-language requirement $g$, asking an LLM judge *"Does test $\psi$ match requirement $g$?"* fails because seeing $g$ biases the judge toward agreeing (`arXiv:2610.17358`).
* **Algorithm (`claimcheck`):**
  1. **Blind Informalizer ($M_{\text{inf}}$):** Model $M_{\text{inf}}$ receives *only* the synthesized test suite / contract $\psi$ and code signatures—**it is never shown the user prompt $g$**. It translates $\psi$ back into plain English: what preconditions, postconditions, scope, and upper/lower bounds $\psi$ actually enforces:
     $$\hat{g} = M_{\text{inf}}(\psi, \text{context})$$
  2. **Blind Semantic Judge ($M_{\text{judge}}$):** A separate model $M_{\text{judge}}$ receives *only* $(g, \hat{g})$—**it is never shown the formal artifact $\psi$** (showing $\psi$ to the judge degrades macro recall by **1.4 to 4.5 points**, `arXiv:2610.17358`).
  3. **Bidirectional Clausal Coverage (`Monty`, `arXiv:2607.13303`):** $M_{\text{judge}}$ extracts substantive clauses $C(g)$ and $C(\hat{g})$ and computes a conformance score $c(\psi) \in [-1, 1]$ averaged over $k=8$ samples:
     - **Soundness:** Does $\hat{g}$ cover all required clauses in $C(g)$ without contradiction?
     - **Completeness (Anti-Narrowing):** Could a trivial degenerate implementation (e.g., returning `0`, `[]`, `null`, or a constant) satisfy $\hat{g}$ while violating $g$? (Catches the classic `r*r <= N` missing `(r+1)*(r+1) > N` bug in `arXiv:2610.17358`).
     - Reject any spec $\psi$ with mean conformance score $\bar{c}(\psi) < 0.6$ (`arXiv:2607.13303`). Across 3,234 specs in 4 formal languages, `claimcheck` improves macro recall by **+8.2 to +9.8 points** over direct single-call LLM judging (`arXiv:2610.17358`).

#### Stage A3: Mutation & Discriminative Ambiguity Check (`TiCoder` / `Lahiri et al.`)
To ensure the executable DoD $\mathcal{D}(g) = \{t_1, \dots, t_m\}$ is **complete** (discriminating against buggy code) and exposes underspecification:
1. Sample $K=3$ diverse lightweight candidate implementations or output predictions $\{p_1, p_2, p_3\}$ for boundary inputs $x_{\text{edge}}$.
2. **Version-Space Split (`Monty` / `TiCoder`):** If candidates disagree on $x_{\text{edge}}$ (i.e., $p_1(x_{\text{edge}}) \neq p_2(x_{\text{edge}})$) AND both interpretations have high clausal conformance $\bar{c} \ge 0.6$ to the vague prompt $g$ (e.g., keeping one copy of duplicates `[1,2,3,4]` vs. removing all duplicated elements `[1,3,4]`), flag $x_{\text{edge}}$ as an **Interpretive / Underspecification Ambiguity** (`arXiv:2603.17150`, `arXiv:2607.13303`).
3. **Mutation Completeness Score:** Generate syntactic/semantic output mutations $o'$ (off-by-one, empty collection, null field, dropped filter). Require the synthesized test suite $T$ to kill $\ge 90\%$ of mutants:
   $$\text{Completeness}(T) = \frac{|\{(i, o') \in \text{Mut}(T) : T(i, o') = \text{FAIL}\}|}{|\text{Mut}(T)|} \ge 0.90$$

---

## Pillar B: Independent, Heterogeneous Verifier Agents + Deterministic Verification Stack

### 1. Core Empirical Claims & Citations
* **Perplexity-Driven Self-Preference Bias:** At NeurIPS 2024 ([NeurIPS #106181](https://neurips.cc/virtual/2024/106181)), researchers demonstrated that LLMs (including GPT-4) assign significantly higher evaluation scores to outputs with **lower perplexity under their own distribution**, regardless of whether the text was self-generated. When generator and verifier share a model family, the verifier systematically rubber-stamps the generator's errors (`arXiv:2508.02994`, [Comet LLM-as-a-Judge Guide](https://www.comet.com/site/blog/llm-as-a-judge/)).
* **Capability-Dependent Directional Bias:** Across 36 judge-examinee pairs (`arXiv:2609.12002`), a model's task accuracy strongly predicts its judging accuracy ($r \ge 0.90$) and inversely predicts directional bias ($r \le -0.83$). Furthermore, multi-agent debate (MAD) on subjective/rubric tasks can actually *degrade* human alignment compared to calibrated judges due to **bandwagon bias, role asymmetry, and downward scoring bias** (`arXiv:2505.19477`, `arXiv:2608.30373`).
* **Fragility of Simple Averaging in Multi-LLM Juries (`PoLL` vs. `RoPoLL`):** While Panel of LLM Evaluators (`PoLL`, `arXiv:2404.18796`) reduces intra-model bias via heterogeneous models, `RoPoLL` (`arXiv:2606.30931`) proves under the **Huber $\epsilon$-contamination model** that arithmetic-mean PoLL suffers **unbounded conditional bias** whenever even a single judge fails in an LLM-typical way (sycophancy, mode collapse, safety refusal, or format corruption), regardless of jury size $N$.
* **Deterministic Verifiers Beat Statistical/LLM Monitors on Grounding & Coverage:** In `arXiv:2608.02464` (across 2,823 agent episodes), a deterministic grounding & coverage verifier catches **60% of failures (96% when combined with a required-tool-call coverage check) at 0/63 (0%) false positives** and catches **26/26 provoked fabrications**, whereas an LLM judge (`gemini-2.5-flash`) achieves only `p_detect = 0.548` with `5.2%` false positives.

### 2. Concrete Mechanism: 3-Layer Verification Stack on Crusoe Managed Inference

Following OpenHands' production **Verification Stack** ([OpenHands Blog 2026-05-06](https://www.openhands.dev/blog/20260506-the-verification-stack), `arXiv:2603.03800`)—which reduced mean time-to-merge by **58%** and increased test coverage by **25%** across 900+ PRs—combined with `RoPoLL` (`arXiv:2606.30931`) and `JuryFlow` (`arXiv:2609.40103`), we design a 3-layer verification architecture using **heterogeneous open-weight model families hosted on Crusoe Managed Inference** (e.g., Qwen, Llama, DeepSeek, Mistral):

#### Layer 1: Deterministic Execution & Grounding Gate (Zero Tokens, $<1\text{ ms}$)
Before invoking any LLM verifier, run three deterministic checks (`arXiv:2608.02464`, [Prompt Contracts](https://understandingdata.com/posts/prompt-contracts-specification-before-code/), [LangChain `PreCompletionChecklistMiddleware`](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)):
1. **Scope & Invariant Check:** Verify `git diff --name-only` is a subset of `PromptContract.scope_and_deliverables` and touches zero files in `PromptContract.invariants`.
2. **Test Execution & Anti-Mock Gate:** Run the existing regression suite $T_{\text{orig}}$ plus the newly synthesized DoD suite $T_{\text{DoD}}$ in an isolated sandbox. Scan the AST of $T_{\text{DoD}}$ to reject mock-only assertions (enforcing OpenHands' Code Review rule: *"rejects mock-only tests; requires tests that exercise real code paths and assert on outputs"*, [OpenHands Verification Stack](https://www.openhands.dev/blog/20260506-the-verification-stack)).
3. **Deterministic Provenance & Numeric Grounding Verifier (`arXiv:2608.02464`):** Recompute any reported summary statistics, metrics, or artifacts in the agent's final output directly from the raw tool-execution stdout/JSON receipts logged in the trajectory, and verify that every required verification tool call was actually executed (catches **7/7 silent aborts** and **26/26 fabrications** with **0% false positives**).

#### Layer 2: Agent-as-a-Judge Behavioral QA Agent (`arXiv:2601.05111`, OpenHands QA Skill)
Static diff review misses runtime behavioral bugs. A separate **QA Verifier Agent** (using a different model family from the Generator, e.g., DeepSeek-V3 or Llama-3.3-70B verifying Qwen-Coder) executes a 4-phase behavioral check ([OpenHands Verification Stack](https://www.openhands.dev/blog/20260506-the-verification-stack)):
1. **Understand:** Parse PR diff and `PromptContract` entry points (CLI, API, functions).
2. **Setup:** Bootstrap clean environment.
3. **Exercise:** Actively probe the artifact with adversarial and boundary inputs not used during generation (`Agent-as-a-Judge` tool-augmented verification, `arXiv:2601.05111`).
4. **Report:** Emit structured runtime receipts (exit codes, response payloads, tracebacks).

#### Layer 3: Heterogeneous `RoPoLL` + `JuryFlow` Panel Deliberation
To evaluate open-ended or multi-dimensional rubric criteria $\mathbf{y} \in \mathbb{R}^d$ (e.g., correctness, security, spec conformance, maintainability, edge-case coverage) across a panel of $N \ge 3$ **heterogeneous** models on Crusoe Managed Inference (e.g., Judge 1: Llama family, Judge 2: Qwen family, Judge 3: Mistral/DeepSeek family; note `RoPoLL` shows a 3-judge 38B committee beats a single 675B model by **1.31$\times$** under 30% corruption, an **18$\times$ parameter efficiency gain**, `arXiv:2606.30931`):

1. **Atomic Claim Decomposition (`JuryFlow`, `arXiv:2609.40103`):** Decompose the candidate artifact/diff and verification claim into atomic, independently verifiable claims $\{c_1, \dots, c_M\}$. Each judge $j \in \{1, \dots, N\}$ independently assigns a verdict $v_{j,m} \in \{\text{accept}, \text{reject}, \text{uncertain}\}$ and score vector $\mathbf{y}_j \in \mathbb{R}^d$ **without seeing other judges' scores** (preventing bandwagon bias, `arXiv:2505.19477`, `arXiv:2608.30373`).
2. **Geometric Median Aggregation (`RoPoLL`, `arXiv:2606.30931`):** Instead of arithmetic averaging ($\bar{\mathbf{y}} = \frac{1}{N}\sum \mathbf{y}_j$, which has breakdown point $0$), compute the **Geometric Median** $\hat{\mathbf{y}}_{\text{GM}}$, which achieves the optimal finite-sample breakdown point of $1/2$ and preserves cross-dimensional structure:
   $$\hat{\mathbf{y}}_{\text{GM}} = \arg\min_{\mathbf{y} \in \mathbb{R}^d} \sum_{j=1}^N \|\mathbf{y} - \mathbf{y}_j\|_2$$
   Computed in $O(Nd \log(1/\epsilon))$ via the **Modified Weiszfeld Iteration** (`arXiv:2606.30931`):
   $$\mathbf{y}^{(t+1)} = \left(\sum_{j=1}^N \frac{\mathbf{y}_j}{\max(\|\mathbf{y}^{(t)} - \mathbf{y}_j\|_2, \eta)}\right) \bigg/ \left(\sum_{j=1}^N \frac{1}{\max(\|\mathbf{y}^{(t)} - \mathbf{y}_j\|_2, \eta)}\right)$$
   This guarantees bounded error $\|\hat{\mathbf{y}}_{\text{GM}} - \mathbf{y}^\star\|_2 \le C_{\alpha+\beta}\rho$ even when up to $<50\%$ of judges suffer sycophancy or mode collapse (`Theorem 1`, `arXiv:2606.30931`).
3. **Disagreement Graph & Verdict Entropy (`JuryFlow`, `arXiv:2609.40103`):** For each atomic claim $c_m$, compute the Shannon entropy of the judges' verdict distribution $p_m(v)$:
   $$H(c_m) = -\sum_{v \in \{\text{accept}, \text{reject}, \text{uncertain}\}} p_m(v) \log p_m(v)$$
   Claims with $H(c_m) > \tau_H$ identify exact loci of evaluation uncertainty for targeted evidence retrieval or human escalation.

---

## Pillar C: Mathematical & Heuristic Loop and Trajectory Drift Detectors

### 1. Core Empirical Claims & Citations
* **LLM-Prompted Loop Detection Fails Under Context Pollution:** Asking an LLM to notice its own loop fails because by step $k$, the context window is polluted with repeated error outputs (`openhands/openhands#15087`, `arXiv:2610.19376` `DeLoop`). Furthermore, context compression/condensation *increases* looping rates across Qwen, Llama, and Gemini agents because the agent forgets already-tried actions (`DeLoop`, `arXiv:2610.19376`).
* **Decoupling Deterministic Detection from LLM Advising (`LivePlan`, `arXiv:2608.06701`):** Judging every step with an LLM is expensive, hallucinates non-existent problems, and misses real ones. `LivePlan` pairs a **millisecond rule-based trajectory graph monitor** (`Graphectory` + `Langutory`) with an on-demand LLM `Advisor` triggered *only* when a drift signal fires. Across 7,752 trajectories on SWE-bench Verified and SWE-bench Pro, `LivePlan` boosts issue resolution by **up to +15.2% (mean +9.9%) at only \$0.01–\$0.08 extra cost per instance**.
* **Sub-Millisecond Telemetry ESN + CUSUM (`arXiv:2608.02464`):** A one-class Echo State Network (ESN) ensemble with per-channel CUSUM alarms over step telemetry runs in **200 $\mu$s per step** (674 $\mu$s total with adapter), detects **71% of failures at a 5% false-alarm budget (AUROC 0.872)**, and when paired with rollback-and-retry repair recovers **45% of failed runs ($p=0.0005$), lifting net task success from 52% to 73%**.
* **Streaming Structure-Aware Optimal Transport (`OnTrack`, `arXiv:2610.12375`):** Aligning the growing execution DAG against reference workflows in $\sim 1\text{ ms/step}$ detects doomed trajectories within the first 8 steps (+0.057 AUROC over content similarity) and saves **18% of compute** via early aborts with **83% abort precision (5/6 aborted runs were genuinely heading to failure)**.

### 2. Concrete Mechanisms: 3-Tier Real-Time Loop & Drift Detection Engine

#### Tier C1: Deterministic Canonical Action-Observation Hashing & 2$\times$2 Progress Matrix ($< 2\text{ ms/step}$)
Combine **OpenHands `StuckDetector`** ([OpenHands Stuck Detector Docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector), `openhands/software-agent-sdk#4332`, `openhands/openhands#15087`) with **IronCurtain's 2$\times$2 Progress Matrix** ([IronCurtain Loop Detection Design](https://github.com/provos/ironcurtain/blob/d51a3467cbda6a2e94cf04e885e8ae1abdd0f6be/docs/designs/loop-detection.md)) and **LangChain's `LoopDetectionMiddleware`** ([LangChain Harness Blog](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)):

1. **Canonical Fingerprinting (Stripping Monologue Drift):** As noted in `openhands/openhands#15087`, comparing raw events misses loops when the LLM varies its `thought` monologue while emitting the identical tool call. Define canonical hashes ignoring volatile fields (`tool_call_id`, timestamps, thought strings):
   $$h_{\text{act}}(a_t) = \text{SHA256}\big(\text{tool\_name}(a_t) \;\|\; \text{canonical\_json}(\text{args}(a_t))\big)$$
   $$h_{\text{obs}}(o_t) = \text{SHA256}\big(\text{exit\_code}(o_t) \;\|\; \text{normalize\_whitespace\_and\_timestamps}(\text{stdout/stderr}(o_t))\big)$$
2. **The 5 OpenHands Stuck Patterns (`stuck_detector.py`):**
   - **Pattern 1 (Action-Observation Repeat):** $(h_{\text{act}}(a_t), h_{\text{obs}}(o_t))$ identical for $k \ge 4$ consecutive steps.
   - **Pattern 2 (Action-Error Repeat with Nudge Gate, PR `#4332`):** Same $h_{\text{act}}$ produces an error $k = 3$ times $\rightarrow$ inject environment `ActionErrorNudge` naming the repeated action and error; if streak reaches $k = 4$ (`> threshold`), transition to hard `STUCK` (guarding via `_last_nudged_error_event_id` so empty thoughts do not re-trigger duplicate nudges).
   - **Pattern 3 (Agent Monologue):** $\ge 3$ consecutive `MessageAction` / thought-only steps with zero tool calls (`Overthinking` in `TACT`, `arXiv:2605.05980`).
   - **Pattern 4 (Alternating Ping-Pong Loop):** $(a_{t}, o_{t}) = (a_{t-2}, o_{t-2})$ and $(a_{t-1}, o_{t-1}) = (a_{t-3}, o_{t-3})$ over $\ge 6$ steps (e.g., edit A $\rightarrow$ test fails $\rightarrow$ revert A $\rightarrow$ test fails).
   - **Pattern 5 (Context Window Condensation Loop):** $\ge 10$ context-condensation events without task progress.
3. **IronCurtain 2$\times$2 Progress Matrix + Per-File Edit Cap:**
   At each step $t$, compare approach similarity $\text{sim}(a_t, a_{<t})$ and outcome similarity $\text{sim}(o_t, o_{<t})$:
   | Approach vs. Outcome | **New Outcome** ($h_{\text{obs}} \notin H_{\text{obs}}$) | **Repeated Outcome** ($h_{\text{obs}} \in H_{\text{obs}}$) |
   | :--- | :--- | :--- |
   | **New Approach** ($h_{\text{act}} \notin H_{\text{act}}$) | **Full Progress** (reset streaks) | **Stuck** (`stuck_streak += 1`; Warn at 5, Block/Replan at 8) |
   | **Repeated Approach** ($h_{\text{act}} \in H_{\text{act}}$) | **World Changed** (transient/polling) | **Full Stagnation** (`stag_streak += 1`; Warn at 3, Block at 5) |
   Additionally, track `file_edit_count[filepath]` (`LoopDetectionMiddleware`): if the same file is edited $\ge N_{\text{edit}} = 5$ times with net test pass count non-increasing, trigger a Replan interrupt.

#### Tier C2: Process-Centric Phase Grammar & Graph Monitor (`LivePlan`, `arXiv:2608.06701`)
Represent the trajectory online as:
* **`Graphectory` $G_t = (V_t, E_t)$:** Directed graph where nodes are distinct canonicalized actions/thoughts and edges are execution transitions $(v_{t-1} \to v_t)$.
* **`Langutory` $L_t \in \Sigma^*$:** Sequence of abstract problem-solving phases mapped deterministically from tool calls:
  $$\Sigma = \{\texttt{Navigate (N)}, \texttt{Reproduce (R)}, \texttt{Patch (P)}, \texttt{Validate (V)}, \texttt{Submit (S)}\}$$
* **10 Deterministic Drift Rules (`Table I`, `arXiv:2608.06701`):**
  - **Blocking Drifts (Intercept & Block Action Before Execution):**
    1. *Premature Patching:* Transition to $\texttt{P}$ before any $\texttt{N}$ or $\texttt{R}$.
    2. *Skip Patching:* Transition to $\texttt{S}$ with empty `git diff`.
    3. *Skip Validation:* Transition $\texttt{P} \to \texttt{S}$ without an intervening $\texttt{V}$ after the last edit.
    4. *Action/Thought Oscillation:* Cycle of back-edges in $G_t$ of length $\le 3$ repeated $\ge 2$ times.
  - **Non-Blocking Drifts (Allow Action + Inject Advisor Steering):**
    5. *Prolonged Phase Stagnation:* Run-length of identical phase in $L_t$ exceeds phase threshold $\tau_{\text{phase}}$ (e.g., $>12$ consecutive $\texttt{N}$ steps without $\texttt{R}$ or $\texttt{P}$).
    6. *Action Revisit:* Single back-edge in $G_t$ revisiting an already-inspected file/line range without intermediate state modification.

#### Tier C3: Continuous Telemetry CUSUM Change-Point Detector (`arXiv:2608.02464`)
To catch subtle multi-step drift (where actions are not syntactically identical), extract a step telemetry vector $\mathbf{x}_t = [\mathbf{e}_t ; \mathbf{u}_t ; \mathbf{m}_t ; \mathbf{g}_t] \in \mathbb{R}^d$ at each step $t$:
* $\mathbf{e}_t$: Semantic embedding of step output (or cosine drift $\Delta e_t = 1 - \cos(\mathbf{e}_t, \mathbf{e}_{\text{goal}})$).
* $\mathbf{u}_t$: Token-level uncertainty aggregates (mean/max token entropy, logprob variance).
* $\mathbf{m}_t$: Action metadata (tool latency, exit code, output byte length, schema validity bit).
* $\mathbf{g}_t$: Content-grounding channel (fraction of numbers/identifiers in agent thought grounded in prior tool outputs).

For each channel $c \in \{e, u, m, g\}$, maintain a one-sided **CUSUM (Cumulative Sum) sequential change-point statistic** (`Eq. 4–6`, `arXiv:2608.02464`):
$$S_t^{(c)} = \max\Big(0, \; S_{t-1}^{(c)} + z\big(q_t^{(c)}\big) - \kappa\Big), \quad S_0^{(c)} = 0$$
where $z(q_t^{(c)})$ is the robust-$z$ normalized one-step prediction surprise and $\kappa = 0.5$ is the reference drift allowance. The global step alarm score takes the **channel-wise maximum** (avoiding dilution of a single-channel spike across $d$ dimensions):
$$s_t = \max_{c \in \{e, u, m, g\}} S_t^{(c)}, \quad \text{Alarm if } s_t > \theta_{1-\beta}$$
When $s_t > \theta_{1-\beta}$, the harness **rolls back the agent state to the last verified fact-gathering checkpoint** and injects a replanning directive, recovering **45% of failing trajectories** (`arXiv:2608.02464`).

---

## Pillar D: Formal Decision Policy for Continue / Re-Plan / Stop / Ping Human

### 1. Core Empirical Claims & Citations
* **Why Verbalized Confidence Must Never Gate Decisions:** `arXiv:2601.07767` proves a structural dissociation between verbalized confidence and action selection in LLMs; infrastructure-level gating over external signals (test outcomes, verifier entropy, CUSUM surprise, critic score) is mandatory ([Zylos Production Calibration Research](https://zylos.ai/research/2026-04-18-llm-calibration-uncertainty-production-agents/)).
* **Trajectory Critic Value Function (`OpenHands Critic`, `arXiv:2603.03800`):** OpenHands trains a trajectory critic via discounted Monte Carlo returns $r^*_t = \gamma r^*_{t+1}$ ($\gamma = 0.99$) anchored on terminal unit-test pass/fail $r^*_T \in \{0, 1\}$. Using the critic for early stopping, iterative refinement, and best-of-$K$ reranking boosts SWE-bench Verified resolution from **60.6% (1 attempt) to 66.4% (5 attempts)** ([OpenHands SWE-bench SOTA Blog](https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model)).
* **Dual-Process Uncertainty Propagation (`AUQ`, `arXiv:2601.15703`):** Propagating step-level uncertainty cues in memory (System 1) and triggering selective reflection only when accumulated uncertainty crosses a threshold (System 2) prevents the *"Spiral of Hallucination"* and lifts success rates by **+10.7% on ALFWorld and +13.6% on WebShop** without retraining.
* **Budgeted Replanning with Cooldown & Commit Windows (`BRACE`, `arXiv:2608.01428`):** Unconstrained replanning causes heavy-tailed latency spikes and "replanning churn" where agents repeatedly discard new plans before testing them. Enforcing a deterministic stability gate with a cooldown window $\delta$ and plan-commit window $\omega$ reduces replanning token consumption by **62–92%** and deadline violations from **85.5–100% down to 4.6–50%**.
* **Disagreement-Guided Minimal Human Escalation (`JuryFlow`, `arXiv:2609.40103`; `KnowNo`, `arXiv:2601.06223`; `Minds and Machines 2026`, `doi:10.1007/s11023-026-09783-y`):** Rather than dumping a failed trace on a human, agents should escalate **only when Value of Information (VoI) exceeds interruption cost**—specifically on high-entropy contested claims (`JuryFlow`), irreversible/high-risk actions, or unresolvable intent ambiguity (`TiCoder`).

### 2. Concrete Mechanism: The 4-Action Controller Policy $\pi(\sigma_t)$

At each step $t$, the Orchestrator maintains a deterministic state tuple:
$$\sigma_t = \big(V_{\text{det}}(t), \; \hat{\mathbf{y}}_{\text{GM}}(t), \; H_{\max}(t), \; s_t^{\text{CUSUM}}, \; \text{drift}_t, \; \Delta_t, \; \kappa_t, \; r_{\text{replan}}, \; B_{\text{rem}}\big)$$
where:
* $V_{\text{det}}(t) \in \{0, 1\}$: 1 iff all deterministic DoD tests $T_{\text{DoD}}$, regression tests $T_{\text{orig}}$, scope guards, and numeric grounding checks pass.
* $\hat{\mathbf{y}}_{\text{GM}}(t) \in [0, 1]^d$: `RoPoLL` geometric-median score vector from the heterogeneous verifier panel.
* $H_{\max}(t) = \max_m H(c_m)$: Maximum claim-level verdict entropy across the `JuryFlow` disagreement graph.
* $s_t^{\text{CUSUM}}$: Multi-channel telemetry CUSUM drift score; $\text{drift}_t$: `LivePlan` / `StuckDetector` signal.
* $\Delta_t, \kappa_t$: Steps since last replan ($\Delta_t$) and steps since last plan update ($\kappa_t$) from `BRACE` (`arXiv:2608.01428`).
* $r_{\text{replan}} \in \{0, \dots, R_{\max}\}$: Number of replanning cycles used so far (default $R_{\max} = 3$).
* $B_{\text{rem}}$: Remaining token/time budget.

#### The Decision Rules:

1. **`STOP (DONE — VERIFIED SUCCESS)`:**
   $$\text{Trigger if: } V_{\text{det}}(t) = 1 \;\wedge\; \min_k \hat{y}_{\text{GM}, k}(t) \ge \tau_{\text{pass}} \;\wedge\; H_{\max}(t) \le \tau_H \;\wedge\; \neg\text{SkipValidation}(L_t)$$
   *Action:* Emit immutable verification receipt (test logs, `claimcheck` back-translation conformance score, `RoPoLL` panel scores, `git diff` scope proof) and terminate with status `COMPLETED_VERIFIED`.

2. **`PING HUMAN (TARGETED STRUCTURAL ESCALATION — RARE)`:**
   Escalate to human **if and only if** the expected Value of Information $\text{VoI}(q) = \mathbb{E}[\Delta \text{Utility} \mid \text{Answer}(q)] > C_{\text{interrupt}}$, which occurs in exactly three conditions:
   - **Condition H1 (Initial Intent Ambiguity):** During Stage A3 (`TiCoder` / `Monty`), two candidate specs $\psi_1, \psi_2$ both have high conformance $\bar{c} \ge 0.6$ to the 1-line prompt $g$ but produce contradictory outputs on discriminative test input $x_{\text{edge}}$. *Ping format:* Present the single input-output question: `"For input X, should the output be Y1 or Y2?"`
   - **Condition H2 (Persistent Verifier Panel Split):** $V_{\text{det}}(t) = 1$, but the heterogeneous `RoPoLL` judge panel exhibits high claim-level entropy $H(c^*) > \tau_H$ after 1 round of evidence-grounded focal re-evaluation (`JuryFlow`, `arXiv:2609.40103`). *Ping format:* Surface only the single highest-entropy atomic claim $c^*$ for binary human resolution.
   - **Condition H3 (High-Risk / Irreversible Boundary or Exhausted Replans):** The next action touches an out-of-scope invariant or irreversible external system (`Minds and Machines 2026`), OR $r_{\text{replan}} = R_{\max}$ and the task remains unsolved on a blocking ambiguity.

3. **`RE-PLAN (ROLLBACK + ADVISOR STEERING)`:**
   Apply the `BRACE` stability gate (`Eq. 1`, `arXiv:2608.01428`) with failure-aware override:
   $$u_t = \mathbb{I}\Big[\big(\text{drift}_t \in \text{Blocking} \;\vee\; s_t^{\text{CUSUM}} > \theta_{1-\beta}\big) \;\vee\; \big(\text{drift}_t \in \text{NonBlocking} \;\wedge\; \Delta_t \ge \delta \;\wedge\; \kappa_t \ge \omega\big)\Big]$$
   $$\text{Trigger if: } u_t = 1 \;\wedge\; r_{\text{replan}} < R_{\max} \;\wedge\; B_{\text{rem}} > B_{\min}$$
   *Action:*
   - Increment $r_{\text{replan}} \leftarrow r_{\text{replan}} + 1$; reset $\Delta_t \leftarrow 0, \kappa_t \leftarrow 0$.
   - **Rollback (`arXiv:2608.02464` & OpenHands `agent_controller.py`):** Revert working tree / memory to the last clean checkpoint before the loop/drift onset $\hat{\tau}$, pruning the polluted looping turns from active context (`E-RECAP`, `arXiv:2608.01428`) while recording the failed hypothesis in an episodic "Negative Memory / Anti-Pattern" table (`arXiv:2608.06811`).
   - **Consult Heterogeneous `Advisor` LLM (`LivePlan`, `arXiv:2608.06701`):** Using high reasoning budget ("Reasoning Sandwich", [LangChain Harness Blog](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)), generate a single high-level next-step steering directive that explicitly forbids the failed action fingerprint $h_{\text{act}}$.

4. **`STOP (GRACEFUL ABORT — BOUNDED FAILURE)`:**
   $$\text{Trigger if: } (r_{\text{replan}} \ge R_{\max} \;\vee\; B_{\text{rem}} \le B_{\min}) \;\wedge\; V_{\text{det}}(t) = 0 \;\wedge\; \text{Human Escalation Disabled/Timed Out}$$
   *Action:* Roll back broken edits, output a structured `TaskOutcome` (`openhands/software-agent-sdk#4479`) detailing passing vs. failing DoD assertions, approaches attempted, root-cause blocker, and exact reproduction command. Never claim false success.

5. **`CONTINUE (EXECUTE NEXT STEP)`:**
   $$\text{Trigger if: } V_{\text{det}}(t) = 0 \;\wedge\; u_t = 0 \;\wedge\; B_{\text{rem}} > B_{\min}$$
   *Action:* Proceed with the next planned tool call along the current trajectory.

---

## Contrarian Views, Failure Modes & Mitigations

| Failure Mode / Contrarian Finding | Empirical Evidence & Citation | Concrete Mitigation in Our Architecture |
| :--- | :--- | :--- |
| **1. Specification Gaming / Reward Hacking (Trivial Tests & Narrow Specs):** Agents given autonomy to write their own DoD write tautological tests (`assert True`), mock out the function under test, or write weak postconditions (e.g., `r*r <= N` satisfied by `r=0`) that pass verification 100% of the time while failing user intent. | In `claimcheck` (`arXiv:2610.17358`), **100% of defective Dafny specs still pass the formal Dafny verifier**. In `Lahiri et al.` (`arXiv:2603.17150`), even expert-approved specs were satisfied by empty lists `[]`. | **3-Way Separation of Duties + Mutation Testing:** (1) Spec Agent writes tests *before* code; (2) Implementation Agent is **blocked by `PreToolUse` Scope Guard** from editing test files; (3) `claimcheck` blind back-translation + AST anti-mock check + **Mutation Completeness Gate** ($\ge 90\%$ mutant kill rate) verifies the tests themselves aren't trivial. |
| **2. Multi-Agent Debate (MAD) Can Amplify Bias & Degrade Accuracy:** Contrarian to popular belief, having multiple LLM judges debate and reach consensus often *worsens* evaluation accuracy compared to a single judge due to **bandwagon bias, verbosity bias, and role asymmetry**. | `Beyond Consensus` (`arXiv:2608.30373`) and `Judging with Many Minds` (`arXiv:2505.19477`) show single-judge baselines beat consensus MAD on subjective rubrics because dominant personas pull weaker judges into false agreement. | **Independent Blind Scoring + Geometric Median (`RoPoLL`), Not Freeform Debate:** Judges score atomic claims *independently without seeing each other's scores*, aggregated via `RoPoLL` Geometric Median (`arXiv:2606.30931`). Disagreement is resolved via evidence retrieval (`JuryFlow`, `arXiv:2609.40103`), not social persuasion. |
| **3. Correlated Errors Across Judges & Unbounded Arithmetic Mean Bias:** Even a panel of judges fails if they share pre-training priors or if arithmetic averaging (`PoLL`) is used when one model collapses or refuses. | `RoPoLL` (`arXiv:2606.30931`) measures empirical error correlation $\bar{\gamma}_W \in [0.45, 0.53]$ across judge panels and proves PoLL has breakdown point $0$. `JuryFlow` (`arXiv:2609.40103`) warns correlated judges reach low-entropy wrong consensus. | **Cross-Family Model Diversity on Crusoe + Execution Grounding:** Pair distinct model families on Crusoe (e.g., Qwen + Llama + DeepSeek/Mistral), aggregate with Weiszfeld Geometric Median (breakdown point $1/2$), and subordinate all LLM opinions to **Layer 1 deterministic execution checks** (`arXiv:2608.02464`). |
| **4. Loop Detectors Triggering False Positives on Legitimate Polling / Multi-Hunk Edits, or Creating Detector Feedback Loops:** Strict loop detectors kill legitimate workflows (e.g., polling a build job or editing 6 files in a refactor) or inject warning messages that themselves cause stagnation loops. | OpenHands Issue [`#762`](https://github.com/openhands/software-agent-sdk/issues/762) (polling killed at 4 calls), OpenHands PR [`#4332`](https://github.com/openhands/software-agent-sdk/issues/4332) (duplicate nudges on frozen streaks), and [DEV.to Boucle Study](https://dev.to/boucle2026/how-to-tell-if-your-ai-agent-is-stuck-with-real-data-from-220-loops-4d4h) (loop-silence detector caused its own infinite signal loop). | **Distinguish Blocking vs. Non-Blocking Drifts (`LivePlan`) + World-Changed Exemption (`IronCurtain`):** If $h_{\text{act}}$ repeats but $h_{\text{obs}}$ changes (e.g., build progress), classify as *World Changed*, not stagnation. Guard nudges with `_last_nudged_error_event_id` so each streak is nudged at most once before rollback. |
| **5. Over-Triggering Replanning ("Replanning Churn") & Context Bloat:** Replanning on every minor error explodes context length, causes heavy-tail latency, and abandons viable plans prematurely. | `BRACE` (`arXiv:2608.01428`) shows unconstrained replanning yields **85.5–100% deadline SLO violations**; `TACT` (`arXiv:2605.05980`) shows *overthinking* and *overacting* degrade long coding trajectories. | **Cooldown ($\delta$) & Plan-Commit ($\omega$) Windows + Context Rollback:** Enforce `BRACE` stability gate $u_t = \mathbb{I}[\tau_t \wedge (\Delta_t \ge \delta) \wedge (\kappa_t \ge \omega)]$ and truncate failed loop turns on rollback so context size stays bounded. |
| **6. Heavy Harness Guardrails Can Over-Constrain Frontier Models:** Overly rigid workflow harnesses built for weaker models can bottleneck stronger models or cause timeouts when max reasoning is forced on every step. | [UnderstandingData (Oct 2026)](https://understandingdata.com/posts/throw-away-your-harness-when-models-improve/) and [LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering) (running `xhigh` reasoning on every step dropped Terminal Bench score from `63.6%` to `53.9%` due to timeouts; `xhigh-high-xhigh` "Reasoning Sandwich" reached `66.5%`). | **Reasoning Sandwich + Non-Intrusive Zero-Token Monitors:** Spend high reasoning compute (`xhigh`) *only* at Spec Compilation (Pillar A), Replanning Advisor (Pillar C), and Final Verification (Pillar B), while keeping mid-episode execution fast (`high`/`medium`) and monitored by $200\;\mu\text{s}$ deterministic/CUSUM watchdogs. |

---

## Complete Inventory of Searched, Inspected & Scraped Sources

### A. Academic Papers Inspected / Read via `firecrawl research`
1. **`arxiv:2610.17358`** — *claimcheck: Measuring and Improving Specification Faithfulness* (Amster et al., Harvard / UPenn / Midspiral, Oct 2026). **Quality:** 5/5 — Landmark benchmark (3,234 rows across Dafny, Lean 4, Isabelle, Rocq) and blind back-translation algorithm proving +8.2 to +9.8 macro recall gain in catching weak/unfaithful specs that still pass formal verifiers.
2. **`arxiv:2607.13303`** — *Faithful Autoformalization of Natural Language Assertions (Monty)* (Liu, Parthasarathy, Murali, UW-Madison / UIUC, Jul 2026). **Quality:** 5/5 — Introduces bidirectional clausal coverage conformance scoring, version-space test-validity filtering, and active learning disambiguation (+20 points precision across 541 Java assertion tasks).
3. **`arxiv:2606.30931`** — *RoPoLL: Robust Panel of LLM Judges* (Acharya, Pan, Verkhovsky, AWS, Jun 2026). **Quality:** 5/5 — Formalizes LLM juries under Huber contamination, proves standard PoLL has unbounded bias, and introduces Geometric Median aggregation via Weiszfeld iteration (breakdown point 1/2, 18$\times$ parameter efficiency over 675B single judge).
4. **`arxiv:2609.40103`** — *JuryFlow: Disagreement-Guided Human-in-the-Loop Multi-Agent Evaluation* (Yang, Yu, Ding, Sep 2026). **Quality:** 5/5 — Decomposes outputs into atomic claims, constructs a verdict-entropy disagreement graph, and uses minimal human structural guidance + closed-loop rubric induction.
5. **`arxiv:2601.05111`** — *Agent-as-a-Judge* (You et al., Jan 2026). **Quality:** 5/5 — Comprehensive taxonomy of tool-augmented, planning-driven verifier agents, rubric discovery (`EvalAgents`, `OnlineRubrics`), and reward-hacking detection.
6. **`arxiv:2608.06701`** — *Online Monitoring and Corrective Steering of Programming Agents (LivePlan)* (Liu et al., UIUC / IBM Research, Aug 2026). **Quality:** 5/5 — Decouples millisecond rule-based drift detection (`Graphectory` + `Langutory`, 10 blocking/non-blocking drift signals) from LLM advising on SWE-agent (+15.2% max / +9.9% mean resolution on SWE-bench Verified & Pro at \$0.08/instance).
7. **`arxiv:2608.02464`** — *Real-Time Detection and Repair of LLM Agent Failures* (Dubey, Aug 2026). **Quality:** 5/5 — Validates a 200 $\mu$s one-class Echo State Network + per-channel CUSUM monitor and a 0%-false-positive deterministic grounding/coverage verifier across 2,823 episodes, lifting task success from 52% to 73% via rollback repair.
8. **`arxiv:2610.12375`** — *OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport* (Barazandeh et al., Oct 2026). **Quality:** 5/5 — 1 ms/step warm-started Fused Gromov-Wasserstein alignment over execution DAGs; saves 18% compute on SWE-bench with 83% abort accuracy.
9. **`arxiv:2608.01428`** — *When Replanning Becomes the Bottleneck: Budgeted Replanning for Embodied Agents (BRACE)* (Liu et al., HKUST-GZ, Aug 2026). **Quality:** 5/5 — Formalizes replanning as a budgeted control loop with cooldown ($\delta$) and commit ($\omega$) stability gates plus E-RECAP token pruning (62–92% token reduction).

### B. Additional Papers Retrieved in `firecrawl research search-papers` & `firecrawl search`
10. **`arxiv:2603.17150`** — *Intent Formalization: A Grand Challenge for Reliable Coding in the Age of AI Agents* (Lahiri, Microsoft Research RiSE, Mar 2026). **Quality:** 5/5 — Foundational treatise defining the intent gap, soundness/completeness mutation metrics for specs, and `TiCoder` interactive ambiguity resolution.
11. **`arxiv:2603.16348`** — *Prompts Blend Requirements and Solutions: From Intent to Executable Specifications* (Grove, OpenAI, Mar 2026). **Quality:** 4/5 — Frames prompts as executable specifications and contracts.
12. **`arxiv:2604.10392`** — *VeriSpecGen: Intent-aligned Formal Specification Synthesis via Traceable Refinement* (Apr 2026). **Quality:** 4/5 — Requirement-level attribution and localized repair for formal specification synthesis in Lean.
13. **`arxiv:2603.21263`** — *From Natural Language to Executable Properties for Property-based Testing of Mobile Apps (iPBT)* (Mar 2026). **Quality:** 4/5 — Decomposes NL goals into semantic grounding and executable property-based tests.
14. **`arxiv:2511.17977`** — *Synthesizing Precise Protocol Specs from Natural Language for Effective Test Generation* (Nov 2025). **Quality:** 4/5 — Two-stage LLM extraction of protocol elements for automated test generation.
15. **`arxiv:2602.04892`** — *Doc2Spec: Synthesizing Formal Programming Specifications from Natural Language via Grammar Induction* (Feb 2026). **Quality:** 4/5 — Multi-agent grammar induction from NL rules to guide specification generation.
16. **`arxiv:2504.07244`** — *Acceptance Test Generation with Large Language Models: An Industrial Case Study* (Apr 2025). **Quality:** 4/5 — Two-step NL user story $\to$ Gherkin scenario $\to$ executable Cypress test pipeline.
17. **`arxiv:2404.18796`** — *Replacing Judges with Juries: Evaluating LLM Generations with a Panel of Diverse Models (PoLL)* (Verga et al., Cohere, Apr 2024). **Quality:** 5/5 — Seminal paper showing heterogeneous small-model juries outperform single large judges and reduce intra-model bias.
18. **`arxiv:2508.02994`** — *When AIs Judge AIs: The Rise of Agent-as-a-Judge Evaluation for LLMs* (Aug 2025). **Quality:** 4/5 — Reviews evolution from single-model judges to tool-using multi-agent evaluators and documents shared-model bias.
19. **`arxiv:2505.19477`** — *Judging with Many Minds: Do More Perspectives Mean Less Prejudice? On Bias Amplifications and Resistance in Multi-Agent Based LLM-as-Judge* (May 2025). **Quality:** 5/5 — Crucial contrarian study showing multi-agent debate amplifies position, verbosity, CoT, and bandwagon biases unless carefully structured.
20. **`arxiv:2608.30373`** — *Beyond Consensus: Downward Bias and Role Asymmetry in Multi-Agent LLM Judges for Subjective Evaluation* (Aug 2026). **Quality:** 5/5 — Demonstrates that forced consensus in multi-agent debate introduces downward bias and role asymmetry, underperforming calibrated independent judges.
21. **`arxiv:2609.12002`** — *Can We Trust LLM Judges: A Study of Capability-Dependent Biases and Multi-Judge Ensemble for Bias Calibration* (Sep 2026). **Quality:** 4/5 — Quantifies correlation between judge task accuracy ($r \ge 0.90$) and directional bias ($r \le -0.83$) across 36 pairs.
22. **`arxiv:2510.08145`** — *Mitigating Judgment Preference Bias in Large Language Models through Group-Based Polling (Genii)* (Oct 2025). **Quality:** 4/5 — Unsupervised multi-agent polling optimization to reduce self-preference bias.
23. **`arxiv:2603.00993`** — *CollabEval: Enhancing LLM-as-a-Judge via Multi-Agent Collaboration* (Mar 2026). **Quality:** 4/5 — Three-phase collaborative evaluation protocol.
24. **`arxiv:2603.28488`** — *PROClaim: Courtroom-Style Multi-Agent Debate with Progressive RAG and Role-Switching* (Mar 2026). **Quality:** 4/5 — Adversarial Plaintiff/Defense/Judge verification with role-switching to mitigate positional bias.
25. **`arxiv:2506.18824`** — *Understanding Software Engineering Agents: A Study of Thought-Action-Result Trajectories* (Jun 2025). **Quality:** 5/5 — Empirical study of RepairAgent, AutoCodeRover, and OpenHands showing failing OpenHands runs hit 100-step caps and burn 1.2M tokens.
26. **`arxiv:2602.17037`** — *Wink: Recovering from Misbehaviors in Coding Agents* (Feb 2026). **Quality:** 4/5 — Taxonomy of coding agent misbehaviors (instruction drift, loops, tool errors) and automated recovery.
27. **`arxiv:2605.05980`** — *TACT: Mitigating Overthinking and Overacting in Coding Agents via Activation Steering* (May 2026). **Quality:** 4/5 — Defines agent drift as *overthinking* (reasoning loops without new evidence) and *overacting* (tool calls without integrating observations).
28. **`arxiv:2610.19376`** — *DeLoop: Repeated Actions as Self-Supervision for Long-Horizon Agents* (Oct 2026). **Quality:** 5/5 — Shows context compression triggers action-observation loops in Qwen, Llama, and Gemini agents.
29. **`arxiv:2608.06811`** — *Coupling Planning with Episodic Memory in LLM Agents for Software Issue Resolution* (Aug 2026). **Quality:** 4/5 — Addresses stale evidence, repeated failed edits, and unverified completion claims via coupled episodic memory.
30. **`arxiv:2610.05241`** — *StateWise: Diagnosing and Repairing Persistent Operational State Before Agent Actions* (Oct 2026). **Quality:** 4/5 — Audits coding-agent trajectories for corrupted persistent state reuse.
31. **`arxiv:2608.14109`** — *A Graph-Based Reinforcement Learning Framework for Structured Drift Diagnosis and Recovery in Autonomous LLM Agents* (Aug 2026). **Quality:** 4/5 — Plug-and-play graph-based drift diagnosis and recovery policy.
32. **`arxiv:2606.05806`** — *When Tools Fail: Benchmarking Dynamic Replanning and Anomaly Recovery in LLM Agents (ToolMaze)* (Jun 2026). **Quality:** 4/5 — 2$\times$2 taxonomy of tool perturbations (explicit/implicit, transient/permanent) showing sharp drops under implicit semantic failures.
33. **`arxiv:2601.07767`** — *Are LLM Decisions Faithful to Verbal Confidence?* (Jan 2026). **Quality:** 5/5 — Proves LLMs fail to use their own verbalized uncertainty to guide autonomous action decisions.
34. **`arxiv:2601.15703`** — *Agentic Uncertainty Quantification (AUQ)* (Zhang et al., Salesforce Research, Jan 2026). **Quality:** 5/5 — Dual-process uncertainty memory (System 1) and threshold-triggered reflection (System 2) preventing the "Spiral of Hallucination".
35. **`arxiv:2604.07036`** — *ReDAct: Uncertainty-Aware Deferral for LLM Agents* (Apr 2026). **Quality:** 5/5 — Deferring only 15% of uncertain small-model decisions to a large model matches full large-model performance.
36. **`arxiv:2601.06223`** — *Toward Safe and Responsible AI Agents* (Jan 2026). **Quality:** 4/5 — Discusses `KnowNo` conformal prediction for formal task-success guarantees with minimal human intervention and abort states.
37. **`doi:10.1007/s11023-026-09783-y`** — *On Controllability in Agentic AI: A Survey* (Minds and Machines, 2026, `https://link.springer.com/article/10.1007/s11023-026-09783-y`). **Quality:** 4/5 — Formalizes Agent-in-the-Loop (AITL) vs. Human-in-the-Loop (HITL) switching criteria based on uncertainty, reversibility, safety criticality, and intent ambiguity.
38. **`pii:S2590005626004509`** — *Knowing when to escalate: Prompt-based uncertainty quantification for selective automation* (ScienceDirect, 2026, `https://www.sciencedirect.com/science/article/pii/S2590005626004509`). **Quality:** 4/5 — Shows UQ's primary value in bounded-accuracy regimes is selective escalation rather than full unverified automation.

### C. Web URLs Scraped via `firecrawl scrape` (1 URL at a time) & Developer Index Hits
39. **`https://docs.openhands.dev/sdk/guides/agent-stuck-detector`** (Scraped to `scrape_1_openhands_stuck_detector.md`). **Quality:** 5/5 — Official OpenHands SDK documentation detailing the 5 deterministic stuck patterns and semantic event comparison (`_event_eq`).
40. **`https://www.openhands.dev/blog/20260506-the-verification-stack`** (Scraped to `scrape_2_openhands_verification_stack.md`). **Quality:** 5/5 — Production architecture and 6-month empirical evaluation (900+ PRs, 58% faster merge time, +25% test coverage) of Layer 1 Critic Model + Layer 2 Code Review & 4-phase QA Agent + `/iterate` loop.
41. **`https://zylos.ai/research/2026-04-18-llm-calibration-uncertainty-production-agents/`** (Scraped to `scrape_3_zylos_uncertainty_calibration.md`). **Quality:** 5/5 — Comprehensive synthesis of RLHF preference collapse, verbalization gap, Semantic Entropy, Conformal Prediction, AUQ, ReDAct, and confidence-gated escalation.
42. **`https://risemsr.github.io/blog/2026-03-05-shuvendu-intent-formalization/`** (Scraped to `scrape_4_msr_intent_formalization.md`). **Quality:** 5/5 — Microsoft Research RiSE deep dive on intent formalization spectrum (tests $\to$ code contracts $\to$ logical contracts $\to$ DSLs), soundness/completeness mutation metrics, and `TiCoder`.
43. **`https://understandingdata.com/posts/prompt-contracts-specification-before-code/`** (Scraped to `scrape_5_prompt_contracts.md`). **Quality:** 5/5 — Concrete 8-section Prompt Contract specification, 5C acceptance criteria rubric, and deterministic `PreToolUse` (Scope Guard), `Stop` (Self-Verification), and `PostToolUse` hooks.
44. **`https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering`** (Scraped to `scrape_6_langchain_harness_engineering.md`). **Quality:** 5/5 — Empirical report showing harness-only changes (`PreCompletionChecklistMiddleware`, `LoopDetectionMiddleware`, `LocalContextMiddleware`, and `xhigh-high-xhigh` "Reasoning Sandwich") lifted `gpt-5.2-codex` from 52.8% to 66.5% (Top 5) on Terminal Bench 2.0.
45. **`https://github.com/openhands/software-agent-sdk/issues/4332`** (Retrieved via `firecrawl developer`). **Quality:** 5/5 — PR detailing `StuckDetector.get_action_error_nudge()`, `_check_stuck_or_nudge()`, and `_last_nudged_error_event_id` guard before hard `STUCK` termination.
46. **`https://github.com/openhands/openhands/issues/15087`** (Retrieved via `firecrawl developer`). **Quality:** 5/5 — Engineering discussion on deterministic trajectory hashing vs. LLM-prompted loop detection and stripping thought-monologue drift from action payload fingerprints.
47. **`https://github.com/provos/ironcurtain/blob/d51a3467cbda6a2e94cf04e885e8ae1abdd0f6be/docs/designs/loop-detection.md`** (Retrieved via `firecrawl developer`). **Quality:** 5/5 — Two-Layer Loop Detection & Circuit Breaker design introducing the 2$\times$2 Progress Matrix (New/Repeated Approach $\times$ New/Repeated Outcome).
48. **`https://github.com/pydantic/pydantic-ai/issues/9008`** (Retrieved via `firecrawl developer`). **Quality:** 4/5 — Cross-framework comparison of loop detection and recovery options across OpenHands, Goose (`RepetitionInspector`), and Pydantic-AI (`DetectLoops`).
49. **`https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model`** (Retrieved via `firecrawl developer`). **Quality:** 5/5 — Details discounted reward training ($r^*_t = \gamma r^*_{t+1}, \gamma=0.99$) of the OpenHands Critic model and inference-time scaling gains (60.6% $\to$ 66.4%).
50. **`https://stackoverflow.blog/2026/08/21/dispatches-from-o-reilly-the-right-amount-of-spec-for-agentic-development/`** (Retrieved via `firecrawl search`). **Quality:** 4/5 — Explains why cheap agent implementation makes boundary/invariant contracts and verification evidence the primary engineering bottleneck.
51. **`https://neurips.cc/virtual/2024/106181`** — *Self-Preference Bias in LLM-as-a-Judge* (NeurIPS 2024, retrieved via `firecrawl search`). **Quality:** 5/5 — Establishes that LLM self-preference bias is rooted in lower perplexity of outputs matching the judge's own training distribution.
52. **`https://dev.to/boucle2026/how-to-tell-if-your-ai-agent-is-stuck-with-real-data-from-220-loops-4d4h`** (Retrieved via `firecrawl search`). **Quality:** 4/5 — Empirical telemetry study over 220 autonomous 15-minute agent loops showing 45% stagnation rate and the danger of detector-induced feedback loops.
