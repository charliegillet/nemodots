> ## Documentation Index
>
> Fetch the complete documentation index at: [/llms.txt](https://docs.openhands.dev/llms.txt)
>
> Use this file to discover all available pages before exploring further.

[Skip to main content](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#content-area)

[OpenHands Docs home page![light logo](https://mintcdn.com/allhandsai/DjhqLcIy_hW6pRTg/logo/light.png?fit=max&auto=format&n=DjhqLcIy_hW6pRTg&q=85&s=49b636402b03f7279ca5e1afefeec1d2)![dark logo](https://mintcdn.com/allhandsai/DjhqLcIy_hW6pRTg/logo/dark.png?fit=max&auto=format&n=DjhqLcIy_hW6pRTg&q=85&s=e0c4017631cebc3a289798438e2c0d7a)](https://docs.openhands.dev/)

Search...

Ctrl KAsk AssistantCtrl+I

- [OpenHands/OpenHands\\
\\
91,103](https://github.com/OpenHands/OpenHands "OpenHands/OpenHands")
- [OpenHands/OpenHands\\
\\
91,103](https://github.com/OpenHands/OpenHands "OpenHands/OpenHands")

Search...

Navigation

Agent Features

Stuck Detector

[Home](https://docs.openhands.dev/overview/introduction) [Agent Canvas](https://docs.openhands.dev/openhands/usage/agent-canvas/overview) [SDK](https://docs.openhands.dev/sdk) [Cloud](https://docs.openhands.dev/openhands/usage/cloud/openhands-cloud) [Enterprise](https://docs.openhands.dev/enterprise) [Enterprise Cookbook](https://docs.openhands.dev/cookbook)

- [Software Agent SDK](https://docs.openhands.dev/sdk)

- [Getting Started](https://docs.openhands.dev/sdk/getting-started)

- [FAQ](https://docs.openhands.dev/sdk/faq)

### Guides

- [Hello World](https://docs.openhands.dev/sdk/guides/hello-world)
- [Custom Tools](https://docs.openhands.dev/sdk/guides/custom-tools)
- [Structured Output](https://docs.openhands.dev/sdk/guides/structured-output)
- [Model Context Protocol](https://docs.openhands.dev/sdk/guides/mcp)
- [Agent Skills & Context](https://docs.openhands.dev/sdk/guides/skill)
- [Plugins](https://docs.openhands.dev/sdk/guides/plugins)
- [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- [Context Condenser](https://docs.openhands.dev/sdk/guides/context-condenser)
- [Persistent Memory](https://docs.openhands.dev/sdk/guides/persistent-memory)
- [Agent Settings](https://docs.openhands.dev/sdk/guides/agent-settings)
- [Parallel Tool Execution](https://docs.openhands.dev/sdk/guides/parallel-tool-execution)
- [Task Tool Set](https://docs.openhands.dev/sdk/guides/task-tool-set)
- [Iterative Refinement](https://docs.openhands.dev/sdk/guides/iterative-refinement)
- [Security & Action Confirmation](https://docs.openhands.dev/sdk/guides/security)
- [Metrics Tracking](https://docs.openhands.dev/sdk/guides/metrics)
- [Observability & Tracing](https://docs.openhands.dev/sdk/guides/observability)
- [Secret Registry](https://docs.openhands.dev/sdk/guides/secrets)
- LLM Features

- Agent Features



  - [ACP Agent](https://docs.openhands.dev/sdk/guides/agent-acp)
  - [Interactive Terminal](https://docs.openhands.dev/sdk/guides/agent-interactive-terminal)
  - [Browser Use](https://docs.openhands.dev/sdk/guides/agent-browser-use)
  - [Browser Session Recording](https://docs.openhands.dev/sdk/guides/browser-session-recording)
  - [Creating Custom Agent](https://docs.openhands.dev/sdk/guides/agent-custom)
  - [File-Based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based)
  - [Stuck Detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
  - [Ask Oracle](https://docs.openhands.dev/sdk/guides/agent-ask-oracle)
  - [Theory of Mind (TOM) Agent](https://docs.openhands.dev/sdk/guides/agent-tom-agent)
  - [Critic (Experimental)](https://docs.openhands.dev/sdk/guides/critic)
- Conversation Features

- Remote Agent Server

- GitHub Workflows


### Architecture

- [Overview](https://docs.openhands.dev/sdk/arch/overview)
- [Design Principles](https://docs.openhands.dev/sdk/arch/design)
- SDK Components


### API Reference

- [openhands.sdk.agent](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.agent)
- [openhands.sdk.conversation](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation)
- [openhands.sdk.event](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.event)
- [openhands.sdk.llm](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.llm)
- [openhands.sdk.security](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.security)
- [openhands.sdk.tool](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.tool)
- [openhands.sdk.utils](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.utils)
- [openhands.sdk.workspace](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.workspace)

## On this page

- [How It Works](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#how-it-works)
- [Pattern Detection](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#pattern-detection)
- [Ready-to-run Example](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#ready-to-run-example)
- [Next Steps](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#next-steps)

Agent Features

# Stuck Detector

Copy pageCopy page

Detect and handle stuck agents automatically with timeout mechanisms.

Copy pageCopy page

> A ready-to-run example is available [here](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#ready-to-run-example)!

The Stuck Detector automatically identifies when an agent enters unproductive patterns such as repeating the same actions, encountering repeated errors, or engaging in monologues. By analyzing the conversation history after the last user message, it detects five types of stuck patterns:

1. **Repeating Action-Observation Cycles**: The same action produces the same observation repeatedly (4+ times)
2. **Repeating Action-Error Cycles**: The same action repeatedly results in errors (3+ times)
3. **Agent Monologue**: The agent sends multiple consecutive messages without user input or meaningful progress (3+ messages)
4. **Alternating Patterns**: Two different action-observation pairs alternate in a ping-pong pattern (6+ cycles)
5. **Context Window Errors**: Repeated context window errors that indicate memory management issues

When enabled (which is the default), the stuck detector monitors the conversation in real-time and can automatically halt execution when stuck patterns are detected, preventing infinite loops and wasted resources.

For more information about the detection algorithms and how pattern matching works, refer to the [StuckDetector source code](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py).

## [​](https://docs.openhands.dev/sdk/guides/agent-stuck-detector\#how-it-works)  How It Works

In the [ready-to-run example](https://docs.openhands.dev/sdk/guides/agent-stuck-detector#ready-to-run-example), the agent is deliberately given a task designed to trigger stuck detection - executing the same `ls`
command 5 times in a row. The stuck detector analyzes the event history and identifies the repetitive pattern:

1. The conversation proceeds normally until the agent starts repeating actions
2. After detecting the pattern (4 identical action-observation pairs), the stuck detector flags the conversation as stuck
3. The conversation can then handle this gracefully, either by stopping execution or taking corrective action

The example demonstrates that stuck detection is enabled by default (`stuck_detection=True`), and you can check the
stuck status at any point using `conversation.stuck_detector.is_stuck()`.

## [​](https://docs.openhands.dev/sdk/guides/agent-stuck-detector\#pattern-detection)  Pattern Detection

The stuck detector compares events based on their semantic content rather than object identity. For example:

- **Actions** are compared by their tool name, action content, and thought (ignoring IDs and metrics)
- **Observations** are compared by their observation content and tool name
- **Errors** are compared by their error messages
- **Messages** are compared by their content and source

This allows the detector to identify truly repetitive behavior while ignoring superficial differences like timestamps or event IDs.

## [​](https://docs.openhands.dev/sdk/guides/agent-stuck-detector\#ready-to-run-example)  Ready-to-run Example

This example is available on GitHub: [examples/01\_standalone\_sdk/20\_stuck\_detector.py](https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/20_stuck_detector.py)

examples/01\_standalone\_sdk/20\_stuck\_detector.py

```
import os

from pydantic import SecretStr

from openhands.sdk import (
    LLM,
    Conversation,
    Event,
    LLMConvertibleEvent,
    get_logger,
)
from openhands.tools.preset.default import get_default_agent

logger = get_logger(__name__)

# Configure LLM
api_key = os.getenv("LLM_API_KEY")
assert api_key is not None, "LLM_API_KEY environment variable is not set."
model = os.getenv("LLM_MODEL", "anthropic/claude-sonnet-4-5-20250929")
base_url = os.getenv("LLM_BASE_URL")
llm = LLM(
    usage_id="agent",
    model=model,
    base_url=base_url,
    api_key=SecretStr(api_key),
)

agent = get_default_agent(llm=llm)

llm_messages = []

def conversation_callback(event: Event):
    if isinstance(event, LLMConvertibleEvent):
        llm_messages.append(event.to_llm_message())

# Create conversation with built-in stuck detection
conversation = Conversation(
    agent=agent,
    callbacks=[conversation_callback],
    workspace=os.getcwd(),
    # This is by default True, shown here for clarity of the example
    stuck_detection=True,
)

# Send a task that will be caught by stuck detection
conversation.send_message(
    "Please execute 'ls' command 5 times, each in its own "
    "action without any thought and then exit at the 6th step."
)

# Run the conversation - stuck detection happens automatically
conversation.run()

assert conversation.stuck_detector is not None
final_stuck_check = conversation.stuck_detector.is_stuck()
print(f"Final stuck status: {final_stuck_check}")

print("=" * 100)
print("Conversation finished. Got the following LLM messages:")
for i, message in enumerate(llm_messages):
    print(f"Message {i}: {str(message)[:200]}")

# Report cost
cost = llm.metrics.accumulated_cost
print(f"EXAMPLE_COST: {cost}")
```

See all 68 lines

You can run the example code as-is.

The model name should follow the [LiteLLM convention](https://models.litellm.ai/): `provider/model_name` (e.g., `anthropic/claude-sonnet-4-5-20250929`, `openai/gpt-4o`).
The `LLM_API_KEY` should be the API key for your chosen provider.

Bring-your-own provider key

OpenHands Cloud

```
export LLM_API_KEY="your-api-key"
export LLM_MODEL="anthropic/claude-sonnet-4-5-20250929"  # or openai/gpt-4o, etc.
cd software-agent-sdk
uv run python examples/01_standalone_sdk/20_stuck_detector.py
```

\# https://app.all-hands.dev/settings/api-keys
export LLM\_API\_KEY="your-openhands-api-key"
export LLM\_MODEL="openhands/claude-sonnet-4-5-20250929"
cd software-agent-sdk
uv run python examples/01\_standalone\_sdk/20\_stuck\_detector.py

**ChatGPT Plus/Pro subscribers**: You can use `LLM.subscription_login()` to authenticate with your ChatGPT account and access Codex models without consuming API credits. See the [LLM Subscriptions guide](https://docs.openhands.dev/sdk/guides/llm-subscriptions) for details.

## [​](https://docs.openhands.dev/sdk/guides/agent-stuck-detector\#next-steps)  Next Steps

- **[Conversation Pause and Resume](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume)** \- Manual execution control
- **[Hello World](https://docs.openhands.dev/sdk/guides/hello-world)** \- Learn the basics of the SDK

Was this page helpful?

YesNo

[File-Based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based) [Ask Oracle](https://docs.openhands.dev/sdk/guides/agent-ask-oracle)

[OpenHands Docs home page![light logo](https://mintcdn.com/allhandsai/DjhqLcIy_hW6pRTg/logo/light.png?fit=max&auto=format&n=DjhqLcIy_hW6pRTg&q=85&s=49b636402b03f7279ca5e1afefeec1d2)![dark logo](https://mintcdn.com/allhandsai/DjhqLcIy_hW6pRTg/logo/dark.png?fit=max&auto=format&n=DjhqLcIy_hW6pRTg&q=85&s=e0c4017631cebc3a289798438e2c0d7a)](https://docs.openhands.dev/)

[slack](https://openhands.dev/joinslack) [github](https://github.com/OpenHands)

[Company](https://openhands.dev/) [Blog](https://openhands.dev/blog) [Cloud](https://app.all-hands.dev/) [Enterprise](https://openhands.dev/enterprise)

[slack](https://openhands.dev/joinslack) [github](https://github.com/OpenHands)

[Powered byThis documentation is built and hosted on Mintlify, a developer documentation platform](https://www.mintlify.com/?utm_campaign=poweredBy&utm_medium=referral&utm_source=allhandsai)

Assistant

Responses are generated using AI and may contain mistakes.

[Contact support](mailto:contact@openhands.dev)