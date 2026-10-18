#!/usr/bin/env python3
"""Crusoe proxy for OpenBot's shipped `agent-bot` (Ratchet integration, owner I4).

OpenBot's `agent-bot` (vendor/openbot/agent-bot/src/index.ts) calls `{OPENAI_BASE_URL}/chat/completions`
with `stream: true`, no `max_tokens`, no `temperature`, no `seed`, and nothing that turns Nemotron's
default reasoning off. Pointed straight at Crusoe, a Lightning turn can spend its whole budget in
`message.reasoning` and come back empty, and the Bot cannot report usage back to us. This proxy sits
between the two:

    agent-bot --(stream, key MANAGED_AGENT_TOKEN)--> 127.0.0.1:8787 --(real key)--> Crusoe Managed Inference

What it does to every `POST /v1/chat/completions`:

* removes the Ratchet run-metadata system message (see `META_DESCRIPTION`) that `OpenBotWorker` sends as
  AG-UI `context` (agent-bot turns each context item into a system message `"<description>\\n<value>"`).
  The model never sees it. It carries the usage-ledger tag, a per-turn run id, the paired seed and
  whether the caller records usage itself. When that metadata says `"host_guidance": "strip"`, agent-bot's
  fixed COMPUTER_GUIDANCE system message (browser tools the coworker does not have) is removed too, so the
  model reads the same prompt as a LocalWorker run;
* injects `chat_template_kwargs = {"enable_thinking": false, "force_nonempty_content": true}` unless the
  body already has `chat_template_kwargs` (thinking follows `Settings.worker_thinking`);
* raises `max_tokens` (or `max_completion_tokens`) to at least 2048; sets `temperature` to
  `Settings.worker_temperature` and `seed` to the run's seed when the body has none; drops
  `tool_choice="required"` (breaks Nemotron) and empty `tools` lists;
* answers a streamed request from ONE non-streamed Crusoe completion replayed as SSE chunks
  ("buffered", the default). Measured on 2026-10-17: with `stream: true`, Crusoe's tool-call parser left
  Lightning's tool call in `content` as `<function=write_file><parameter=...>` text in 2 of 4 identical
  requests, while the same request non-streamed returned a proper `tool_calls` entry 4 of 4 times. Buffering
  also gives the Bot exactly the request shape `CrusoeClient` uses for `LocalWorker`, and lets the proxy
  apply `CrusoeClient`'s empty-cut-off retry (double `max_tokens` once, cap 16384). `--stream-passthrough`
  (or `RATCHET_PROXY_STREAM=passthrough`) relays Crusoe's own stream instead, with
  `stream_options.include_usage` so streamed calls still report tokens;
* replaces the inbound `Authorization` with the real Crusoe key from `Settings.from_env()` (the key never
  leaves this process and is never logged; inbound headers are not forwarded at all);
* paces requests per model (same `max_inflight_per_model` / `rpm_per_model` budget as `CrusoeClient`) and
  retries 429/500/502/503/504 and connection errors before any byte reaches the Bot, with jittered
  exponential backoff that honours `Retry-After`, within a retry window (`retry_window_s`, 150 s by default)
  that ends before OpenBotWorker gives up on the turn; after it, the last 429/5xx is relayed;
* relays the response (SSE line by line, or JSON) unchanged;
* records usage: per turn in memory (`GET /usage/<run_id>`, read by `OpenBotWorker`) and, unless the
  caller said it records usage itself, one line in `runs/llm_calls.jsonl` via `ratchet.llm.UsageLedger`
  (falls back to an identical line format when `ratchet.llm` is not importable).

Other endpoints: `GET /health`, `GET /usage/<run_id>`, `GET /v1/models` (forwarded).

Run: `.venv/bin/python integrations/openbot/crusoe_proxy.py [--host 127.0.0.1] [--port 8787]`
(normally started by `integrations/openbot/setup.sh`). Pure stdlib + httpx.
"""
from __future__ import annotations

import argparse
import copy
import hmac
import json
import logging
import os
import random
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ratchet.config import PRICES_PER_M, Settings  # noqa: E402
from ratchet.types import Usage, utcnow  # noqa: E402

log = logging.getLogger("ratchet.openbot.proxy")

META_DESCRIPTION = "[ratchet-run-meta]"
# First line of agent-bot's fixed COMPUTER_GUIDANCE system message (vendor/openbot/shared/bot-prompt.ts).
# It describes computer_* browser tools a Ratchet coworker does not have; a run whose metadata asks for it
# (`"host_guidance": "strip"`, sent by OpenBotWorker) gets it removed so the model reads the same prompt a
# LocalWorker run reads.
HOST_GUIDANCE_PREFIX = "You are a Bot with your own computer, a real web browser"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
MIN_MAX_TOKENS = 4096   # matches Settings.worker_max_tokens
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
USAGE_BOOK_CAPACITY = 20000


# --------------------------------------------------------------------------- pure helpers (unit-tested)


def extract_run_meta(messages: list[Any]) -> tuple[list[Any], dict[str, Any]]:
    """Remove Ratchet's run-metadata system message(s) and return (messages, meta).

    agent-bot renders an AG-UI context item `{description, value}` as a system message
    `f"{description}\\n{value}"`. `value` is JSON. Malformed metadata is dropped (and ignored)."""
    meta: dict[str, Any] = {}
    kept: list[Any] = []
    prefix = META_DESCRIPTION + "\n"
    for m in messages if isinstance(messages, list) else []:
        content = m.get("content") if isinstance(m, dict) else None
        if isinstance(m, dict) and m.get("role") == "system" and isinstance(content, str) and content.startswith(prefix):
            try:
                parsed = json.loads(content[len(prefix):])
                if isinstance(parsed, dict):
                    meta.update(parsed)
            except ValueError:
                pass
            continue
        kept.append(m)
    return kept, meta


def rewrite_body(
    body: dict[str, Any],
    *,
    thinking: bool = False,
    min_max_tokens: int = MIN_MAX_TOKENS,
    temperature: float | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    """Return a rewritten copy of a chat-completions request body (see module docstring)."""
    out = copy.deepcopy(body)
    if "chat_template_kwargs" not in out:
        kwargs: dict[str, Any] = {"enable_thinking": bool(thinking)}
        if not thinking:
            kwargs["force_nonempty_content"] = True
        out["chat_template_kwargs"] = kwargs
    key = "max_completion_tokens" if "max_completion_tokens" in out and "max_tokens" not in out else "max_tokens"
    current = out.get(key)
    if not isinstance(current, int) or current < min_max_tokens:
        out[key] = min_max_tokens
    if out.get("stream"):
        opts = out.get("stream_options") if isinstance(out.get("stream_options"), dict) else {}
        out["stream_options"] = {**opts, "include_usage": True}
    if temperature is not None and out.get("temperature") is None:
        out["temperature"] = temperature
    if seed is not None and out.get("seed") is None:
        out["seed"] = int(seed)
    if out.get("tool_choice") == "required":
        out.pop("tool_choice")
    if "tools" in out and not out["tools"]:
        out.pop("tools")
        out.pop("tool_choice", None)
    return out


def strip_host_guidance(messages: list[Any]) -> tuple[list[Any], int]:
    """Drop agent-bot's COMPUTER_GUIDANCE system message(s). Returns (messages, number removed)."""
    kept = [m for m in messages
            if not (isinstance(m, dict) and m.get("role") == "system" and isinstance(m.get("content"), str)
                    and m["content"].lstrip().startswith(HOST_GUIDANCE_PREFIX))]
    return kept, len(messages) - len(kept)


def prepare_request(body: dict[str, Any], settings: Settings) -> tuple[dict[str, Any], dict[str, Any]]:
    """Strip run metadata (and, when the run asks for it, agent-bot's computer guidance), then rewrite.
    Returns (upstream_body, meta)."""
    messages, meta = extract_run_meta(body.get("messages", []))
    if meta.get("host_guidance") == "strip":
        messages, _ = strip_host_guidance(messages)
    stripped = dict(body)
    stripped["messages"] = messages
    seed = meta.get("seed")
    out = rewrite_body(
        stripped,
        thinking=settings.worker_thinking,
        min_max_tokens=max(MIN_MAX_TOKENS, int(settings.worker_max_tokens)),
        temperature=settings.worker_temperature,
        seed=seed if isinstance(seed, int) else None,
    )
    return out, meta


def upstream_headers(api_key: str, *, stream: bool) -> dict[str, str]:
    """Headers sent to Crusoe. Built from scratch: nothing inbound (Authorization included) is forwarded."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }


def _price(model: str) -> tuple[float, float, float]:
    return PRICES_PER_M.get(model, (0.0, 0.0, 0.0))


def _compute_cost(model: str, prompt: int, completion: int, cached: int) -> float:
    try:
        from ratchet.llm import compute_cost  # I1; preferred so the proxy and CrusoeClient agree

        return float(compute_cost(model, prompt, completion, cached))
    except Exception:  # noqa: BLE001 - ratchet.llm missing or different; same formula locally
        p_in, p_out, p_cached = _price(model)
        return round((prompt - cached) * p_in / 1e6 + cached * p_cached / 1e6 + completion * p_out / 1e6, 10)


def usage_from_payload(usage: dict[str, Any] | None, model: str) -> Usage:
    """OpenAI-style `usage` object -> ratchet Usage (one request, cost applied)."""
    usage = usage or {}
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    details = usage.get("prompt_tokens_details")
    cached_reported = isinstance(details, dict) and details.get("cached_tokens") is not None
    cached = int(details["cached_tokens"]) if cached_reported else 0
    return Usage(
        requests=1,
        prompt_tokens=prompt,
        completion_tokens=completion,
        cached_tokens=cached,
        cached_reported=cached_reported,
        cost_usd=_compute_cost(model, prompt, completion, cached),
    )


class StreamTracker:
    """Watches relayed SSE lines for the model, finish_reason and the final usage chunk."""

    def __init__(self, model: str):
        self.model = model
        self.usage: dict[str, Any] | None = None
        self.finish_reason: str = ""
        self.done = False
        self.content_chars = 0
        self.tool_calls = 0

    def feed(self, line: str) -> None:
        if not line.startswith("data:"):
            return
        data = line[5:].strip()
        if data == "[DONE]":
            self.done = True
            return
        try:
            chunk = json.loads(data)
        except ValueError:
            return
        if not isinstance(chunk, dict):
            return
        if isinstance(chunk.get("usage"), dict):
            self.usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            if choice.get("finish_reason"):
                self.finish_reason = str(choice["finish_reason"])
            delta = choice.get("delta") or {}
            if isinstance(delta, dict):
                if isinstance(delta.get("content"), str):
                    self.content_chars += len(delta["content"])
                for call in delta.get("tool_calls") or []:
                    if isinstance(call, dict) and call.get("id"):
                        self.tool_calls += 1


def completion_finish_reason(obj: dict[str, Any]) -> str:
    choices = obj.get("choices") or [{}]
    return str((choices[0] or {}).get("finish_reason") or "")


def completion_is_empty(obj: dict[str, Any]) -> bool:
    """True when a non-streamed completion has neither text content nor tool calls."""
    choices = obj.get("choices") or [{}]
    msg = (choices[0] or {}).get("message") or {}
    return not (msg.get("content") or "").strip() and not msg.get("tool_calls")


def recover_text_tool_calls(obj: dict[str, Any], tools: list[dict[str, Any]] | None) -> int:
    """In place: turn tool calls Nemotron wrote into the message text (``<function=NAME>...``) into
    structured ``tool_calls`` (same rule as ``CrusoeClient``). Returns how many were recovered."""
    from ratchet.llm import parse_text_tool_calls

    choice = (obj.get("choices") or [{}])[0] or {}
    msg = choice.get("message") or {}
    if msg.get("tool_calls") or not tools:
        return 0
    text, calls = parse_text_tool_calls(msg.get("content") or "", tools)
    if not calls:
        return 0
    stamp = int(time.time() * 1000) % 10**8
    msg["content"] = text or None
    msg["tool_calls"] = [{"id": f"call_txt{i}_{stamp}", "type": "function",
                          "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)}}
                         for i, (n, a) in enumerate(calls)]
    if choice.get("finish_reason") == "stop":
        choice["finish_reason"] = "tool_calls"
    return len(calls)


def synthesize_sse_lines(obj: dict[str, Any]) -> list[str]:
    """Replay one non-streamed chat completion as OpenAI `chat.completion.chunk` SSE lines (role+content,
    one chunk per tool call with complete arguments, finish chunk, usage chunk, [DONE]).

    This is exactly what agent-bot's streaming loop consumes (it buffers tool calls by `index`)."""
    cid = str(obj.get("id") or "chatcmpl-ratchet")
    created = int(obj.get("created") or time.time())
    model = str(obj.get("model") or "")
    choice = (obj.get("choices") or [{}])[0] or {}
    msg = choice.get("message") or {}

    def chunk(delta: dict[str, Any], finish: str | None = None, **extra: Any) -> str:
        body = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}
        return "data: " + json.dumps(body, ensure_ascii=False)

    lines: list[str] = []
    first: dict[str, Any] = {"role": "assistant"}
    if msg.get("content"):
        first["content"] = msg["content"]
    lines += [chunk(first), ""]
    for i, call in enumerate(msg.get("tool_calls") or []):
        fn = call.get("function") or {}
        args = fn.get("arguments")
        delta = {"tool_calls": [{"index": i, "id": call.get("id") or f"call_{i}", "type": "function",
                                 "function": {"name": fn.get("name", ""),
                                              "arguments": args if isinstance(args, str) else json.dumps(args or {})}}]}
        lines += [chunk(delta), ""]
    lines += [chunk({}, str(choice.get("finish_reason") or "stop")), ""]
    if isinstance(obj.get("usage"), dict):
        lines += ["data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                         "model": model, "choices": [], "usage": obj["usage"]}), ""]
    lines += ["data: [DONE]", ""]
    return lines


def retry_window_s(settings: Settings, env: dict[str, str] | None = None) -> float:
    """How long one proxied call may spend waiting for pacing and retries before it gives up.

    OpenBotWorker abandons an AG-UI turn after ``max(request_timeout_s, 60) + 180`` seconds and retries it
    under a new run id; a proxy still retrying then would complete (and bill) a call nobody reads. The
    window leaves room for one more full upstream request plus 30 s of slack inside that timeout
    (150 s with the defaults). ``RATCHET_PROXY_RETRY_WINDOW_S`` overrides it."""
    env = os.environ if env is None else env
    raw = (env.get("RATCHET_PROXY_RETRY_WINDOW_S") or "").strip()
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            pass
    turn_timeout = max(settings.request_timeout_s, 60.0) + 180.0
    return max(30.0, turn_timeout - settings.request_timeout_s - 30.0)


def backoff_delay(attempt: int, *, base: float, cap: float, retry_after: str | None = None,
                  rand: Callable[[float, float], float] = random.uniform) -> float:
    """Same policy as CrusoeClient: min(cap, base * 2**attempt) * U(0.5, 1.5); Retry-After wins if larger."""
    delay = min(cap, base * (2 ** attempt)) * rand(0.5, 1.5)
    if retry_after:
        try:
            delay = max(delay, min(cap, float(retry_after)))
        except ValueError:
            pass
    return max(0.0, delay)


# --------------------------------------------------------------------------- shared state


class UsageBook:
    """Thread-safe, bounded run_id -> aggregated usage of every upstream call made for that AG-UI run."""

    def __init__(self, capacity: int = USAGE_BOOK_CAPACITY):
        self._lock = threading.Lock()
        self._data: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.capacity = capacity

    def add(self, run_id: str, *, tag: str, model: str, usage: Usage, finish_reason: str,
            latency_ms: int, attempts: int, status: int, error: str = "") -> None:
        with self._lock:
            rec = self._data.get(run_id)
            if rec is None:
                rec = {"run_id": run_id, "tag": tag, "model": model, "calls": 0, "usage": Usage(),
                       "finish_reason": "", "latency_ms": 0, "attempts": 0, "status": status, "error": ""}
                self._data[run_id] = rec
            if error:
                rec["error"] = error
            rec["calls"] += 1
            rec["usage"] = rec["usage"] + usage
            rec["finish_reason"] = finish_reason or rec["finish_reason"]
            rec["latency_ms"] += int(latency_ms)
            rec["attempts"] += int(attempts)
            rec["status"] = status
            rec["model"] = model
            self._data.move_to_end(run_id)
            while len(self._data) > self.capacity:
                self._data.popitem(last=False)

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            rec = self._data.get(run_id)
            if rec is None:
                return None
            out = dict(rec)
            out["usage"] = rec["usage"].to_dict()
            return out


class Pacer:
    """Per-model in-flight cap + minimum spacing between request starts (no busy wait)."""

    def __init__(self, max_inflight: int, rpm: int):
        self.max_inflight = max(1, int(max_inflight))
        self.spacing = 60.0 / rpm if rpm and rpm > 0 else 0.0
        self._lock = threading.Lock()
        self._sems: dict[str, threading.BoundedSemaphore] = {}
        self._next_start: dict[str, float] = {}

    def semaphore(self, model: str) -> threading.BoundedSemaphore:
        with self._lock:
            if model not in self._sems:
                self._sems[model] = threading.BoundedSemaphore(self.max_inflight)
            return self._sems[model]

    def wait_turn(self, model: str) -> None:
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next_start.get(model, 0.0))
            self._next_start[model] = start + self.spacing
        delay = start - time.monotonic()
        if delay > 0:
            time.sleep(delay)


class LedgerSink:
    """Appends one line per upstream call to runs/llm_calls.jsonl (same format as UsageLedger)."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._ledger = None
        try:
            from ratchet.llm import UsageLedger  # I1

            self._ledger = UsageLedger(path)
        except Exception:  # noqa: BLE001 - fall back to the documented line format
            self._ledger = None

    def record(self, *, tag: str, model: str, usage: Usage, latency_ms: int, finish_reason: str,
               attempts: int, thinking: bool) -> None:
        if self._ledger is not None:
            try:
                self._ledger.record(tag=tag, model=model, usage=usage, latency_ms=latency_ms,
                                    finish_reason=finish_reason, attempts=attempts, thinking=thinking)
                return
            except Exception:  # noqa: BLE001
                log.exception("UsageLedger.record failed; writing the line directly")
        line = {
            "ts": utcnow(), "tag": tag, "model": model, "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens, "cached_tokens": usage.cached_tokens,
            "cached_reported": usage.cached_reported, "cost_usd": usage.cost_usd, "latency_ms": latency_ms,
            "finish_reason": finish_reason, "attempts": attempts, "thinking": thinking,
        }
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, sort_keys=True) + "\n")


class ProxyState:
    def __init__(self, settings: Settings, *, client: Any = None, ledger: LedgerSink | None = None,
                 sleep: Callable[[float], None] = time.sleep, buffer_streams: bool = True,
                 client_key: str | None = None):
        import httpx

        self.settings = settings
        # When set, POST /v1/chat/completions and GET /v1/models need "Authorization: Bearer <client_key>"
        # so other local processes cannot spend the Crusoe key. setup.sh passes MANAGED_AGENT_TOKEN.
        self.client_key = (client_key if client_key is not None
                           else os.environ.get("RATCHET_PROXY_CLIENT_KEY", "")).strip()
        self.client = client or httpx.Client(timeout=httpx.Timeout(settings.request_timeout_s, connect=15.0))
        self.book = UsageBook()
        self.pacer = Pacer(settings.max_inflight_per_model, settings.rpm_per_model)
        self.ledger = ledger if ledger is not None else LedgerSink(settings.runs_dir / "llm_calls.jsonl")
        self.sleep = sleep
        self.retry_window_s = retry_window_s(settings)
        self.started_at = utcnow()
        self.buffer_streams = buffer_streams
        self.calls = 0
        self._calls_lock = threading.Lock()

    @property
    def upstream(self) -> str:
        return self.settings.crusoe_base_url.rstrip("/")

    def count(self) -> None:
        with self._calls_lock:
            self.calls += 1


# --------------------------------------------------------------------------- HTTP handler


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "RatchetCrusoeProxy/1.0"
    protocol_version = "HTTP/1.0"  # one response per connection; streams end at close
    state: ProxyState  # set on the subclass made by make_server

    # ---- plumbing

    def log_message(self, fmt: str, *args: Any) -> None:  # route BaseHTTPRequestHandler logs to logging
        log.debug("%s " + fmt, self.address_string(), *args)

    def _send_json(self, status: int, obj: Any) -> None:
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        """True when no client key is configured or the request carries it (constant-time compare)."""
        key = self.state.client_key
        if not key:
            return True
        got = (self.headers.get("Authorization") or "").strip()
        if got.lower().startswith("bearer "):
            got = got[7:].strip()
        if hmac.compare_digest(got.encode(), key.encode()):
            return True
        self._send_json(401, {"error": {"message": "missing or wrong proxy client key", "type": "auth_error"}})
        return False

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    # ---- GET

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        st = self.state
        if path in ("/health", "/v1/health"):
            self._send_json(200, {
                "status": "ok",
                "service": "ratchet-crusoe-proxy",
                "upstream_host": urlsplit(st.upstream).netloc,
                "key_loaded": bool(st.settings.crusoe_api_key),
                "worker_model": st.settings.worker_model,
                "thinking": st.settings.worker_thinking,
                "streams": "buffered" if st.buffer_streams else "passthrough",
                "started_at": st.started_at,
                "calls": st.calls,
                "client_auth": bool(st.client_key),
            })
            return
        if path.startswith("/usage/"):
            rec = st.book.get(path[len("/usage/"):])
            if rec is None:
                self._send_json(404, {"error": "unknown run id"})
            else:
                self._send_json(200, rec)
            return
        if path in ("/v1/models", "/models"):
            if not self._authorized():
                return
            try:
                r = st.client.get(st.upstream + "/models", headers=upstream_headers(st.settings.crusoe_api_key, stream=False))
                self.send_response(r.status_code)
                self.send_header("Content-Type", r.headers.get("content-type", "application/json"))
                self.send_header("Content-Length", str(len(r.content)))
                self.end_headers()
                self.wfile.write(r.content)
            except Exception as exc:  # noqa: BLE001
                self._send_json(502, {"error": {"message": f"upstream unreachable: {type(exc).__name__}"}})
            return
        self._send_json(404, {"error": "not found"})

    # ---- POST

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            return
        try:
            body = json.loads(self._read_body() or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
        except ValueError as exc:
            self._send_json(400, {"error": {"message": f"bad request body: {exc}"}})
            return
        self._chat(body)

    def _send_upstream(self, payload: bytes, headers: dict[str, str], model: str, tag: str,
                       deadline: float | None = None) -> tuple[Any, int, str]:
        """POST to Crusoe with pacing and retries. Returns (response or None, attempts, last error).

        No retry starts if its backoff would end after ``deadline`` (``time.monotonic()`` seconds): the last
        retryable response (e.g. the 429) is relayed instead, so the Bot fails the turn while the worker is
        still waiting for it rather than after the worker has given up."""
        st = self.state
        url = st.upstream + "/chat/completions"
        attempts = 0
        last_error = ""

        def out_of_time(delay: float) -> bool:
            return deadline is not None and time.monotonic() + delay > deadline

        while True:
            attempts += 1
            st.pacer.wait_turn(model)
            try:
                req = st.client.build_request("POST", url, content=payload, headers=headers)
                resp = st.client.send(req, stream=True)
            except Exception as exc:  # noqa: BLE001 - connection error / timeout
                last_error = type(exc).__name__
                if attempts <= st.settings.max_retries:
                    delay = backoff_delay(attempts - 1, base=st.settings.backoff_base_s, cap=st.settings.backoff_cap_s)
                    if not out_of_time(delay):
                        st.sleep(delay)
                        continue
                    last_error += ", retry window exhausted"
                return None, attempts, last_error
            if resp.status_code in RETRY_STATUSES and attempts <= st.settings.max_retries:
                retry_after = resp.headers.get("retry-after")
                delay = backoff_delay(attempts - 1, base=st.settings.backoff_base_s,
                                      cap=st.settings.backoff_cap_s, retry_after=retry_after)
                if out_of_time(delay):
                    log.warning("upstream %s for %s (tag=%s): retry window exhausted after %d attempt(s)",
                                resp.status_code, model, tag, attempts)
                    return resp, attempts, last_error
                resp.read()
                resp.close()
                log.info("upstream %s for %s (tag=%s), retry %d", resp.status_code, model, tag, attempts)
                st.sleep(delay)
                continue
            return resp, attempts, last_error

    def _relay_error(self, resp: Any) -> None:
        data = resp.read()
        self.send_response(resp.status_code)
        self.send_header("Content-Type", resp.headers.get("content-type", "application/json"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _chat(self, body: dict[str, Any]) -> None:
        st = self.state
        out, meta = prepare_request(body, st.settings)
        model = str(out.get("model") or st.settings.worker_model)
        out["model"] = model
        tag = str(meta.get("tag") or self.headers.get("X-Ratchet-Tag") or "openbot")
        run_id = str(meta.get("run") or "")
        record_in_ledger = meta.get("ledger", "proxy") != "caller"
        client_stream = bool(out.get("stream"))
        # Buffered (default): ask Crusoe for one non-streamed completion and replay it to the Bot as SSE.
        # Crusoe's streaming tool-call parser sometimes leaves a Nemotron tool call in `content` as
        # `<function=...>` text; the non-streamed parser does not (see README), and it is the same request
        # shape CrusoeClient sends for LocalWorker.
        buffered = client_stream and st.buffer_streams
        if buffered:
            out["stream"] = False
            out.pop("stream_options", None)
        upstream_stream = bool(out.get("stream"))
        thinking = bool((out.get("chat_template_kwargs") or {}).get("enable_thinking", False))
        headers = upstream_headers(st.settings.crusoe_api_key, stream=upstream_stream)

        t0 = time.monotonic()
        deadline = t0 + st.retry_window_s
        usage, finish, total_attempts = Usage(), "", 0
        with st.pacer.semaphore(model):
            for length_retry in (False, True):
                resp, attempts, last_error = self._send_upstream(json.dumps(out).encode(), headers, model, tag,
                                                                 deadline)
                total_attempts += attempts
                if resp is None:
                    st.count()
                    self._send_json(502, {"error": {"message": f"Crusoe unreachable after {attempts} attempts ({last_error})"}})
                    log.warning("upstream unreachable model=%s tag=%s attempts=%d", model, tag, attempts)
                    return
                try:
                    if resp.status_code != 200:
                        self._relay_error(resp)
                        st.count()
                        log.warning("upstream status=%s model=%s tag=%s attempts=%d", resp.status_code, model, tag, attempts)
                        return
                    if upstream_stream:
                        usage, finish = self._relay_stream(resp, model, tag, run_id, total_attempts, t0,
                                                           record_in_ledger, thinking)
                        break
                    data = resp.read()
                finally:
                    resp.close()
                try:
                    obj = json.loads(data)
                except ValueError:
                    obj = None
                if not isinstance(obj, dict):
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {"message": "upstream returned invalid JSON"}}).encode())
                    st.count()
                    return
                call_usage = usage_from_payload(obj.get("usage"), model)
                usage = usage + call_usage
                finish = completion_finish_reason(obj)
                # Same rule as CrusoeClient: an empty, cut-off answer with thinking off is retried once
                # with twice the budget (cap 16384) before it reaches the Bot.
                if (not length_retry and not thinking and finish == "length" and completion_is_empty(obj)):
                    current = int(out.get("max_tokens") or out.get("max_completion_tokens") or MIN_MAX_TOKENS)
                    key = "max_completion_tokens" if "max_completion_tokens" in out and "max_tokens" not in out else "max_tokens"
                    out[key] = min(16384, current * 2)
                    log.info("empty cut-off answer for %s (tag=%s): retrying with max_tokens=%d", model, tag, out[key])
                    continue
                if not thinking and finish == "length" and completion_is_empty(obj):
                    # Still empty with the doubled budget: CrusoeClient raises EmptyContentError here (the
                    # LocalWorker run ends with stop_reason="error"), so answer 502 instead of relaying an
                    # empty completion the Bot would be nudged about; OpenBotWorker sees the error in /usage.
                    budget = int(out.get("max_tokens") or out.get("max_completion_tokens") or 0)
                    self._record(tag, run_id, model, usage, finish, t0, total_attempts, record_in_ledger, thinking,
                                 status=502, error="empty_content")
                    self._send_json(502, {"error": {"type": "empty_content", "code": "empty_content",
                                                    "message": f"{model}: empty content with finish_reason=length "
                                                               f"at max_tokens={budget}"}})
                    st.count()
                    log.warning("empty cut-off answer for %s (tag=%s) after the retry at max_tokens=%d: 502",
                                model, tag, budget)
                    return
                recovered = recover_text_tool_calls(obj, out.get("tools"))
                if recovered:
                    log.info("recovered %d text-format tool call(s) for %s (tag=%s)", recovered, model, tag)
                    finish = completion_finish_reason(obj)
                self._record(tag, run_id, model, usage, finish, t0, total_attempts, record_in_ledger, thinking)
                if buffered:
                    self._send_sse(synthesize_sse_lines(obj))
                else:
                    self._send_bytes(json.dumps(obj).encode())
                break
        st.count()
        log.info("call model=%s tag=%s mode=%s prompt=%d completion=%d finish=%s attempts=%d latency_ms=%d",
                 model, tag, "buffered" if buffered else ("stream" if upstream_stream else "json"),
                 usage.prompt_tokens, usage.completion_tokens, finish, total_attempts,
                 int((time.monotonic() - t0) * 1000))

    def _send_bytes(self, data: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _send_sse(self, lines: list[str]) -> None:
        data = ("\n".join(lines) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _record(self, tag: str, run_id: str, model: str, usage: Usage, finish: str, t0: float,
                attempts: int, record_in_ledger: bool, thinking: bool, *, status: int = 200,
                error: str = "") -> None:
        latency_ms = int((time.monotonic() - t0) * 1000)
        if run_id:
            self.state.book.add(run_id, tag=tag, model=model, usage=usage, finish_reason=finish,
                                latency_ms=latency_ms, attempts=attempts, status=status, error=error)
        if record_in_ledger:
            try:
                self.state.ledger.record(tag=tag, model=model, usage=usage, latency_ms=latency_ms,
                                         finish_reason=finish or "stop", attempts=attempts, thinking=thinking)
            except Exception:  # noqa: BLE001 - accounting must never break a run
                log.exception("ledger write failed")

    def _relay_stream(self, resp: Any, model: str, tag: str, run_id: str, attempts: int, t0: float,
                      record_in_ledger: bool, thinking: bool) -> tuple[Usage, str]:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        tracker = StreamTracker(model)
        recorded = False
        client_gone = False
        for line in resp.iter_lines():
            tracker.feed(line)
            if tracker.done and not recorded:
                # Record before relaying [DONE], so the Bot cannot finish its run (and the worker cannot
                # ask for this run's usage) before the usage is in the book.
                usage = usage_from_payload(tracker.usage, model) if tracker.usage else Usage(requests=1)
                self._record(tag, run_id, model, usage, tracker.finish_reason, t0, attempts, record_in_ledger, thinking)
                recorded = True
            if client_gone:
                continue
            try:
                self.wfile.write(line.encode() + b"\n")
                if not line:
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                client_gone = True
        usage = usage_from_payload(tracker.usage, model) if tracker.usage else Usage(requests=1)
        if not recorded:
            self._record(tag, run_id, model, usage, tracker.finish_reason, t0, attempts, record_in_ledger, thinking)
        try:
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        return usage, tracker.finish_reason


def make_server(settings: Settings, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, *,
                state: ProxyState | None = None, buffer_streams: bool = True) -> ThreadingHTTPServer:
    st = state or ProxyState(settings, buffer_streams=buffer_streams)
    handler = type("BoundProxyHandler", (ProxyHandler,), {"state": st})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--log-file", default="")
    ap.add_argument("--stream-passthrough", action="store_true",
                    default=os.environ.get("RATCHET_PROXY_STREAM", "").lower() == "passthrough",
                    help="relay Crusoe's own SSE stream instead of buffering one completion and replaying it "
                         "(env RATCHET_PROXY_STREAM=passthrough)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if args.log_file:
        Path(args.log_file).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(args.log_file))
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=handlers)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    settings = Settings.from_env()
    if not settings.crusoe_api_key:
        print("crusoe_proxy: CRUSOE_API_KEY is not set in .env", file=sys.stderr)
        return 2
    server = make_server(settings, args.host, args.port, buffer_streams=not args.stream_passthrough)
    log.info("crusoe proxy listening on http://%s:%d/v1 -> %s (key loaded: %s, thinking: %s, streams: %s)",
             args.host, args.port, urlsplit(settings.crusoe_base_url).netloc, bool(settings.crusoe_api_key),
             settings.worker_thinking, "passthrough" if args.stream_passthrough else "buffered")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
