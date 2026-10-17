[TMLS is a Registered Partner in the OpenAI Partner Network.Read more](https://www.tmls.nyc/news/openai-partner-network)

With your permission, we use Google Analytics to see how the site is used. It sets cookies. [Read the cookie policy](https://www.tmls.nyc/cookies).

AllowDecline

[Skip to content](https://www.tmls.nyc/research/context-engineering#research-content)

[![](https://www.tmls.nyc/next-assets/brand/logo/assets/v5/tmls-symbol-human-black-small.svg)![](https://www.tmls.nyc/next-assets/brand/logo/assets/v5/tmls-symbol-human-white-small.svg)](https://www.tmls.nyc/) [Company](https://www.tmls.nyc/about) [Products](https://www.tmls.nyc/products) [Research](https://www.tmls.nyc/research) [News](https://www.tmls.nyc/news) [Open source](https://www.tmls.nyc/open-source) [Contact](https://www.tmls.nyc/contact)

[All research](https://www.tmls.nyc/research)

[All research](https://www.tmls.nyc/research)

Contents

01. [Executive summary](https://www.tmls.nyc/research/context-engineering#executive-summary)
02. [Introduction](https://www.tmls.nyc/research/context-engineering#introduction)
03. [The window as a resource](https://www.tmls.nyc/research/context-engineering#the-window-as-a-resource)
04. [How contexts fail](https://www.tmls.nyc/research/context-engineering#how-contexts-fail)
05. [The context engine](https://www.tmls.nyc/research/context-engineering#the-context-engine)
06. [System prompt altitude](https://www.tmls.nyc/research/context-engineering#system-prompt-altitude)
07. [Compression and compaction](https://www.tmls.nyc/research/context-engineering#compression-and-compaction)
08. [Memory](https://www.tmls.nyc/research/context-engineering#memory)
09. [Selection and retrieval](https://www.tmls.nyc/research/context-engineering#selection-and-retrieval)
10. [Isolation](https://www.tmls.nyc/research/context-engineering#isolation)
11. [Token and cache math](https://www.tmls.nyc/research/context-engineering#token-and-cache-math)
12. [Reference architecture](https://www.tmls.nyc/research/context-engineering#reference-architecture)
13. [Measuring context](https://www.tmls.nyc/research/context-engineering#measuring-context)
14. [Case studies](https://www.tmls.nyc/research/context-engineering#case-studies)
15. [Anti-patterns](https://www.tmls.nyc/research/context-engineering#anti-patterns)
16. [Open problems](https://www.tmls.nyc/research/context-engineering#open-problems)
17. [FAQ](https://www.tmls.nyc/research/context-engineering#faq)
18. [Glossary](https://www.tmls.nyc/research/context-engineering#glossary)
19. [References](https://www.tmls.nyc/research/context-engineering#references-heading)
20. [How to cite](https://www.tmls.nyc/research/context-engineering#how-to-cite)

# Context Engineering: Compaction, Memory, and Beating Context Drift

[AI Engineering](https://www.tmls.nyc/research?topic=AI%20Engineering#papers)TMLS AI ResearchJune 1, 202651 min read

Read the abstract

Most multi-step agent failures are context failures, not model failures. The agent does not lack the capability; it is handed the wrong working set: a window bloated with stale tool output, a poisoned fact that compounds on every reference, an instruction buried in the middle where the model cannot see it. Controlled studies now show accuracy declining steadily as input grows, even inside advertised limits and even when the relevant fact is present, an effect named context rot, and a long-standing position bias means information in the middle of a context is recalled worst of all. This paper treats the context window as the scarcest resource in an agent system and lays out a context engine to manage it. We adopt a four-operation frame, write, select, compress, isolate, and develop each into concrete patterns: anchored summarization and provider compaction APIs for compression, working, episodic, and semantic memory with operating-system-style virtual context for write and select, and sub-agent partitioning for isolation. We give a reference architecture with named components, a taxonomy of the four ways a context fails, and the token-budget and key-value-cache math that makes context engineering simultaneously a quality lever and a cost lever. We argue three positions: that the smallest sufficient context beats the largest possible one, that a bigger window is headroom rather than a fix, and that context quality must be measured directly, with length and position varied, or it will rot silently in production.

Abstract

Most multi-step agent failures are context failures, not model failures. The agent does not lack the capability; it is handed the wrong working set: a window bloated with stale tool output, a poisoned fact that compounds on every reference, an instruction buried in the middle where the model cannot see it. Controlled studies now show accuracy declining steadily as input grows, even inside advertised limits and even when the relevant fact is present, an effect named context rot, and a long-standing position bias means information in the middle of a context is recalled worst of all. This paper treats the context window as the scarcest resource in an agent system and lays out a context engine to manage it. We adopt a four-operation frame, write, select, compress, isolate, and develop each into concrete patterns: anchored summarization and provider compaction APIs for compression, working, episodic, and semantic memory with operating-system-style virtual context for write and select, and sub-agent partitioning for isolation. We give a reference architecture with named components, a taxonomy of the four ways a context fails, and the token-budget and key-value-cache math that makes context engineering simultaneously a quality lever and a cost lever. We argue three positions: that the smallest sufficient context beats the largest possible one, that a bigger window is headroom rather than a fix, and that context quality must be measured directly, with length and position varied, or it will rot silently in production.

On this page

Contents

01. [Executive summary](https://www.tmls.nyc/research/context-engineering#executive-summary)
02. [Introduction](https://www.tmls.nyc/research/context-engineering#introduction)
03. [The window as a resource](https://www.tmls.nyc/research/context-engineering#the-window-as-a-resource)
04. [How contexts fail](https://www.tmls.nyc/research/context-engineering#how-contexts-fail)
05. [The context engine](https://www.tmls.nyc/research/context-engineering#the-context-engine)
06. [System prompt altitude](https://www.tmls.nyc/research/context-engineering#system-prompt-altitude)
07. [Compression and compaction](https://www.tmls.nyc/research/context-engineering#compression-and-compaction)
08. [Memory](https://www.tmls.nyc/research/context-engineering#memory)
09. [Selection and retrieval](https://www.tmls.nyc/research/context-engineering#selection-and-retrieval)
10. [Isolation](https://www.tmls.nyc/research/context-engineering#isolation)
11. [Token and cache math](https://www.tmls.nyc/research/context-engineering#token-and-cache-math)
12. [Reference architecture](https://www.tmls.nyc/research/context-engineering#reference-architecture)
13. [Measuring context](https://www.tmls.nyc/research/context-engineering#measuring-context)
14. [Case studies](https://www.tmls.nyc/research/context-engineering#case-studies)
15. [Anti-patterns](https://www.tmls.nyc/research/context-engineering#anti-patterns)
16. [Open problems](https://www.tmls.nyc/research/context-engineering#open-problems)
17. [FAQ](https://www.tmls.nyc/research/context-engineering#faq)
18. [Glossary](https://www.tmls.nyc/research/context-engineering#glossary)
19. [References](https://www.tmls.nyc/research/context-engineering#references-heading)
20. [How to cite](https://www.tmls.nyc/research/context-engineering#how-to-cite)

## Executive summary for engineering leaders

When an agent that worked yesterday produces nonsense today, the reflex is to blame the model. The more useful diagnosis is almost always the context: the set of tokens the model was handed for that step. As agents run longer and call more tools, the window fills with tool output, intermediate reasoning, retrieved documents, and the residue of earlier turns, and somewhere in that accumulation the signal the model needs gets diluted, displaced, or contradicted. Anthropic states the shift plainly: as agents operate over longer horizons, the central skill is engineering the context, curating what enters the limited window at each step, not engineering a single prompt[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).

This is not a soft claim. Chroma's 2025 study evaluated eighteen leading models, including frontier Claude, GPT, Gemini, and Qwen variants, and found that performance degrades consistently as input length grows, across every experiment, and degrades faster when the needed information is not a literal match for the query[\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). The classic position-bias result is just as durable: models recall facts at the very start and very end of a context far better than facts in the middle, a U-shaped curve that worsens as the context lengthens[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle). A more recent analysis isolates length itself as the culprit, showing degradation even with perfect retrieval of the relevant passage[\[12\]](https://www.tmls.nyc/research/context-engineering#ref-context-length-hurts). The window is finite, and attention inside it is not uniform.

The good news is that context is engineerable. There is a small, repeatable set of operations, write context out to external memory, select the right slice back in, compress what must stay, and isolate subtasks into their own windows, that together keep the working set small, fresh, and uncontradicted [\[6\]](https://www.tmls.nyc/research/context-engineering#ref-langchain-ce). Providers have begun shipping these as platform features: server-side compaction that summarizes older turns automatically, and context editing that clears spent tool results [\[9\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-compaction)[\[10\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context-editing). Figure 1 shows the context engine we argue you should build around the model.

Rendering diagram…

View source

```
flowchart LR
  History["Raw history<br/>messages + tool results"] --> Engine["Context engine"]
  Mem[("External memory<br/>episodic + semantic")] --> Engine
  Retr["Retriever"] --> Engine
  Sys["System instructions<br/>+ tool schemas"] --> Engine
  Engine -->|"working set (budgeted)"| Model["Model"]
  Model -->|"actions + notes"| Engine
  Engine -->|"write durable facts"| Mem
  Engine -.->|"compact / clear"| History
```

Figure 1.The context engine. On each step it assembles the model's working set from four sources under a token budget, writes durable facts out to memory, and prunes the rest. The model never sees the full history; it sees a curated, bounded view the engine constructs.

Six recommendations an engineering leader can act on this quarter:

1. **Budget the window and aim for the smallest sufficient context.** Set an explicit per-turn token target and treat exceeding it as a defect. More context past a point lowers quality, so curation, not accumulation, is the goal[\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot).
2. **Turn on compaction before you hit the wall.** Use server-side compaction and tool-result clearing so long tasks survive the window, and tune the summary for recall first, then precision [\[9\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-compaction)[\[10\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context-editing).
3. **Externalize memory.** Write durable facts to notes or a store the agent re-reads, and retrieve only the relevant slice per step, rather than carrying everything in the window [\[8\]](https://www.tmls.nyc/research/context-engineering#ref-memgpt)[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).
4. **Keep the prefix stable to win the cache.** Put long, stable material at the front and changing data at the end. A stable prefix lets prompt caching reuse computed tensors at a steep discount; any early edit breaks it[\[13\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-prompt-caching)[\[17\]](https://www.tmls.nyc/research/context-engineering#ref-kv-prefix).
5. **Isolate heavy subtasks into sub-agents.** When a subtask would flood the main window with detail the parent does not need, give it its own context and return only a tight summary [\[19\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-multiagent).
6. **Measure context, not just answers.** Track tokens per turn, cache-hit rate, and context composition, and evaluate with input length and fact position varied, because a system that passes a short test still rots on a long one[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle)[\[21\]](https://www.tmls.nyc/research/context-engineering#ref-otel-genai).

The one-sentence version

Stop treating the context window as free storage and start treating it as the scarcest resource in the system: budget it, compact it, externalize memory, keep the prefix stable, and measure it, because most agent failures are context failures in disguise.

## Introduction: from prompts to context

For a single-shot model call, the prompt is the context, and prompt engineering is the whole game. For an agent that runs for dozens of steps, the prompt is a small and increasingly minor part of what the model actually sees. By the tenth step the window holds the original instruction, the tool schemas, ten rounds of tool calls and their outputs, the model's own intermediate reasoning, and whatever was retrieved along the way. No human wrote most of that. The agent assembled it, and the quality of that assembly, far more than the wording of the opening prompt, determines whether the next step succeeds. That is the shift this paper is about: from authoring a prompt once to governing a context continuously [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).

This paper is for the CTO, VP of Engineering, and Head of ML who own agent systems and have watched them degrade as tasks lengthen. Our scope is the context window and the machinery around it: how context fails, the operations that manage it, the memory tiers that extend it, the retrieval that feeds it, the compaction that bounds it, and the cache economics that reward keeping it stable. We treat the execution loop, tools, and evaluation as the surrounding harness, covered in the companion paper on [harness engineering](https://www.tmls.nyc/research/harness-engineering), and we treat retrieval quality as deep enough to deserve its own queued treatment; here we use it as a context operation rather than a subject in itself.

Our position is not neutral. We argue that the smallest sufficient context beats the largest possible one, against the intuition that more information helps. We argue that a bigger context window is headroom for the rare hard case, not a substitute for curation, against the marketing that treats window size as a solved-problem number. And we argue that context quality is a first-class thing to measure, with length and position deliberately varied, against the common practice of testing agents only on short, easy inputs and discovering the rot in production.

## The context window as a scarce resource

Start from the physical fact: a context window is a fixed budget of tokens, and the model's attention over those tokens is neither free nor uniform. Two well-replicated findings define the constraint. The first is position bias, from the “Lost in the Middle” study: when the answer to a question sits at the beginning or end of a long context, models find it reliably, but when it sits in the middle, accuracy drops sharply, tracing a U-shaped curve, and overall performance falls as the context lengthens[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle). The second is context rot: Chroma's evaluation of eighteen models found accuracy declining with input length across all of them, with the decline steeper when the needed information is semantically rather than literally matched to the query, the realistic case [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). Newer work isolates the length effect cleanly, showing degradation even when retrieval is perfect and the relevant passage is guaranteed present [\[12\]](https://www.tmls.nyc/research/context-engineering#ref-context-length-hurts).

A crucial methodological point follows. The popular needle-in-a-haystack test, hiding a sentence in a long document and asking the model to find it, measures only literal retrieval, and models pass it easily, which has fostered a false sense that long context is solved [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). Harder variants that require the model to match on meaning rather than exact words, such as the NoLiMa benchmark, reveal large drops that the easy test hides [\[23\]](https://www.tmls.nyc/research/context-engineering#ref-nolima). The lesson for anyone evaluating an agent is to distrust a green needle-in-a-haystack result and test with realistic, non-literal, middle-of-context tasks instead. Figure 2 sketches the relationship both findings describe.

accuracy vs input lengthinput lengthaccuracy vs fact positionstartmiddleend

Figure 2.Two facts about the window. Left: accuracy declines as input length grows (context rot). Right: at fixed length, accuracy is highest for facts at the start and end and lowest in the middle (position bias). Curves are schematic of the reported shapes, not a single dataset.

The implication reframes the whole problem. If quality falls with length, then every token you add has a cost beyond its price: it dilutes attention over the tokens that matter. The objective is not to fill the window but to assemble the smallest set of tokens that lets the model take the right next step. Anthropic frames this as finding the high-signal subset of all possible context, and the rest of this paper is about how to find it, automatically, on every turn [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).

## A taxonomy of context failures

Length and position are capability limits of the model. On top of them sit failures introduced by what the agent puts in the window, and Drew Breunig's taxonomy names four that recur in production [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). They are worth memorizing because each has a distinct signature and a distinct fix.

**Context poisoning** is when a hallucination or error enters the context and is then referenced repeatedly, so the mistake compounds. If a poisoned fact lands in an agent's stated goals, it will pursue an unachievable objective and loop[\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). **Context distraction** is when the history grows so large that the model over-weights it relative to its own trained knowledge; Breunig reports agents past roughly a hundred thousand tokens favoring repetition of actions from their long history over synthesizing new plans [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). **Context confusion** is when irrelevant material in the window gets used and drags the answer down, which is the mechanism behind the tool-sprawl problem, too many tool definitions present, the model picks a wrong one. **Context clash** is when new information or instructions contradict what is already in the context, common when third-party tools arrive with descriptions that fight the rest of the prompt[\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail)[\[22\]](https://www.tmls.nyc/research/context-engineering#ref-simonw-context). Figure 3 maps each to its signature and remedy.

| Failure | What happens | Signature | Fix |
| --- | --- | --- | --- |
| Poisoning | An error enters context and is reused | Confident wrong answers citing earlier text | Validate before write; quarantine |
| Distraction | History overwhelms trained knowledge | Repeated actions, no new plans | Compaction; summarize history |
| Confusion | Irrelevant material gets used | Off-topic or wrong-tool actions | Select less; prune tools |
| Clash | New info contradicts existing context | Inconsistent or oscillating outputs | Reconcile sources; isolate tools |

Figure 3.The four context failure modes, their signatures, and the operation that addresses each. Most agent misbehavior on long tasks is one of these, diagnosable from its signature.

Poisoning is the dangerous one

Distraction and confusion degrade quality; poisoning corrupts it silently and persistently, because the bad fact looks like every other fact in the window and is reinforced each time it is read [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). Validate what enters durable context, especially model-generated summaries and tool outputs that later steps will trust, because a poisoned summary contaminates everything compacted from it.

## The context engine: write, select, compress, isolate

The cleanest organizing frame for the work, from LangChain's synthesis of practice across Manus, Anthropic, and others, factors context management into four operations[\[6\]](https://www.tmls.nyc/research/context-engineering#ref-langchain-ce)[\[7\]](https://www.tmls.nyc/research/context-engineering#ref-lance-ce). Write context means saving information outside the window so it is not lost when the window is pruned. Select context means pulling the right slice back in for the current step. Compress context means keeping only the tokens a step needs, through summarization or trimming. Isolate context means splitting it across agents or scratchpads so no single window carries everything. Every concrete technique in the rest of this paper is an instance of one of these four, and a complete context engine implements all four. Figure 4 shows them as a cycle around the model.

Rendering diagram…

View source

```
flowchart TB
  Model["Model<br/>(works on the view)"] -->|"write: persist facts/notes"| Store[("External memory")]
  Store -->|"select: retrieve relevant slice"| Build["Working set builder"]
  Build -->|"compress: summarize / trim"| View["Bounded working set"]
  View --> Model
  Model -->|"isolate: delegate subtask"| Sub["Sub-agent (own window)"]
  Sub -->|"return tight summary"| Build
```

Figure 4.The four context operations as a cycle. The engine writes durable state out, selects and compresses to build a bounded working set in, and isolates subtasks into separate windows. The model operates only on the compressed, selected view.

## The system prompt: finding the right altitude

Before the engine assembles anything dynamic, it places a fixed foundation: the system prompt and tool schemas. These are the most-read tokens in the entire system, present on every turn of every task, and because they sit at the front they are also the most cacheable, so getting them right pays twice. Anthropic frames the design challenge as finding the right altitude for the prompt: specific enough to steer behavior reliably, but not so specific that it becomes a brittle list of hard-coded rules that breaks on the first unanticipated case, and not so vague that it gives the model no real guidance[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). The failure on the low-altitude end is a prompt that tries to enumerate every situation and contradicts itself as it grows, which is context clash baked into the foundation. The failure on the high-altitude end is a prompt so general the model has to guess what you meant.

Two disciplines keep the foundation healthy. The first is to treat the system prompt as code, versioned, reviewed, and tested against the eval suite, rather than as a document that accretes rules whenever someone notices a bad case, because the accretion path is exactly how a prompt drifts to the brittle low altitude. The second is to keep the foundation byte-stable across turns so it stays cached: resist the temptation to inject the current timestamp, a per-turn counter, or freshly shuffled examples into the system prompt, because each of those changes the prefix and forfeits the cache for everything after it[\[17\]](https://www.tmls.nyc/research/context-engineering#ref-kv-prefix)[\[16\]](https://www.tmls.nyc/research/context-engineering#ref-manus). Dynamic material belongs in the per-turn suffix the engine builds, not in the stable head. The system prompt is the one piece of context a human authors directly; the rest of this paper is about the parts the engine assembles around it.

## Compression: compaction and summarization

Compaction is the workhorse of long-running agents. When the window approaches its limit, the engine replaces the older history with a summary that preserves decisions, open problems, and key state, and continues from there. Anthropic now offers this server-side: a compaction strategy summarizes older message blocks automatically as the window fills and drops the raw blocks prior to the summary, with the feature available across providers including Amazon Bedrock [\[9\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-compaction)[\[11\]](https://www.tmls.nyc/research/context-engineering#ref-bedrock-compaction). A lighter form, context editing, clears tool results once they are spent, which Anthropic describes as among the safest forms of compaction because it removes bulk without touching reasoning [\[10\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context-editing).

The reported gains are large and double as cost wins. Anthropic's internal evaluations show context editing alone delivering a meaningful performance lift and, combined with a memory tool, more, and on a hundred-turn web-search task, context management cut token consumption by roughly eighty-four percent while enabling runs that would otherwise fail from context exhaustion [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). The reason is the compounding structure of agent costs: because the context is resent on every step, trimming it once pays on every subsequent turn, which is developed quantitatively below and in the companion paper on [agentic FinOps](https://www.tmls.nyc/research/agentic-finops).

Compaction has a sharp failure mode, though, and it is poisoning's cousin: a summary that drops a critical fact is worse than no summary, because later steps trust it and cannot recover what was lost. Anthropic's guidance is to tune the compaction prompt for recall first, ensuring it captures everything that might matter, then iterate toward precision [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). Two patterns reduce the risk. Anchored summarization keeps certain high-value items, the task goal, hard constraints, the current plan, verbatim and never summarizes them, compacting only the surrounding narrative. And write-before-compact externalizes durable facts to memory before the summary runs, so a fact dropped from the summary still lives in a store the agent can retrieve. Figure 5 shows the token trajectory compaction produces, and Figure 6 compares the strategies.

context tokensagent turnswindow limitunmanaged (rots, overflows)compaction band

Figure 5.Working-context tokens over agent turns. Unmanaged, context grows until it overflows and rots before that. With compaction at a threshold, the working set is held in a band; spikes are tool results that context editing clears. Schematic.

| Strategy | What it removes | Risk | When |
| --- | --- | --- | --- |
| Tool-result clearing | Spent tool outputs | Low (reasoning untouched) | Continuously [\[10\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context-editing) |
| Compaction / summarization | Older narrative history | Medium (can drop facts) | Near window limit [\[9\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-compaction) |
| Anchored summarization | Narrative, but not goals/constraints | Lower than plain compaction | When state must survive |
| Trimming / windowing | Oldest turns by recency | High (blind to importance) | Only as a last resort |

Figure 6.Compression strategies, what they remove, and their risk. Combine them: clear tool results aggressively, compact narrative periodically, and never compress anchored items.

## Memory: write and select beyond the window

Compaction bounds a single task; memory extends the agent across tasks and sessions. The foundational design is MemGPT, which treats the context window like operating-system main memory and an external store like disk, and lets the model itself page information between the two via tool calls, deciding what to keep resident, what to write out, and what to retrieve back [\[8\]](https://www.tmls.nyc/research/context-engineering#ref-memgpt). The insight that matters for architects is that the model can manage its own memory if you give it the operations, and that a small in-context tier backed by a large external tier behaves, from the task's perspective, like a much larger context without paying the rot penalty for it.

Three tiers of memory recur, and naming them clarifies design. Working memory is the active window, the current step's scratchpad. Episodic memory is the record of what happened, earlier in this task and in past sessions, often externalized as notes or a structured log the agent re-reads; this is what lets a long-running agent resume after a context reset, and it is the mechanism behind the initializer-plus-progress-file pattern for multi-session work[\[18\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-harnesses). Semantic memory is durable, queryable knowledge, facts, user preferences, domain documents, held in a vector or graph store and selected on demand. Providers now expose a memory tool that gives the agent a persistent store it controls, which is the productized form of MemGPT's idea[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). Figure 7 shows the hierarchy and the paths between tiers.

Rendering diagram…

View source

```
flowchart TB
  Model["Model"] <-->|"read / write"| WM["Working memory<br/>(context window)"]
  WM <-->|"page out / in"| EM[("Episodic memory<br/>notes, task log")]
  WM <-->|"retrieve"| SM[("Semantic memory<br/>vector / graph store")]
  EM -.->|"consolidate"| SM
  WM -->|"compact"| WM
```

Figure 7.The memory hierarchy. The model works in a small, fast working memory and pages to larger, slower tiers: episodic notes for what happened, semantic stores for durable knowledge. The context engine, or the model itself, moves information between tiers.

A practical note from production: the file system is an underrated memory tier. The Manus team reports treating the file system as externalized context, letting the agent write intermediate artifacts to files and read them back, which keeps the window small while preserving unlimited durable state, and reports that the single most important production metric for them is the key-value cache hit rate, which file-based, append-only context helps protect [\[16\]](https://www.tmls.nyc/research/context-engineering#ref-manus). The general principle is that anything the agent might need later but does not need now belongs in memory, not in the window.

## Selection: getting the right slice in

Writing context out is only useful if you can select the right part back in, and selection is where retrieval meets context engineering. The naive approach, retrieve the top-k chunks by embedding similarity and paste them in, is also where two failure modes start. Retrieve too much and you reintroduce confusion and rot; retrieve the wrong slice and you starve the step. Because models are weakest in the middle of a long context, where you place retrieved material matters as much as what you retrieve: high-value passages belong near the start or end of the assembled context, not buried in the middle [\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle).

Selection also applies to tools and to memory, not only to documents. Loading every tool definition into the window is a selection failure that causes confusion; retrieving only the relevant tools per task is the fix, the same write-then-select discipline applied to the tool registry [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). For memory, selection means querying the episodic and semantic stores for what this step needs rather than dumping the whole store back in. The engineering goal across all three, documents, tools, memory, is identical: maximize the relevance density of the window, the fraction of tokens that bear on the current decision. Detailed retrieval architecture, hierarchical chunking, reranking, late interaction, is its own queued subject; here it is one operation of the engine.

Two selection disciplines are worth stating because they are cheap and frequently skipped. The first is to rerank before you place: retrieving twenty candidate passages and then using a reranker to keep the best three turns a noisy top-k into a small, high-relevance set, which raises relevance density and shrinks the window at the same time. The second is just-in-time selection: rather than front-loading everything a task might need, let the agent retrieve as it goes, pulling in the next slice only when the current step calls for it, which keeps each turn's window minimal and matches the way a reactive loop actually unfolds[\[24\]](https://www.tmls.nyc/research/context-engineering#ref-react)[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). The trade is latency, an extra retrieval round trip per step, against quality and cost, a smaller, fresher window, and for most long tasks the trade favors just-in-time. The anti-pattern selection guards against is the kitchen-sink retrieve: pulling a large corpus in once at the start on the theory that the model can sort it out, which is precisely the move that triggers confusion and rot.

## Isolation: partitioning context across agents

The fourth operation is isolation, and sub-agents are its main instrument. Instead of one agent accumulating every subtask's tool output in a single growing window, an orchestrator delegates each subtask to a sub-agent with a clean context, and only the distilled result returns to the parent [\[19\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-multiagent). This directly counters distraction and rot, because no single window ever holds everything, and it enables parallelism across independent subtasks. Anthropic's multi-agent research system is the canonical example, with parallel subagents each exploring in their own context window and an orchestrator synthesizing the results [\[19\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-multiagent).

Isolation is not free, and the trade is the same one the harness paper draws for multi-agent systems generally: a multi-agent design can consume many times the tokens of a single chat, and the gain only materializes when subtasks are genuinely independent[\[19\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-multiagent). The context-specific decision rule is narrower than the general orchestration one: isolate a subtask into its own window when that subtask would otherwise flood the parent's context with detail the parent does not need, and keep the returned summary tight so the isolation is not undone by a verbose hand-back. A scratchpad, a separate context region the agent uses for working notes and then discards, is the lightweight version of the same idea within a single agent.

## The token budget and cache economics

Context engineering is simultaneously a quality lever and a cost lever, and the cost side is worth making precise because it is large and counterintuitive. An agent resends its context on every step, so the input-token cost of a task is not the context size once; it is the context size summed over every turn. For a task of nnn turns where the working context at turn iii is cic\_ici​ tokens at input priceppp, the input cost is:

Cin=p∑i=1nciC\_{\\text{in}} = p \\sum\_{i=1}^{n} c\_iCin​=pi=1∑n​ci​

(1)

If context grows linearly with turns, that sum grows quadratically in the number of turns, which is why an unmanaged long task gets expensive fast and why compaction, which flattenscic\_ici​ instead of letting it climb, pays on every remaining turn rather than once. This is the arithmetic behind Anthropic's reported eighty-four percent token reduction on a long task [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).

Prompt caching changes the price of the tokens that remain. Providers cache the computed key-value tensors for a prompt prefix and reuse them when a later request shares that prefix, charging a steep discount on the cached portion: Anthropic prices cache reads at roughly a tenth of fresh input tokens, with a large latency reduction, and OpenAI applies automatic caching at around half price [\[13\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-prompt-caching)[\[14\]](https://www.tmls.nyc/research/context-engineering#ref-openai-caching). With a cache-hit fraction hhh on the prefix and a cached-read price pcp\_cpc​, the effective per-turn input price is:

peff=(1−h)p+hpcp\_{\\text{eff}} = (1-h)\\,p + h\\,p\_cpeff​=(1−h)p+hpc​

(2)

The catch, and the discipline, is that caches key on the exact prefix bytes, so any edit early in the context invalidates the cache for everything after it. The rule that follows is to keep the long, stable material, system prompt, tool schemas, retrieved corpus, at the front and put anything that changes per turn at the end, which keeps hhh high[\[17\]](https://www.tmls.nyc/research/context-engineering#ref-kv-prefix). This couples cache strategy to compaction: a compaction that rewrites the prefix every turn destroys the cache, so production systems compact in a way that preserves a stable cached prefix, a subtlety recent evaluation work on long-horizon agentic caching examines directly [\[15\]](https://www.tmls.nyc/research/context-engineering#ref-dont-break-cache). Figure 8 plots effective price against hit rate; Figure 9 shows the prefix-stability rule.

effective $/token (rel.)cache-hit rate h1.0 (no cache)~0.1 (all cached)

Figure 8.Effective per-turn input price as a function of cache-hit rate on the prefix, for a cached-read price at one-tenth of fresh input. High hit rates collapse the effective price, which is why prefix stability is worth engineering for. Schematic.

Rendering diagram…

View source

```
flowchart LR
  subgraph Prompt["Prompt layout (front to back)"]
    A["System prompt<br/>(stable, cached)"] --> B["Tool schemas<br/>(stable, cached)"]
    B --> C["Retrieved corpus<br/>(stable per task, cached)"]
    C --> D["Conversation / turn<br/>(changing, fresh)"]
  end
  A -.->|"edit here"| X["Cache miss for B, C, D"]
```

Figure 9.Prefix-stability rule. Caches key on the prefix bytes: keep long stable content at the front so it is cached, and place per-turn changing content at the end. An edit in the stable region invalidates the cache for everything after it.

## A reference architecture for a context engine

Figure 10 assembles the operations into a reference architecture. The context engine sits between the agent loop and the model as a service, not an in-line function, because treating it as a service is what lets memory survive a process, caching be managed centrally, and context composition be observed and tuned. Each step, the loop asks the engine for a working set; the engine selects from memory and retrieval, compresses to the budget, orders the result for cache stability and position, and returns it; after the step, the engine writes durable facts back and clears spent tool results.

Rendering diagram…

View source

```
flowchart TB
  Loop["Agent loop"] -->|"request working set"| Builder["Working-set builder"]
  Builder --> Sel["Selector (relevance)"]
  Sel --> EM[("Episodic memory")]
  Sel --> SM[("Semantic store")]
  Sel --> Retr["Retriever"]
  Builder --> Comp["Compactor / editor"]
  Comp --> Order["Prefix-stable ordering"]
  Order -->|"budgeted working set"| Loop
  Loop -->|"completion"| Writer["Memory writer (validate)"]
  Writer --> EM
  Writer --> SM
  Builder -.->|"token composition, cache hit"| Obs["Observability"]
```

Figure 10.Reference architecture for a context engine. The builder selects from episodic and semantic memory and a retriever, compresses via a compactor, orders for cache stability, and returns a budgeted working set. An observability pipeline records token composition and cache-hit rate for tuning.

Two design choices carry the leverage. First, ordering is a first-class step: the builder deliberately places stable content in the cacheable prefix and high-value content out of the lossy middle, so the same tokens cost less and are used better [\[17\]](https://www.tmls.nyc/research/context-engineering#ref-kv-prefix)[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle). Second, the memory writer validates before it persists, because the durable tiers are exactly where poisoning does the most damage, and a single bad fact written to semantic memory contaminates every future task that retrieves it[\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail).

## Measuring context quality

You cannot tune what you do not measure, and context is measurable on two axes: efficiency and quality. On efficiency, instrument input tokens per turn and per task, the cache-hit rate on the prefix, and the composition of the window, what fraction is instructions, tool schemas, tool results, retrieved material, and history, using OpenTelemetry's generative-AI conventions so the numbers are attributable per agent and per step [\[21\]](https://www.tmls.nyc/research/context-engineering#ref-otel-genai). These metrics surface the problems directly: a rising tokens-per-turn curve is accumulation a compactor should be cutting, a low cache-hit rate is a prefix being churned, and a window that is mostly tool results is a candidate for aggressive clearing.

On quality, the central discipline is to vary the two things that break context in production: input length and fact position. A test that passes at two thousand tokens can fail at eighty thousand, so evaluate across lengths, and because models are weakest in the middle, include tasks whose key fact sits there rather than only at the convenient ends[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle)[\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). Distrust an easy needle-in-a-haystack pass and use non-literal, semantic-match tasks that reflect real retrieval[\[23\]](https://www.tmls.nyc/research/context-engineering#ref-nolima). Finally, watch for the failure signatures from the taxonomy as live signals: repeated actions flag distraction, oscillating outputs flag clash, and confident wrong answers that cite earlier text flag poisoning [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail). Figure 11 collects the measurement checklist.

| Axis | Metric | What it catches |
| --- | --- | --- |
| Efficiency | Input tokens per turn / per task | Unmanaged accumulation |
| Efficiency | Cache-hit rate on prefix | Prefix churn breaking the cache |
| Efficiency | Window composition (%) | Tool-result or history bloat |
| Quality | Accuracy vs input length | Context rot [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot) |
| Quality | Accuracy vs fact position | Lost-in-the-middle [\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle) |
| Quality | Non-literal retrieval tasks | False confidence from easy tests [\[23\]](https://www.tmls.nyc/research/context-engineering#ref-nolima) |

Figure 11.A context-quality measurement checklist, split into efficiency and quality. Wire the efficiency metrics into dashboards and the quality evals into CI so a context-engine change that regresses either is caught before it ships.

## Case studies in context engineering

Three public systems show the operations working together. The first is coding agents, where compaction is most visible. A coding agent on a real task can run for hundreds of turns, accumulating file reads, test output, and diffs that would overflow any window, and the production answer is aggressive compaction that preserves architectural decisions, the current plan, and unresolved problems while discarding the raw output that produced them[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). The pattern that makes it work across sessions is the initializer-plus-progress-file shape from the harness literature: a first step sets up a durable progress record, and each later step starts with a fresh window and rehydrates from that record plus the version-control history, so the agent never depends on an ever-growing conversation [\[18\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-harnesses). Read as context engineering, the coding agent is a write-and-compress machine with episodic memory in the file system.

The second is Manus, whose team published unusually concrete production lessons. They report treating the file system as externalized, effectively unlimited context, with the agent writing intermediate artifacts to files and reading them back rather than holding everything in the window, and they identify the key-value cache hit rate as the single most important production metric, which drove them to an append-only context discipline that never edits earlier turns and so never breaks the cache [\[16\]](https://www.tmls.nyc/research/context-engineering#ref-manus). Their experience is a direct corroboration of two of this paper's claims at once: that the file system is a first-class memory tier, and that prefix stability is worth designing the whole context layout around.

The third is research and deep-search agents, which lean on isolation. Anthropic's multi-agent research system fans a query out to parallel subagents, each gathering and reasoning in its own clean window, with only distilled findings returning to the orchestrator for synthesis, which keeps any single window small and focused even as the system as a whole reads far more than one window could hold [\[19\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-multiagent). The cost is the token multiplier isolation always carries, and the system earns it because research subtasks are genuinely independent. Across all three, the model is roughly the same class of model; the difference in what they can sustain is the context engineering, which is the thesis of this paper observed in the wild rather than argued from first principles.

## Anti-patterns and a point of view

Three habits cause most context problems, and naming them helps teams catch their own. The first is the append-everything window: every message and tool result kept until overflow, on the theory that the model should have all the information, when the measured effect of all the information is degraded attention and rising cost [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). The fix is a token budget enforced by compaction and clearing. The second is treating the context window as durable storage: facts the agent will need later left in the window rather than written to memory, so they are lost on the next reset. The fix is write-then-select, externalize, then retrieve. The third is bigger-window-as-a-fix: upgrading to a larger window and stopping curation, which raises the ceiling but keeps the rot.

That third habit deserves the strongest stance, because it is the most marketed and the most wrong. A larger context window is real headroom and occasionally indispensable, but the studies that motivate this entire field tested million-token models and still found accuracy falling with length [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot)[\[12\]](https://www.tmls.nyc/research/context-engineering#ref-context-length-hurts). A bigger window does not remove the penalty for filling it; it raises the amount you can include before disaster, which is useful only if you still include the right amount. The teams that get the most from large windows are precisely the ones that keep compacting, retrieving, and pruning, and spend the extra capacity on the rare task that needs it rather than on padding every request. The smallest sufficient context wins at every window size, and the window size only changes what sufficient can mean.

## Roadmap and open problems

Context engineering is consolidating from folklore into infrastructure, and several problems remain open. Compaction quality is the most immediate: summarization that reliably preserves the right state without poisoning is still tuned by hand per workload, and an automated way to verify that a summary lost nothing essential would remove the field's sharpest risk[\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context). Memory consolidation, the promotion of episodic records into durable semantic knowledge without accumulating contradictions, is immature, and the queued companion work on agent memory will go deeper. Cache-aware context construction, jointly optimizing for relevance, position, and prefix stability, is an active research target that the recent long-horizon caching evaluations only begin to map [\[15\]](https://www.tmls.nyc/research/context-engineering#ref-dont-break-cache).

Two deeper questions sit underneath. The first is whether model architectures will eventually make context rot disappear, in which case some of this discipline becomes unnecessary; the honest answer is that every generation of longer-context models so far has reduced the severity without removing the shape of the curve, so betting against curation has lost repeatedly[\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle)[\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot). The second is standardization: portable representations of memory and context policy that move between runtimes do not yet exist, and the field would benefit from them the way it benefited from a standard for tool calling. None of these is a reason to wait. The operations in this paper, write, select, compress, isolate, work today and pay immediately, which is the practical thesis restated.

## Frequently asked questions

### What is context engineering and how is it different from prompt engineering?

Prompt engineering is the craft of writing a single instruction well. Context engineering is the broader, ongoing discipline of curating everything in the model's context window at each step of an agent's run: the system instructions, the tools and their schemas, retrieved documents, memory, and the accumulating history of actions and tool results. Prompt engineering is a one-time authoring task; context engineering is a runtime control problem, because the contents of the window change on every turn and the agent, not a human, is assembling much of it. As agents run for many steps, the question shifts from how to phrase one prompt to how to decide, automatically and repeatedly, what the model should see next.

### Why do long contexts make agents worse instead of better?

Because attention is finite and degrades with length. Controlled studies show model accuracy declining steadily as input grows, even well inside the advertised window and even when the relevant fact is present, an effect often called context rot. Models also exhibit position bias, recalling information at the start and end of a long context better than information in the middle. On top of these capability limits, a long context accumulates distractors, stale facts, and conflicting instructions that actively mislead the model. The result is that adding more text past a point lowers quality rather than raising it, so the engineering goal is the smallest sufficient context, not the largest possible one.

### What are the main ways a context can fail?

A useful taxonomy names four. Context poisoning is when a hallucination or error enters the context and is then repeatedly referenced, compounding the mistake. Context distraction is when the history grows so long that the model over-weights it and stops synthesizing new plans, favoring repetition of past actions. Context confusion is when irrelevant material in the window gets used and degrades the answer. Context clash is when newly added information or tools contradict something already in the context, which is common when connecting third-party tools whose instructions fight the rest of the prompt. All four are failures of what was placed in the window, not of the model's underlying ability.

### What is compaction and when should I use it?

Compaction summarizes the older part of a conversation into a compact record that preserves decisions, open problems, and key state, then continues from that summary instead of the raw history. It is the right tool when a single task runs long enough to approach the context window, which is normal for coding and research agents. Providers now offer it server-side: a compaction strategy summarizes older blocks automatically as the window fills, and a lighter form, tool-result clearing, drops bulky tool outputs once they are no longer needed. The discipline is to tune the compaction step for recall first, capturing everything that matters, then for precision, because a summary that loses a critical decision is worse than no summary at all.

### What kinds of memory does an agent need?

Three, roughly. Working memory is the active context window, the scratchpad for the current step. Episodic memory is the record of what happened earlier in this task or in past sessions, often externalized to notes or a log the agent can re-read, which lets work survive a context reset. Semantic memory is durable, queryable knowledge, facts, preferences, and documents, usually held in a vector or graph store and retrieved on demand. The classic MemGPT design treats this like operating-system virtual memory, with the model paging information between a small in-context tier and a large external tier and managing the movement itself. Good memory design is what lets an agent operate beyond a single window without carrying everything in it.

### How does context engineering reduce cost, not just improve quality?

In two compounding ways. First, smaller, well-curated contexts mean fewer input tokens per turn, and because an agent resends its context on every step, savings multiply across a long run. Second, keeping the context prefix stable lets provider prompt caching reuse the already-computed key-value tensors, which providers discount steeply, commonly around ninety percent off the cached portion at one major provider, with a large latency reduction as well. The practical rule is to keep the long, stable material at the front of the prompt and put anything that changes at the end, because caches key on the prefix bytes and any early edit breaks the cache for everything after it. Good context engineering is therefore simultaneously a quality lever and a cost lever.

### Should I just use a model with a bigger context window?

A bigger window helps, but it does not solve the problem and can make it worse if used naively. The same studies that motivate context engineering tested million-token models and still found accuracy degrading with length, so a larger window raises the ceiling on how much you can include without removing the penalty for including too much. Treat window size as headroom for the cases that genuinely need it, not as a license to stop curating. The teams that get the most from large windows are the ones that still compact, retrieve, and prune aggressively, using the extra capacity for the rare task that needs it rather than padding every request.

### How do sub-agents help with context?

Sub-agents are context isolation. Instead of one agent accumulating every subtask's tool output in a single growing window, an orchestrator delegates each subtask to a sub-agent with its own clean context, and only the distilled result returns to the parent. This keeps any one window small and focused, which directly counters distraction and rot, and it lets independent subtasks run in parallel. The trade is cost and coordination: a multi-agent system can consume many times the tokens of a single chat, and the gain only materializes when subtasks are genuinely independent. Use isolation when a subtask would otherwise flood the main context with detail the parent does not need, and keep the returned summary tight.

### How do I measure whether my context engineering is working?

Instrument the context itself, not just the final answer. Track input tokens per turn and per task, the cache-hit rate on your prompt prefix, the fraction of context occupied by tool results versus instructions versus retrieved material, and how these evolve as a task lengthens. On quality, build evaluations that vary input length and the position of the key fact, because a system that passes a short test can still rot on a long one, and run tasks that require information from the middle of the context where models are weakest. Watch for the failure signatures directly: repeated actions signal distraction, contradictory outputs signal clash, and confidently wrong answers that cite earlier text signal poisoning.

## Glossary

Context engineeringThe runtime discipline of curating what enters the model's context window at each agent step [\[1\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context).Context rotThe decline in model accuracy as input length grows, even inside the advertised window [\[2\]](https://www.tmls.nyc/research/context-engineering#ref-chroma-rot).Position bias / lost in the middleModels recall facts at the start and end of a context better than facts in the middle [\[3\]](https://www.tmls.nyc/research/context-engineering#ref-lost-middle).Context poisoningAn error that enters the context and is then repeatedly referenced, compounding [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail).Context distractionHistory growing so large the model over-weights it and stops planning afresh [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail).Context confusionIrrelevant material in the window getting used and degrading the answer [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail).Context clashNew information or tools contradicting what is already in the context [\[4\]](https://www.tmls.nyc/research/context-engineering#ref-breunig-fail).CompactionSummarizing older history near the window limit and continuing from the summary [\[9\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-compaction).Context editing / tool-result clearingRemoving spent tool outputs from the window, a light form of compaction [\[10\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-context-editing).Anchored summarizationCompaction that keeps high-value items (goal, constraints, plan) verbatim and summarizes only the rest.Working / episodic / semantic memoryThe active window; the record of what happened; durable queryable knowledge.Virtual context (MemGPT)Treating the window as RAM and an external store as disk, with the model paging between them [\[8\]](https://www.tmls.nyc/research/context-engineering#ref-memgpt).Write / select / compress / isolateThe four operations of a context engine [\[6\]](https://www.tmls.nyc/research/context-engineering#ref-langchain-ce).Prompt / KV cacheProvider reuse of computed key-value tensors for a shared prefix at a discount [\[13\]](https://www.tmls.nyc/research/context-engineering#ref-anthropic-prompt-caching).Prefix stabilityKeeping the cacheable front of the prompt unchanged so the cache is reused [\[17\]](https://www.tmls.nyc/research/context-engineering#ref-kv-prefix).Relevance densityThe fraction of context tokens that bear on the current decision; the quantity to maximize.

## References

01. \[1\]Anthropic. Effective context engineering for AI agents.Anthropic Engineering, 2025. [https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (accessed 2026-06-01).
02. \[2\]K. Hong, A. Troynikov, J. Huber (Chroma). Context Rot: How Increasing Input Tokens Impacts LLM Performance.Chroma Research, 2025. [https://research.trychroma.com/context-rot](https://research.trychroma.com/context-rot) (accessed 2026-06-01).
03. \[3\]N. F. Liu, K. Lin, J. Hewitt, et al. Lost in the Middle: How Language Models Use Long Contexts.TACL 2024 (arXiv:2307.03172), 2023. [https://arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172) (accessed 2026-06-01).
04. \[4\]D. Breunig. How Long Contexts Fail.dbreunig.com, 2025. [https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) (accessed 2026-06-01).
05. \[5\]D. Breunig. How to Fix Your Context.dbreunig.com, 2025. [https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html](https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html) (accessed 2026-06-01).
06. \[6\]L. Martin (LangChain). Context Engineering for Agents.LangChain Blog, 2025. [https://www.langchain.com/blog/context-engineering-for-agents](https://www.langchain.com/blog/context-engineering-for-agents) (accessed 2026-06-01).
07. \[7\]L. Martin. Context Engineering for Agents.rlancemartin.github.io, 2025. [https://rlancemartin.github.io/2025/06/23/context\_engineering/](https://rlancemartin.github.io/2025/06/23/context_engineering/) (accessed 2026-06-01).
08. \[8\]C. Packer, S. Wooders, K. Lin, et al. (UC Berkeley). MemGPT: Towards LLMs as Operating Systems.arXiv:2310.08560, 2023. [https://arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560) (accessed 2026-06-01).
09. \[9\]Anthropic. Compaction.Claude API Documentation, 2026. [https://platform.claude.com/docs/en/build-with-claude/compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) (accessed 2026-06-01).
10. \[10\]Anthropic. Context editing.Claude API Documentation, 2026. [https://platform.claude.com/docs/en/build-with-claude/context-editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (accessed 2026-06-01).
11. \[11\]Amazon Web Services. Compaction for Anthropic Claude models.Amazon Bedrock Documentation, 2026. [https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html) (accessed 2026-06-01).
12. \[12\]Anonymous et al. Context Length Alone Hurts LLM Performance Despite Perfect Retrieval.arXiv:2510.05381, 2025. [https://arxiv.org/abs/2510.05381](https://arxiv.org/abs/2510.05381) (accessed 2026-06-01).
13. \[13\]Anthropic. Prompt caching.Claude API Documentation, 2026. [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (accessed 2026-06-01).
14. \[14\]OpenAI. Prompt Caching in the API.OpenAI, 2024. [https://openai.com/index/api-prompt-caching/](https://openai.com/index/api-prompt-caching/) (accessed 2026-06-01).
15. \[15\]Anonymous et al. Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks.arXiv:2601.06007, 2026. [https://arxiv.org/abs/2601.06007](https://arxiv.org/abs/2601.06007) (accessed 2026-06-01).
16. \[16\]Y. Ji (Manus). Context Engineering for AI Agents: Lessons from Building Manus.Manus Blog, 2025. [https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (accessed 2026-06-01).
17. \[17\]A. Bokovoy (F5). KV-Cache Aware Prompt Engineering: Stable Prefixes and Latency Improvements.ankitbko.github.io, 2025. [https://ankitbko.github.io/blog/2025/08/prompt-engineering-kv-cache/](https://ankitbko.github.io/blog/2025/08/prompt-engineering-kv-cache/) (accessed 2026-06-01).
18. \[18\]Anthropic. Effective harnesses for long-running agents.Anthropic Engineering, 2026. [https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (accessed 2026-06-01).
19. \[19\]Anthropic. How we built our multi-agent research system.Anthropic Engineering, 2025. [https://www.anthropic.com/engineering/built-multi-agent-research-system](https://www.anthropic.com/engineering/built-multi-agent-research-system) (accessed 2026-06-01).
20. \[20\]W. Kwon, Z. Li, S. Zhuang, et al. (UC Berkeley). Efficient Memory Management for Large Language Model Serving with PagedAttention.SOSP 2023 (arXiv:2309.06180), 2023. [https://arxiv.org/abs/2309.06180](https://arxiv.org/abs/2309.06180) (accessed 2026-06-01).
21. \[21\]OpenTelemetry Authors. Semantic conventions for generative AI systems.OpenTelemetry, 2025. [https://opentelemetry.io/docs/specs/semconv/gen-ai/](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (accessed 2026-06-01).
22. \[22\]S. Willison. How to Fix Your Context.simonwillison.net, 2025. [https://simonwillison.net/2025/Jun/29/how-to-fix-your-context/](https://simonwillison.net/2025/Jun/29/how-to-fix-your-context/) (accessed 2026-06-01).
23. \[23\]A. Modarressi, H. Deilamsalehy, F. Dernoncourt, et al. NoLiMa: Long-Context Evaluation Beyond Literal Matching.arXiv:2502.05167, 2025. [https://arxiv.org/abs/2502.05167](https://arxiv.org/abs/2502.05167) (accessed 2026-06-01).
24. \[24\]S. Yao, J. Zhao, D. Yu, et al. ReAct: Synergizing Reasoning and Acting in Language Models.ICLR 2023 (arXiv:2210.03629), 2022. [https://arxiv.org/abs/2210.03629](https://arxiv.org/abs/2210.03629) (accessed 2026-06-01).

## How to cite

TMLS AI Research. “Context Engineering: Compaction, Memory, and Beating Context Drift.” TMLS AI Research, June 1, 2026. tmls:context-engineering:2026-06.

```
@techreport{contextengineering2026,
  title  = {Context Engineering: Compaction, Memory, and Beating Context Drift},
  author = {TMLS AI Research},
  institution = {TMLS AI Research},
  year   = {2026},
  type   = {Research Report},
  number = {tmls:context-engineering:2026-06},
  url    = {https://tmls.nyc/research/context-engineering}
}
```

## Connected papers

[All 114 publications](https://www.tmls.nyc/research#papers)

- [Systems **The Company Memory Engine: Source-Linked Organizational Memory from Engineering Exhaust**](https://www.tmls.nyc/research/company-memory-engines)
- [AI Engineering **Agent Memory and State: Episodic, Semantic, and Durable Workflows**](https://www.tmls.nyc/research/agent-memory-state)
- [AI Economics **Hybrid Inference: When On-Prem Beats the Frontier**](https://www.tmls.nyc/research/hybrid-inference-economics)

[Newer publicationProduction RAG Beyond Naive Chunking: Hierarchical Retrieval Patterns](https://www.tmls.nyc/research/production-rag-beyond-chunking) [Older publicationHarness Engineering: The Control Plane That Makes AI Agents Work](https://www.tmls.nyc/research/harness-engineering)

TMLS AI Research [tmls.nyc/research](https://www.tmls.nyc/research)

[TMLS.NYC](https://www.tmls.nyc/)

The Machine Learning Society

Company

- [About](https://www.tmls.nyc/about)
- [News](https://www.tmls.nyc/news)

Products

- [Titanium](https://www.tmls.nyc/products/titanium)
- [Morna](https://www.tmls.nyc/products/morna)
- [Mariete](https://www.tmls.nyc/products/mariete)
- [DRONA](https://www.tmls.nyc/products/drona)
- [Patendra](https://www.tmls.nyc/products/patendra)
- [MDCP](https://www.tmls.nyc/products/mdcp)

Research

- [Publications](https://www.tmls.nyc/research)
- [Open source](https://www.tmls.nyc/open-source)

Contact

- [Send a message](https://www.tmls.nyc/contact)
- [Press and brand kit](https://www.tmls.nyc/press)
- [hi@tmls.nyc](mailto:hi@tmls.nyc)

Autonomous AI research & development

[Privacy](https://www.tmls.nyc/privacy) [Terms](https://www.tmls.nyc/terms) [Cookies](https://www.tmls.nyc/cookies) Cookie settings