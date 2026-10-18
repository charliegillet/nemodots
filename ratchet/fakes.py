"""Test doubles shared by every owner's unit tests. OWNED BY docs/PLAN.md. No network.

FakeLLM returns scripted ChatResults in order (cycling the last one when the script runs out
unless strict=True) and records every call so tests can assert on prompts.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from ratchet.types import ChatResult, ToolCall, Usage


def assistant(content: str, *, model: str = "fake", finish_reason: str = "stop",
              prompt_tokens: int = 100, completion_tokens: int = 20) -> ChatResult:
    """A plain assistant text reply."""
    return ChatResult(
        model=model,
        message={"role": "assistant", "content": content},
        content=content,
        reasoning="",
        tool_calls=[],
        finish_reason=finish_reason,
        usage=Usage(requests=1, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
    )


def tool_call(name: str, arguments: dict[str, Any], *, content: str = "", model: str = "fake",
              call_id: str | None = None) -> ChatResult:
    """An assistant reply that calls exactly one tool."""
    cid = call_id or f"call_{uuid.uuid4().hex[:8]}"
    raw = json.dumps(arguments)
    return ChatResult(
        model=model,
        message={
            "role": "assistant",
            "content": content or None,
            "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": raw}}],
        },
        content=content,
        reasoning="",
        tool_calls=[ToolCall(id=cid, name=name, arguments=arguments, raw_arguments=raw)],
        finish_reason="tool_calls",
        usage=Usage(requests=1, prompt_tokens=100, completion_tokens=30),
    )


class FakeLLM:
    """Scripted LLM. `script` items are ChatResults or callables (messages -> ChatResult)."""

    def __init__(self, script: list[Any], *, strict: bool = False):
        self.script = list(script)
        self.strict = strict
        self.calls: list[dict[str, Any]] = []
        self._i = 0

    def chat(self, *, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
             thinking: bool = False, max_tokens: int = 2048, temperature: float = 0.2,
             seed: int | None = None, response_format: dict[str, Any] | None = None,
             tag: str = "") -> ChatResult:
        self.calls.append({
            "model": model, "messages": [dict(m) for m in messages], "tools": tools, "thinking": thinking,
            "max_tokens": max_tokens, "temperature": temperature, "seed": seed,
            "response_format": response_format, "tag": tag,
        })
        if self._i >= len(self.script):
            if self.strict or not self.script:
                raise AssertionError(f"FakeLLM script exhausted after {self._i} calls")
            item = self.script[-1]
        else:
            item = self.script[self._i]
            self._i += 1
        result = item(messages) if callable(item) else item
        result.model = model
        return result
