[James Phoenix](https://understandingdata.com/)

- [About](https://understandingdata.com/about/)
- [Beliefs](https://understandingdata.com/beliefs/)
- [Projects](https://understandingdata.com/projects/)
- [Tools](https://understandingdata.com/tools/)
- Learn

- [Services](https://understandingdata.com/services/)
- [Contact](https://understandingdata.com/contact/)

Subscribe

# Prompt Contracts: Formal Specifications That Eliminate Vibe Coding

![James Phoenix](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fsecure.gravatar.com%2Favatar%2F2d7d83ddfbd40122f84bc8a7b90ed269d6cb52996b0ff9c58001fe0c7c41a362%3Fs%3D96%26r%3Dg&w=3840&q=75)

James Phoenix

![James Phoenix](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fsecure.gravatar.com%2Favatar%2F2d7d83ddfbd40122f84bc8a7b90ed269d6cb52996b0ff9c58001fe0c7c41a362%3Fs%3D96%26r%3Dg&w=3840&q=75)

James Phoenix

## Summary

A prompt contract is a structured 8-section specification you generate before an AI agent writes any code. It defines the objective, pre-conditions, invariants (what must not change), exact file scope, implementation contract, test-first spec, acceptance criteria, and anti-patterns. The contract turns vague instructions into binding constraints that the agent can verify against its own output.

Source: [Rentier Digital on Medium](https://medium.com/@rentierdigital/i-stopped-vibe-coding-and-started-prompt-contracts-claude-code-went-from-gambling-to-shipping-4080ef23efac), extended by Galin Nikolov into a Claude Code skill with hooks-based enforcement and auto-research optimization.

## The Problem

“Add an endpoint for compliance records” is a prompt with no constraints. The agent doesn’t know which auth mechanism to use, which files are off-limits, what the response shape should be, or how to verify correctness. It fills every gap with assumptions. Most assumptions are wrong.

This is vibe coding. You type a natural language request and hope for the best. The agent generates technically valid code that solves the wrong problem, touches files it shouldn’t, uses the wrong patterns, and reports “done” without verification.

[Leanpub Book\\
\\
**Read The Meta-Engineer** \\
\\
A practical book on building autonomous AI systems with Claude Code, context engineering, verification loops, and production harnesses.\\
\\
Continuously updated\\
\\
Claude Code + agentic systems\\
\\
View Book](https://leanpub.com/the-meta-engineer)

The failure modes are predictable. Research on AI coding failure patterns (arXiv:2601.13118) shows that pre/post-conditions in prompts are the second-most impactful technique for code quality, after providing algorithmic detail. TDD-first approaches improve pass rates by 12-38% across benchmarks (TGen, TiCoder). Full contracts with pre-conditions, post-conditions, and invariants produce fewer false alarms than post-conditions alone (NL2Contract, arXiv:2510.12702).

## The 8-Section Contract

Every prompt contract has 8 mandatory sections. Each one addresses a specific failure mode.

### 1\. Objective

One sentence. What and why. This prevents the “solved a different problem” failure.

### 2\. Pre-Conditions

What must already exist before work begins. Stack, framework version, auth mechanism, existing models and relationships, patterns in use. This grounds the agent in reality instead of letting it guess your stack.

Pre-conditions prevent the most common drift: generating code for the wrong framework, wrong auth provider, or wrong architectural pattern. If your project uses Sanctum and the agent assumes Firebase, everything downstream is wrong.

### 3\. Invariants (DO NOT MODIFY)

The highest-leverage section. Explicit file paths and behaviors that must not change. Research on structured prompting shows that naming specific files as untouchable reduces scope creep significantly.

Baseline invariants always include: don’t alter existing model relationships, don’t modify existing migrations, don’t install new packages, preserve all existing tests. Then you add task-specific invariants naming adjacent files and tables.

Specificity matters. “Do not modify existing models” is weaker than “Do not modify `app/Models/Driver.php` except to add the `complianceRecords()` relationship.”

This section is the practical application of [invariant theory for LLM code generation](https://understandingdata.com/posts/invariants-programming-llm-generation/). Invariants constrain the valid state space. The more specific they are, the smaller the space of valid agent actions.

### 4\. Scope and Deliverables

Exact file paths to create or modify. Every entry must be a concrete path, never descriptive language like “the relevant controller” or template variables like `{ModelName}`.

When the exact file is unknown (bug fixes, refactors), make a best-guess concrete path and annotate it with `(verify exists before modifying)`. A concrete guess is more useful than a vague description because the implementer can quickly verify and correct a specific path.

### 5\. Implementation Contract

Technical specification written like an API contract. Every input parameter with type, required/optional, default, constraints. Exact response shape as JSON. All error responses with HTTP codes. Business rules as numbered assertions. Edge cases explicitly stated.

### 6\. Test-First Spec

Define the tests that prove the contract is satisfied, before implementation. The agent writes failing tests first, then implements until they pass. This is the executable form of the contract.

This is [test-driven prompting](https://understandingdata.com/posts/test-driven-prompting/) applied within the contract structure. TGen shows +12% on MBPP, TiCoder shows +38% pass@1 with test-first approaches.

### 7\. Acceptance Criteria

Post-conditions using the 5C rubric: Countable (maps to one assertion), Constrained (includes boundary values), Comparable (expected vs actual is unambiguous), Checkable (verified by running a command), Cheap (no external dependencies to verify).

Always includes meta-criteria: all existing tests pass, no new packages installed, only scoped files modified, all test-first spec tests pass.

### 8\. Anti-Patterns

Explicit “DO NOT” list for known AI failure modes per task type. API endpoints: don’t use wrong auth, don’t return raw arrays, don’t put validation in the controller. Database: don’t modify existing migrations, don’t use raw queries. Bug fixes: don’t create scheduled commands for display-logic bugs.

If the project has a learnings file (`.agents/learnings.md`), past mistakes get injected here as additional anti-patterns.

## Enforcement: Hooks Over Instructions

Prompt instructions can be ignored. Claude Code hooks cannot.

The prompt contracts skill includes three hooks for deterministic enforcement:

**PreToolUse (Scope Guard):** Blocks edits to files not listed in the contract’s Scope section. Reads allowed paths from a scope file and rejects any Edit or Write to files outside the list.

**Stop (Self-Verification):** Before the agent can report completion, it must run a 5-point self-check. Are all acceptance criteria satisfied? Does `git diff --stat` show only scoped files? Are all invariants preserved? Do all tests pass?

**PostToolUse (Auto-Format):** Runs the project’s formatter after every edit. Detects Laravel Pint, Prettier, or PHP-CS-Fixer automatically.

This is [constraint-first development](https://understandingdata.com/posts/constraint-first-development/) made operational. The constraints are defined in the contract, then enforced mechanically through hooks that the agent cannot bypass.

## Pipeline Integration

Prompt contracts work standalone, but they’re designed as Step 3 in a larger pipeline:

```markdown
Plan (what and why) -> Contract (exact how with guardrails) -> Build -> Review -> Ship
```

The plan defines goals, scope boundaries, and architecture decisions. The contract adds what the plan doesn’t have: exact file paths, typed API shapes, invariants, anti-patterns, and self-verification checkboxes. Plans answer “what should we build?” Contracts answer “how do we verify we built it correctly?”

## When to Use

Use for any coding task: new features, bug fixes, migrations, refactors, auth flows. The overhead of generating a contract is small compared to the cost of debugging agent drift, undoing scope creep, or discovering the agent used the wrong auth provider.

Don’t use for questions, research, or non-coding tasks. Don’t use for trivial changes where the specification is already obvious from a one-line instruction.

## The Completeness Gap

No contract is perfect. The most dangerous failure mode is the completeness gap: the contract doesn’t cover something, so the agent fills it with assumptions.

The mitigation hierarchy: rich pre-conditions ground the agent in reality. Explicit invariants prevent touching unknowns. Test-first specs catch gaps through executable verification. Self-check protocol forces verification. Anti-patterns block known drift patterns.

As Russell Ward puts it: “Post-conditions verify what you think to ask about. They don’t verify what you didn’t think to ask.” A contract that covers 90% of the spec with explicit invariants for the other 10% is dramatically better than no contract at all.

## Related

- [Constraint-First Development](https://understandingdata.com/posts/constraint-first-development/) \- The philosophical foundation: define constraints, let the system work within them
- [Invariants in Programming and LLM Code Generation](https://understandingdata.com/posts/invariants-programming-llm-generation/) \- How invariants constrain the valid state space for AI-generated code
- [Test-Driven Prompting](https://understandingdata.com/posts/test-driven-prompting/) \- The TDD-first pattern that prompt contracts formalize in Section 6
- [Type-Driven Development](https://understandingdata.com/posts/type-driven-development/) \- Specifications over implementation at the type level
- [Declarative Constraints Over Imperative Instructions](https://understandingdata.com/posts/constraint-based-prompting/) \- Why constraints outperform step-by-step instructions for LLMs
- [Quality Gates as Information Filters](https://understandingdata.com/posts/quality-gates-as-information-filters/) \- How acceptance criteria and hooks function as quality gates

## References

- [Prompt Contracts - Rentier Digital](https://medium.com/@rentierdigital/i-stopped-vibe-coding-and-started-prompt-contracts-claude-code-went-from-gambling-to-shipping-4080ef23efac) \- Original article introducing the prompt contracts concept
- [NL2Contract - arXiv:2510.12702](https://arxiv.org/abs/2510.12702) \- Full contracts (pre + post) produce fewer false alarms than postconditions alone
- [TGen - arXiv:2402.13521](https://arxiv.org/abs/2402.13521) \- TDD-first approach: +12% MBPP, +8.5% HumanEval
- [TiCoder - arXiv:2208.05950](https://arxiv.org/abs/2208.05950) \- Interactive test-driven intent formalization: +38% pass@1
- [10 Empirically Derived Guidelines - arXiv:2601.13118](https://arxiv.org/abs/2601.13118) \- Pre/post-conditions are second-most impactful technique
- [Specification is the New Code - Russell Ward](https://www.linkedin.com/pulse/specification-new-code-russell-ward-rgnhe) \- Contract permanent, implementation disposable
- [gstack - Garry Tan](https://github.com/garrytan/gstack) \- Pipeline workflow that prompt contracts integrate with

* * *

## Part of the field guide

This is one of my field notes in [Context Engineering](https://understandingdata.com/context-engineering/), a plain-English guide to deciding what a model sees. The terms behind it are defined in the [Context Engineering Dictionary](https://understandingdata.com/context-engineering-dictionary/).

## Explore it visually

- [Tool calling is a round tripFollow one customer question through a real tool call: the model writes a request and runs nothing, your code looks the order up, and only when the result goes back does the model answer. Four recorded exchanges show the round trip, a lost result, an error, and a refused cancellation.](https://understandingdata.com/ai-engineering-visualised/tool-calling-round-trip/)
- [Prompt caching: reuse the stable prefixA support bot resends the same 5,897-token prefix on every call. Watch real Claude Sonnet 5 calls read it back from a prompt cache for a tenth of the price, see a question-first prompt reuse nothing, and see one timestamp at the top of the system prompt throw the whole cache away.](https://understandingdata.com/ai-engineering-visualised/prompt-caching-prefix/)
- [The event loop: why a 10 ms timer waits 80 msTrace an executable TypeScript example through a running task, a nested microtask checkpoint and a waiting timer, then compare promise continuations with real task yields in two browser engines.](https://understandingdata.com/ai-engineering-visualised/event-loop/)

Topics

Claude CodeCoding AgentsContext ManagementPrompt EngineeringQuality GatesTDDVerification

Newsletter

## Become a better AI engineer

Weekly deep dives on production AI systems, context engineering, and the patterns that compound. No fluff, no tutorials. Just what works.

Subscribe

Join 306K+ developers. No spam. Unsubscribe anytime.

* * *

## More Insights

[![Cover Image for Why Unrealistic /goal Targets Keep Coding Agents Working Longer](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fwebsite.understandingdata.com%2Fwp-content%2Fuploads%2F2026%2F10%2Ffeatured-unrealistic-goals-keep-agents-working.png&w=3840&q=75)](https://understandingdata.com/posts/unrealistic-goals-keep-agents-working/)

### [Why Unrealistic /goal Targets Keep Coding Agents Working Longer](https://understandingdata.com/posts/unrealistic-goals-keep-agents-working/)

October 14, 2026

I used an unrealistic tutor-discovery target to keep Codex working beyond a finished-sounding handover. Here is the run, the results and the reusable prompt.

![James Phoenix](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fsecure.gravatar.com%2Favatar%2F2d7d83ddfbd40122f84bc8a7b90ed269d6cb52996b0ff9c58001fe0c7c41a362%3Fs%3D96%26r%3Dg&w=3840&q=75)

James Phoenix

[![Cover Image for Why I Threw Away My Video Harness When Opus 5.5 Arrived](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fwebsite.understandingdata.com%2Fwp-content%2Fuploads%2F2026%2F10%2Ffeatured-video-harness-model-progress.png&w=3840&q=75)](https://understandingdata.com/posts/throw-away-your-harness-when-models-improve/)

### [Why I Threw Away My Video Harness When Opus 5.5 Arrived](https://understandingdata.com/posts/throw-away-your-harness-when-models-improve/)

October 7, 2026

I spent £700 on video analysis. A week later, Opus 5.5 outperformed my custom harness and changed how I think about constraints, consistency and model progress.

![James Phoenix](https://understandingdata.com/_next/image/?url=https%3A%2F%2Fsecure.gravatar.com%2Favatar%2F2d7d83ddfbd40122f84bc8a7b90ed269d6cb52996b0ff9c58001fe0c7c41a362%3Fs%3D96%26r%3Dg&w=3840&q=75)

James Phoenix

[About](https://understandingdata.com/about/) [Projects](https://understandingdata.com/projects/) [AI Native Software Engineering](https://understandingdata.com/ai-native-software-engineering/) [AI Coding Dictionary](https://understandingdata.com/ai-coding-dictionary/) [Context Engineering](https://understandingdata.com/context-engineering/) [Context Engineering Dictionary](https://understandingdata.com/context-engineering-dictionary/) [Framework](https://understandingdata.com/learn/agent-framework/) [Tools](https://understandingdata.com/tools/) [Services](https://understandingdata.com/services/) [Notes](https://understandingdata.com/posts/) [Contact](https://understandingdata.com/contact/)

© 2026 JustUnderstandingData. All rights reserved.