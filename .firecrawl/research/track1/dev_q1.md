## [pull_request:openhands/software-agent-sdk#4332] (pull_request) HUMAN:
https://github.com/openhands/software-agent-sdk/issues/4332
License: MIT
## Why
`StuckDetector._is_stuck_repeating_action_error()` already detects the pattern where the model repeats the _same_ tool call and gets the _same_ error back `action_error` times in a row (default threshold: 3). But once detected, the run loop (`local_conversation.py`, both `run()` and `arun()`) went straight from "pattern detected" to a terminal `STUCK` status with no attempt at self-correction.

## Summary
- `StuckDetector.get_action_error_nudge()`: when the repeating action-error streak first reaches `action_error_threshold`, returns a message naming the repeated action and its error instead of leaving the caller to only find out via a bare `is_stuck()` bool.
- `StuckDetector._is_stuck_repeating_action_error()` now requires the streak to continue _one repeat past_ the threshold before reporting a hard stuck — the streak reaching the threshold itself is nudge-eligible, not yet terminal.
- `LocalConversation._check_stuck_or_nudge()` (used by both `run()` and `arun()`): injects the nudge as an `environment`-sourced `MessageEvent` and lets the loop run another `agent.step()` so the model can react to it, only setting `STUCK` if the identical action-error pair persists past that one nudge (or for any other stuck pattern, unchanged).

## How to Test
- Unit: `uv run pytest tests/cross/test_stuck_detector.py tests/cross/test_stuck_detector_config.py` — covers `get_action_error_nudge()` returning `None` before the threshold, a message at the threshold, and `None` again (with `is_stuck()` now `True`) once the streak continues past it.

## Notes
- Behavior change: `is_stuck()` for the action-error pattern now trips one repeat later than before (e.g. 4 identical action-error pairs instead of 3 with default thresholds), since the repeat at the threshold is now used for the nudge. `action_error_threshold` still configures the same detector via `StuckDetectionThresholds`.

## Findings
### 1. The nudge is not guarded against re-firing on the same streak (Medium)
`_check_stuck_or_nudge()` runs every loop iteration, _before_`agent.step()`. `get_action_error_nudge()` returns a message whenever `_action_error_streak(...) == threshold`.

This repeats every iteration the model fails to emit a fresh action, so a stuck-then-empty model can accumulate duplicate environment nudges (action-error nudge + EMPTY corrective nudge per step) until the iteration cap.

## Summary
- Frozen streak (empty/reasoning-only response adds no new action): `last_observations[0]` is unchanged, so `error.id == _last_nudged_error_event_id` suppresses the re-nudge; `is_stuck()` returns False (streak == threshold, not > threshold), so the loop continues. Covered by `test_run_does_not_renudge_action_error_while_streak_is_frozen`.
- A new identical action-error pair lands (4th): streak becomes 4, so `get_action_error_nudge` returns `None` before the id check (4 != 3), and `is_stuck()` returns True (4 > 3). Correct.

## [doc:https://docs.openhands.dev/sdk/guides/agent-stuck-detector] (doc) Stuck Detector
# Stuck Detector
Detect and handle stuck agents automatically with timeout mechanisms.

The Stuck Detector automatically identifies when an agent enters unproductive patterns such as repeating the same actions, encountering repeated errors, or engaging in monologues. By analyzing the conversation history after the last user message, it detects five types of stuck patterns:

1. **Repeating Action-Observation Cycles**: The same action produces the same observation repeatedly (4+ times)
2. **Repeating Action-Error Cycles**: The same action repeatedly results in errors (3+ times)
4. **Alternating Patterns**: Two different action-observation pairs alternate in a ping-pong pattern (6+ cycles)

## How It Works
command 5 times in a row. The stuck detector analyzes the event history and identifies the repetitive pattern:

1. The conversation proceeds normally until the agent starts repeating actions
2. After detecting the pattern (4 identical action-observation pairs), the stuck detector flags the conversation as stuck
3. The conversation can then handle this gracefully, either by stopping execution or taking corrective action

## Pattern Detection
This allows the detector to identify truly repetitive behavior while ignoring superficial differences like timestamps or event IDs.

## [issue:openhands/openhands#15087] (issue) [Feature]: Proposal: Replace LLM-prompted loop detection with deterministic trajectory hashing for Actions#15087
https://github.com/openhands/openhands/issues/15087
License: MIT
# [Feature]: Proposal: Replace LLM-prompted loop detection with deterministic trajectory hashing for Actions#15087
## Description
### Problem or Use Case
2. **It fails under context pollution:** By the time the LLM realizes it's looping, the context window is already filled with the agent's own repeated error outputs, making self-correction highly unreliable.

### Technical Implementation Ideas (Optional)
For OpenHands, the integration would look like this:

### Additional Context
Before I draft the PR, I'd love the maintainers' feedback on:

### Sehlani042 commented yesterdayon Jul 1, 2026
Since `OpenHands/OpenHands` now depends on `openhands-sdk==1.30.0` / `openhands-agent-server==1.30.0`, it looks like the narrow implementation point for deterministic action-loop detection is probably in `OpenHands/software-agent-sdk`, not this app repo.

- if the threshold is reached, do not call the executor, emit the existing stuck/error path, and move the conversation to `STUCK`;
- leave the current post-hoc `StuckDetector` behavior in place for backward compatibility.

### Devaretanmay commented yesterdayon Jul 2, 2026
By using Microloop, we get deterministic, sub-microsecond detection that scales to massive action histories without GIL contention.

### VascoSch92 commented yesterdayon Jul 2, 2026
I want to close the loop on the premise, though: OpenHands' current loop detection is already deterministic and token-free: it doesn't prompt the LLM to "notice" it's looping. See `stuck_detector.py` ( [https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck\_detector.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck\_detector.py)):

- `StuckDetector.is_stuck()` compares recent events by content `via _event_eq()`, ignoring volatile fields (`tool_call_id`, `llm_response_id`, `action_id`): no LLM call, no tokens.
- It runs in the loop before the next `agent.step()`, so the repeated action never reaches the model again.
- On detection it sets `ConversationExecutionStatus.STUCK` and halts rather than feeding a nudge back to the LLM.
- It already covers 5 patterns (action/observation, action/error, monologue, alternating, context-window) with configurable `StuckDetectionThresholds`.

### Devaretanmay commented yesterdayon Jul 2, 2026
You are absolutely right that `StuckDetector.is_stuck()` already solves the deterministic detection problem beautifully, and that the 2ms Python overhead is completely irrelevant when the LLM call takes 1.5+ seconds. I was viewing this through the lens of high-throughput proxy environments (like LiteLLM) where every microsecond counts, but for an interactive coding agent like OpenHands, the existing SDK implementation is exactly the right architectural fit. I appreciate you pointing me to `stuck_detector.py`—it's a great piece of engineering.

When the LLM generates a slightly different monologue before repeating the exact same `CmdRunAction`, the `_event_eq()` check sometimes misses the underlying trajectory redundancy because the surrounding context has drifted.

I will open a small, targeted issue/PR in `software-agent-sdk` that specifically tightens the canonicalization logic in `StuckDetector` to strip out the LLM's monologue/thought text and focus _strictly_ on the Action payload fingerprint.

OpenHands has solved **Detection**. But as you noted, when `is_stuck()` triggers, the task just halts. The agent fails.

## [issue:openhands/software-agent-sdk#762] (issue) Make Stuck Detection Thresholds Configurable#762
https://github.com/openhands/software-agent-sdk/issues/762
License: MIT
# Make Stuck Detection Thresholds Configurable
## Summary
Loop/stuck detection is currently implemented in the `StuckDetector` class but the detection thresholds are hardcoded.

## Problem Statement
1. **Repeating action-observation cycles**: 4 identical action-observation pairs trigger stuck detection (line 107)
2. **Repeating action-error cycles**: 3 identical actions with errors trigger stuck detection (line 142)

### Real-World Use Case
- Agent executes the same polling command 4 times (0, 5, 10, 15 minutes)
- Stuck detector triggers after 4 identical action-observation pairs

## Proposed Solution

### Usage Example

## Alternative Considered
- Support for legitimate repetitive operations

## [doc:https://github.com/provos/ironcurtain/blob/d51a3467cbda6a2e94cf04e885e8ae1abdd0f6be/docs/designs/loop-detection.md] (doc) Design: Two-Layer Loop Detection & Circuit Breaker
License: Apache-2.0
# Design: Two-Layer Loop Detection & Circuit Breaker
## 1. Problem Statement
Autonomous agents are prone to "infinite loops" -- repetitive behaviors where the agent executes the same actions without making progress.

- **Stagnation:** Submitting the same code and getting the same result repeatedly.
- **Stuck:** Trying different approaches that all produce the same outcome.

## 3. Architecture
### Layer 1: StepLoopDetector (Agent Level)
#### 2x2 Progress Matrix
|  | **New outcome** | **Repeated outcome** |
|-|-|-|
| **New approach** | Full progress | Stuck |
| **Repeated approach** | World changed | Full stagnation |

- **Stuck**: Increment stuck streak, reset stagnation streak
- **Full stagnation**: Increment stagnation streak, reset stuck streak

#### Thresholds
| Condition | Warn | Block |
|-|-|-|
| Stagnation | 3 | 5 |
| Stuck | 5 | 8 |

## [doc:https://github.com/vstorm-co/pydantic-deepagents/blob/650b592b6accd7dc994226abbaa0cf717527e457/docs/advanced/stuck-loop-detection.md] (doc) Stuck-loop detection
License: MIT
# Stuck-loop detection
Sometimes an agent gets stuck. It reads the same file again and again, bounces between two tools forever, or keeps calling something that does nothing. Left alone, it burns tokens and never finishes. Stuck-loop detection watches for that and steps in — nudging the model to try something else, or stopping the run.

It's on by default. You already have it.

## How it works
Stuck-loop detection is a [capability][pydantic_deep.features.stuck_loop.StuckLoopDetection] — it hooks into the agent lifecycle and runs after every tool call. Then it checks the recent history against the three patterns above.

When a pattern matches, what happens next depends on `action`:

Each run gets its own fresh detection state (via `for_run()`), so concurrent runs never share history or trip over each other.

!!! note "The model sees the nudge" With `action="warn"`, the message is handed back to the model as a retry _3 times in a row._ _Try a different approach."_ Most of the time that's enough to break the loop.

## Tuning it
You can dial the behaviour by passing your own `StuckLoopDetection` instance.

## Handling a hard stop
When you choose `action="error"`, catch `StuckLoopError` to decide what happens next. It carries a `pattern` attribute telling you which shape tripped — `"repeated"`, `"alternating"`, or `"noop"`:

!!! agent actually loops, and it gives the model a chance to recover on its own. Reach for `create_deep_agent(stuck_loop_detection=False)` only when

## [issue:pydantic/pydantic-ai#9008] (issue) Add a `DetectLoops` capability to interrupt repeated-action loops#9008
https://github.com/pydantic/pydantic-ai/issues/9008
License: MIT
# Add a `DetectLoops` capability to interrupt repeated-action loops\#9008

Assignees

## Description

adtyavrdhn

> Transferred from pydantic/pydantic-ai-harness#71 after harness moved into this repo. Harness paths map to `src/pydantic_ai_harness/pydantic_ai_harness/`, `tests/harness/` and `docs/harness/`.

## Summary

Multi-scenario detection of repetitive agent behavior with configurable recovery strategies. Every mature agent harness implements this — it's critical for autonomous operation.

## Who has this

### OpenHands — 5 detection scenarios (`controller/stuck.py`)

| Scenario | Detection | Threshold |
| --- | --- | --- |
| 1 | Identical action-observation pairs repeating | 4+ repetitions |
| 2 | Identical actions producing errors | 3+ repetitions |
| 3 | Agent monologues (repeated MessageAction) | Configurable |
| 4 | Alternating action-observation every other step | 6+ steps |
| 5 | Context window error loops (CondensationObservation) | 10+ events |

Returns `StuckAnalysis(loop_type, repeat_count, start_index)` for targeted recovery.

**Recovery options** (`agent_controller.py:1141-1390`):

1. Restart from before loop (truncate memory to recovery point)
2. Restart with last user message
3. Stop agent completely

### Goose — RepetitionInspector (`tool_inspection.rs:10-160`)

Part of pluggable inspector chain — detects tool call repetition alongside SecurityInspector, AdversaryInspector, PermissionInspector.
… (136 more lines)

## [doc:https://github.com/tylerjrbuell/reactive-agents/blob/8cc55131aeec2e98bdfd27284b31401599d302ce/docs/agent/LOOP_DETECTION_COMPLETE.md] (doc) Loop Detection System - Complete ✅
# Loop Detection System - Complete ✅

**Date:** January 14, 2026
**Status:** Implemented & Unit Tested
**Integration:** ToolManager + ExecutionEngine

---

## Problem Statement

From `REASONING_ANALYSIS.md`:
> **Critical Failure:** Agent repeats same actions 10+ times without recognizing futility

Agents would get stuck in loops:
- Calling the same tool repeatedly with same parameters
- Trying the same failed approach over and over
- No self-awareness of the loop
- No automatic intervention

---

## Solution Architecture

### 1. **LoopDetector Class**

**File:** `reactive_agents/core/engine/loop_detector.py`

A specialized component that tracks tool calls and detects three types of loops:

#### Loop Types

1. **Exact Loops** (Highest confidence: 1.0)
   - Same tool + same parameters repeated N times
   - Example: `search(query="weather")` called 5 times
   - **Threshold:** 3 repetitions (configurable)

2. **Similar Loops** (Medium confidence: 0.6-0.9)
   - Same tool with similar (but not identical) parameters
   - Example: `search(query="weather today")`, `search(query="today weather")`, etc.
… (57 more lines)

## [doc:https://openclawlab.com/en/docs/tools/loop-detection/] (doc) Tool-loop detection
Documentation

Tools

Tool-loop detection

# Tool-loop detection

OpenClaw can keep agents from getting stuck in repeated tool-call patterns.
The guard is **disabled by default**.

Enable it only where needed, because it can block legitimate repeated calls with strict settings.

## Why this exists Permalink for this section

- Detect repetitive sequences that do not make progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated errors).
- Detect specific repeated-call patterns for known polling tools.

## Configuration block Permalink for this section

Global defaults:
… (51 more lines)

## [issue:openhands/openhands#8269] (issue) [Bug]: Browsing gets stuck in loop#8269
https://github.com/openhands/openhands/issues/8269
License: MIT
# \[Bug\]: Browsing gets stuck in loop\#8269

## Description

csmith49

### Is there an existing issue for the same bug? (If one exists, thumbs up or comment on the issue instead).

- I have checked the existing issues.

### Describe the bug and reproduction steps

In long-running sessions with browsing, the agent will sometimes get stuck in a loop where the same actions are repeated over and over.

### OpenHands Installation

Docker command in README

### OpenHands Version

_No response_

### Operating System

None

### Logs, Errors, Screenshots, and Additional Context

_No response_

I think it has some check itself for the case it has an error every step; then it stops its own loop. If it's not an error, but repeated action/obs, the controller should stop it.

Could you please tell, for how many steps did it go on?

Do you have by any chance a trajectory or event stream with it?

CollaboratorAuthor

@enyst I've got a few trajectories where the repetition isn't so obvious, and Xingyao has a few where it's just `browse -> browse -> browse -> ... -> browse`. Once I get my hands on those I'll post some more details here.
… (6 more lines)