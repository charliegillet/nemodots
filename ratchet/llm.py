"""Crusoe Managed Inference client, usage/cost ledger and pricing for Ratchet (owner: I1).

Every Nemotron call in Ratchet goes through :class:`CrusoeClient` (PLAN.md section 0, rule 8). It:

* turns Nemotron reasoning OFF unless ``thinking=True`` by sending
  ``extra_body={"chat_template_kwargs": {"enable_thinking": <thinking>}}`` (plus
  ``force_nonempty_content: true`` when thinking is off). ``tool_choice`` is never sent.
* self-throttles per model: a ``threading.Semaphore(max_inflight_per_model)`` and a pacer that
  spaces request *starts* at least ``60 / rpm_per_model`` seconds apart (reservation based, no busy
  wait; ``rpm_per_model <= 0`` disables pacing). Throttles are process-global, keyed by
  ``(base_url, model, max_inflight, rpm)``, because Crusoe's limits are per project per model, not
  per client object.
* retries HTTP 429/500/502/503/504, connection errors and timeouts with jittered exponential backoff
  (``min(cap, base * 2**attempt) * uniform(0.5, 1.5)``), honouring ``Retry-After``. ``max_retries``
  counts *retries*, so at most ``1 + max_retries`` HTTP attempts are made before
  :class:`RateLimitedError` is raised. Other HTTP errors (400/401/404/422...) are raised at once.
* normalizes the response into :class:`ratchet.types.ChatResult` (reasoning stripped from the
  message, tool-call arguments parsed, malformed JSON kept in ``raw_arguments``).
* retries once with doubled ``max_tokens`` (cap 16384) when thinking is off and the model returned
  ``finish_reason="length"`` with no content and no tool calls; raises :class:`EmptyContentError`
  if that is still empty. Both HTTP responses are recorded in the ledger and summed in
  ``ChatResult.usage`` (so spend is never under-reported).
* records usage and cost in a :class:`UsageLedger` (optionally one JSON line per call in
  ``runs/llm_calls.jsonl``; never message content, never the key).

Choices where PLAN.md is silent (documented here as the plan asks):
* ``ChatResult.latency_ms`` is the sum of the successful HTTP round trips (backoff sleeps excluded);
  ``attempts`` counts every HTTP attempt including retried ones.
* Models missing from the price table cost 0.0 and log one warning.
* ``refresh_prices`` / ``list_models`` use ``httpx`` directly (GET ``{base_url}/models``) because
  the injectable ``client_factory`` object only has to provide ``.chat.completions.create``.
* :meth:`UsageLedger.from_jsonl` / :meth:`UsageLedger.load_jsonl` are extra helpers so other hosts
  (e.g. the OpenBot proxy, which runs in another process) can read usage back by tag.
"""
from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ratchet import interrupt
from ratchet.config import PRICES_PER_M, Settings
from ratchet.types import ChatResult, ToolCall, Usage, utcnow

log = logging.getLogger("ratchet.llm")

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_TOKENS_CAP = 16384


class RateLimitedError(RuntimeError):
    """Raised after ``1 + settings.max_retries`` attempts all failed with a retryable error."""

    def __init__(self, message: str, *, model: str = "", attempts: int = 0, last_status: int | None = None):
        super().__init__(message)
        self.model = model
        self.attempts = attempts
        self.last_status = last_status


class EmptyContentError(RuntimeError):
    """Content null and no tool calls even after the doubled-``max_tokens`` retry."""


# --------------------------------------------------------------------------- pricing


_warned_unpriced: set[str] = set()


def price_for(model: str, prices: dict[str, tuple[float, float, float]] | None = None) -> tuple[float, float, float]:
    """USD per 1M tokens ``(prompt, completion, cached_prompt)`` for ``model``; zeros if unknown."""
    table = prices if prices is not None else PRICES_PER_M
    if model in table:
        return table[model]
    if prices is not None and model in PRICES_PER_M:
        return PRICES_PER_M[model]
    if model not in _warned_unpriced:
        _warned_unpriced.add(model)
        log.warning("no price known for model %s; cost recorded as 0", model)
    return (0.0, 0.0, 0.0)


def compute_cost(model: str, prompt_tokens: int, completion_tokens: int, cached_tokens: int,
                 prices: dict[str, tuple[float, float, float]] | None = None) -> float:
    """cost = (prompt - cached) * p_in/1e6 + cached * p_cached/1e6 + completion * p_out/1e6."""
    p_in, p_out, p_cached = price_for(model, prices)
    prompt_tokens = max(0, int(prompt_tokens or 0))
    completion_tokens = max(0, int(completion_tokens or 0))
    cached = min(max(0, int(cached_tokens or 0)), prompt_tokens)
    cost = (prompt_tokens - cached) * p_in / 1e6 + cached * p_cached / 1e6 + completion_tokens * p_out / 1e6
    return round(cost, 10)


def parse_model_prices(models: list[dict[str, Any]]) -> dict[str, tuple[float, float, float]]:
    """Parse ``GET /v1/models`` records into ``{id: (prompt, completion, cached)}`` USD per 1M.

    Crusoe reports ``pricing = {"prompt": "0.05", "completion": "0.2", "input_cache_reads": "0.03"}``
    as strings in USD per 1M tokens. Values that look per-token (< 1e-3 while non-zero) are scaled
    by 1e6 defensively. Records without usable pricing are skipped."""
    out: dict[str, tuple[float, float, float]] = {}
    for rec in models or []:
        if not isinstance(rec, dict):
            continue
        mid = rec.get("id")
        pricing = rec.get("pricing")
        if not mid or not isinstance(pricing, dict):
            continue
        try:
            p_in = float(pricing.get("prompt"))
            p_out = float(pricing.get("completion"))
            cached_raw = pricing.get("input_cache_reads")
            p_cached = float(cached_raw) if cached_raw not in (None, "") else p_in
        except (TypeError, ValueError):
            continue
        vals = [p_in, p_out, p_cached]
        if any(0 < v < 1e-3 for v in vals):
            vals = [v * 1e6 for v in vals]
        out[str(mid)] = (vals[0], vals[1], vals[2])
    return out


# --------------------------------------------------------------------------- ledger


@dataclass
class LedgerEntry:
    ts: str
    tag: str
    model: str
    usage: Usage
    latency_ms: int
    finish_reason: str
    attempts: int
    thinking: bool

    def to_json_line(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "tag": self.tag,
            "model": self.model,
            "prompt_tokens": self.usage.prompt_tokens,
            "completion_tokens": self.usage.completion_tokens,
            "cached_tokens": self.usage.cached_tokens,
            "cached_reported": self.usage.cached_reported,
            "cost_usd": self.usage.cost_usd,
            "latency_ms": self.latency_ms,
            "finish_reason": self.finish_reason,
            "attempts": self.attempts,
            "thinking": self.thinking,
        }


class UsageLedger:
    """Thread-safe. Records every call; optionally appends one JSON line per call to a .jsonl file.

    Aggregations filter by tag prefix (``"v3:"``, ``"v3:holdout:"``); ``""`` means everything."""

    def __init__(self, jsonl_path: Path | None = None):
        self.jsonl_path = Path(jsonl_path) if jsonl_path is not None else None
        self._lock = threading.Lock()
        self._entries: list[LedgerEntry] = []

    # -- writing
    def record(self, *, tag: str, model: str, usage: Usage, latency_ms: int, finish_reason: str,
               attempts: int, thinking: bool) -> None:
        entry = LedgerEntry(ts=utcnow(), tag=tag or "", model=model, usage=Usage.from_dict(usage.to_dict()),
                            latency_ms=int(latency_ms), finish_reason=finish_reason or "",
                            attempts=int(attempts), thinking=bool(thinking))
        with self._lock:
            self._entries.append(entry)
            if self.jsonl_path is not None:
                try:
                    self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
                    line = json.dumps(entry.to_json_line(), sort_keys=True, ensure_ascii=False) + "\n"
                    with open(self.jsonl_path, "a", encoding="utf-8") as fh:
                        fh.write(line)
                except OSError as exc:  # the ledger must never break a run
                    log.warning("could not append to %s: %s", self.jsonl_path, exc)

    def reset(self) -> None:
        """Forget in-memory entries (the JSONL file, if any, is left untouched)."""
        with self._lock:
            self._entries.clear()

    # -- reading
    def entries(self, prefix: str = "") -> list[LedgerEntry]:
        with self._lock:
            return [e for e in self._entries if e.tag.startswith(prefix)]

    def total(self, prefix: str = "") -> Usage:
        total = Usage()
        for e in self.entries(prefix):
            total = total + e.usage
        return total

    def by_model(self, prefix: str = "") -> dict[str, Usage]:
        out: dict[str, Usage] = {}
        for e in self.entries(prefix):
            out[e.model] = out.get(e.model, Usage()) + e.usage
        return out

    def by_tag(self, prefix: str = "") -> dict[str, Usage]:
        out: dict[str, Usage] = {}
        for e in self.entries(prefix):
            out[e.tag] = out.get(e.tag, Usage()) + e.usage
        return out

    # -- JSONL helpers (extra; used by other-process hosts such as the OpenBot proxy)
    @staticmethod
    def load_jsonl(path: Path) -> list[LedgerEntry]:
        """Parse a ledger JSONL file; malformed lines are skipped."""
        out: list[LedgerEntry] = []
        p = Path(path)
        if not p.exists():
            return out
        for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                d = json.loads(raw)
                usage = Usage(
                    requests=1,
                    prompt_tokens=int(d.get("prompt_tokens") or 0),
                    completion_tokens=int(d.get("completion_tokens") or 0),
                    cached_tokens=int(d.get("cached_tokens") or 0),
                    cached_reported=bool(d.get("cached_reported")),
                    cost_usd=float(d.get("cost_usd") or 0.0),
                )
                out.append(LedgerEntry(ts=str(d.get("ts", "")), tag=str(d.get("tag", "")),
                                       model=str(d.get("model", "")), usage=usage,
                                       latency_ms=int(d.get("latency_ms") or 0),
                                       finish_reason=str(d.get("finish_reason", "")),
                                       attempts=int(d.get("attempts") or 1), thinking=bool(d.get("thinking"))))
            except (ValueError, TypeError, AttributeError):
                continue
        return out

    @classmethod
    def from_jsonl(cls, path: Path, *, prefix: str = "") -> "UsageLedger":
        """An in-memory ledger (not appending anywhere) holding the file's entries with ``prefix``."""
        led = cls()
        led._entries = [e for e in cls.load_jsonl(path) if e.tag.startswith(prefix)]
        return led


# --------------------------------------------------------------------------- throttling


class _Throttle:
    """Per-model concurrency cap + request-start pacer."""

    def __init__(self, max_inflight: int, rpm: int):
        self.sem = threading.BoundedSemaphore(max(1, int(max_inflight)))
        self.interval = 60.0 / rpm if rpm and rpm > 0 else 0.0
        self._lock = threading.Lock()
        self._next = 0.0

    def reserve(self) -> float:
        """Reserve the next start slot; returns how long the caller must sleep before starting."""
        if self.interval <= 0:
            return 0.0
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next)
            self._next = start + self.interval
            return start - now


_throttles: dict[tuple[str, str, int, int], _Throttle] = {}
_throttles_lock = threading.Lock()


def _throttle_for(base_url: str, model: str, max_inflight: int, rpm: int) -> _Throttle:
    key = (base_url, model, int(max_inflight), int(rpm))
    with _throttles_lock:
        t = _throttles.get(key)
        if t is None:
            t = _throttles[key] = _Throttle(max_inflight, rpm)
        return t


def reset_throttles() -> None:
    """Drop every process-global throttle (tests)."""
    with _throttles_lock:
        _throttles.clear()


# --------------------------------------------------------------------------- error classification


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    resp = getattr(exc, "response", None)
    status = getattr(resp, "status_code", None)
    return status if isinstance(status, int) else None


def _retry_after_s(exc: BaseException) -> float | None:
    resp = getattr(exc, "response", None)
    headers = getattr(resp, "headers", None)
    if not headers:
        return None
    try:
        val = headers.get("retry-after") or headers.get("Retry-After")
    except Exception:  # noqa: BLE001 - exotic header containers
        return None
    if val is None:
        return None
    try:
        return max(0.0, float(val))
    except (TypeError, ValueError):
        return None


def _is_retryable(exc: BaseException) -> bool:
    status = _status_of(exc)
    if status is not None:
        return status in RETRY_STATUSES
    try:
        import openai

        if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError)):
            return True
    except ImportError:  # pragma: no cover - openai is a hard dependency
        pass
    try:
        import httpx

        if isinstance(exc, (httpx.TransportError, httpx.TimeoutException)):
            return True
    except ImportError:  # pragma: no cover
        pass
    return isinstance(exc, (TimeoutError, ConnectionError))


def _short_error(exc: BaseException) -> str:
    status = _status_of(exc)
    msg = str(exc).replace("\n", " ")
    if len(msg) > 300:
        msg = msg[:300] + "..."
    return f"{type(exc).__name__}" + (f" {status}" if status else "") + (f": {msg}" if msg else "")


# --------------------------------------------------------------------------- response normalization


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _dump(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for meth in ("model_dump", "dict", "to_dict"):
        fn = getattr(obj, meth, None)
        if callable(fn):
            try:
                d = fn()
                if isinstance(d, dict):
                    return d
            except Exception:  # noqa: BLE001
                continue
    return dict(getattr(obj, "__dict__", {}) or {})


def _parse_usage(resp: Any, model: str, prices: dict[str, tuple[float, float, float]] | None) -> Usage:
    u = _get(resp, "usage")
    prompt = int(_get(u, "prompt_tokens", 0) or 0)
    completion = int(_get(u, "completion_tokens", 0) or 0)
    details = _get(u, "prompt_tokens_details")
    cached_val = _get(details, "cached_tokens") if details is not None else None
    cached_reported = cached_val is not None
    cached = int(cached_val or 0)
    return Usage(requests=1, prompt_tokens=prompt, completion_tokens=completion, cached_tokens=cached,
                 cached_reported=cached_reported,
                 cost_usd=compute_cost(model, prompt, completion, cached, prices))


_TEXT_CALL_RE = re.compile(r"<function=([A-Za-z0-9_.-]+)>(.*?)</function>", re.S)
_TEXT_PARAM_RE = re.compile(r"<parameter=([A-Za-z0-9_.-]+)>(.*?)</parameter>", re.S)


def _strip_one_newline(v: str) -> str:
    if v.startswith("\n"):
        v = v[1:]
    if v.endswith("\n"):
        v = v[:-1]
    return v


def parse_text_tool_calls(content: str, tools: list[dict[str, Any]] | None) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
    """Recover tool calls that Nemotron sometimes writes into the message *text* in its chat-template
    syntax (``<function=NAME><parameter=KEY>VALUE</parameter></function>``, optionally wrapped in
    ``<tool_call>``) instead of returning them as structured ``tool_calls``. Only complete blocks whose
    NAME is one of ``tools`` are recovered; non-string parameters are JSON-decoded when possible.
    Returns ``(remaining_text, [(name, arguments), ...])``; no calls -> ``(content, [])``."""
    if not content or "<function=" not in content or not tools:
        return content, []
    types: dict[str, dict[str, str]] = {}
    for t in tools:
        fn = t.get("function", t) if isinstance(t, dict) else {}
        name = fn.get("name") if isinstance(fn, dict) else None
        if name:
            props = ((fn.get("parameters") or {}).get("properties") or {})
            types[name] = {k: str((v or {}).get("type", "string")) for k, v in props.items()}
    calls: list[tuple[str, dict[str, Any]]] = []
    spans: list[tuple[int, int]] = []
    for m in _TEXT_CALL_RE.finditer(content):
        name = m.group(1)
        if name not in types:
            continue
        args: dict[str, Any] = {}
        for pm in _TEXT_PARAM_RE.finditer(m.group(2)):
            key, val = pm.group(1), _strip_one_newline(pm.group(2))
            if types[name].get(key, "string") != "string":
                try:
                    val = json.loads(val.strip())
                except (ValueError, TypeError):
                    pass
            args[key] = val
        calls.append((name, args))
        spans.append(m.span())
    if not calls:
        return content, []
    rest, last = [], 0
    for a, b in spans:
        rest.append(content[last:a])
        last = b
    rest.append(content[last:])
    text = "".join(rest).replace("<tool_call>", "").replace("</tool_call>", "").strip()
    return text, calls


def _normalize(resp: Any) -> tuple[dict[str, Any], str, str, list[ToolCall], str]:
    """-> (message, content, reasoning, tool_calls, finish_reason)."""
    choices = _get(resp, "choices") or []
    if not choices:
        return {"role": "assistant", "content": None}, "", "", [], "error"
    choice = choices[0]
    msg = _get(choice, "message")
    dumped = _dump(msg)
    content = _get(msg, "content") or ""
    if not isinstance(content, str):
        content = str(content)
    reasoning = dumped.get("reasoning") or dumped.get("reasoning_content") or ""
    if not isinstance(reasoning, str):
        reasoning = str(reasoning)
    finish_reason = _get(choice, "finish_reason") or "unknown"

    tool_calls: list[ToolCall] = []
    msg_calls: list[dict[str, Any]] = []
    for i, tc in enumerate(_get(msg, "tool_calls") or []):
        fn = _get(tc, "function")
        name = _get(fn, "name") or ""
        raw = _get(fn, "arguments")
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raw = json.dumps(raw)
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except (ValueError, TypeError):
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        cid = _get(tc, "id") or f"call_{i}_{int(time.time() * 1000) % 10**8}"
        tool_calls.append(ToolCall(id=cid, name=name, arguments=parsed, raw_arguments=raw))
        msg_calls.append({"id": cid, "type": "function", "function": {"name": name, "arguments": raw}})

    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    if msg_calls:
        message["tool_calls"] = msg_calls
    return message, content, reasoning, tool_calls, str(finish_reason)


# --------------------------------------------------------------------------- client


class CrusoeClient:
    """Implements :class:`ratchet.types.LLM` against Crusoe Managed Inference."""

    def __init__(self, settings: Settings, ledger: UsageLedger | None = None,
                 client_factory: Callable[[], Any] | None = None):
        self.settings = settings
        self.ledger = ledger if ledger is not None else UsageLedger()
        self._factory = client_factory or self._default_factory
        self._client: Any | None = None
        self._client_lock = threading.Lock()
        self.prices: dict[str, tuple[float, float, float]] = dict(PRICES_PER_M)
        # Patchable for tests (no real sleeping, deterministic jitter).
        # The default sleep wakes early when a gate stop is requested (ratchet.interrupt).
        self._sleep: Callable[[float], None] = interrupt.sleep
        self._uniform: Callable[[float, float], float] = random.uniform

    def __repr__(self) -> str:
        return f"CrusoeClient(base_url={self.settings.crusoe_base_url!r}, key={'<set>' if self.settings.crusoe_api_key else '<unset>'})"

    # -- plumbing
    def _default_factory(self) -> Any:
        import openai

        return openai.OpenAI(api_key=self.settings.crusoe_api_key or "missing",
                             base_url=self.settings.crusoe_base_url,
                             timeout=self.settings.request_timeout_s, max_retries=0)

    @property
    def client(self) -> Any:
        with self._client_lock:
            if self._client is None:
                self._client = self._factory()
            return self._client

    def _throttle(self, model: str) -> _Throttle:
        s = self.settings
        return _throttle_for(s.crusoe_base_url, model, s.max_inflight_per_model, s.rpm_per_model)

    def backoff_delay(self, attempt: int, retry_after: float | None = None) -> float:
        """Delay before retry number ``attempt`` (0-based)."""
        s = self.settings
        delay = min(s.backoff_cap_s, s.backoff_base_s * (2 ** attempt)) * self._uniform(0.5, 1.5)
        if retry_after is not None:
            delay = max(delay, min(retry_after, max(s.backoff_cap_s, 60.0)))
        return max(0.0, delay)

    def _create(self, model: str, kwargs: dict[str, Any]) -> tuple[Any, int, int]:
        """One logical request with throttling and retries -> (response, attempts, latency_ms)."""
        throttle = self._throttle(model)
        max_attempts = 1 + max(0, int(self.settings.max_retries))
        last_exc: BaseException | None = None
        for attempt in range(max_attempts):
            interrupt.check()  # a stopping gate makes no new model calls
            with throttle.sem:
                wait = throttle.reserve()
                if wait > 0:
                    self._sleep(wait)
                interrupt.check()
                t0 = time.monotonic()
                try:
                    resp = self.client.chat.completions.create(**kwargs)
                    return resp, attempt + 1, int((time.monotonic() - t0) * 1000)
                except Exception as exc:  # noqa: BLE001 - classified below
                    if not _is_retryable(exc):
                        raise
                    last_exc = exc
            if attempt + 1 >= max_attempts:
                break
            delay = self.backoff_delay(attempt, _retry_after_s(last_exc))
            # Isolated 429s ("max_requests_limit (orchestrator)") are routine at the default tier even under
            # the self-imposed pacing: the first two retries go to runs/loop.log only; later ones warn.
            log.log(logging.WARNING if attempt >= 2 else logging.DEBUG, "crusoe %s: %s; retry %d/%d in %.1fs",
                    model, _short_error(last_exc), attempt + 1, max_attempts - 1, delay)
            self._sleep(delay)
        assert last_exc is not None
        raise RateLimitedError(
            f"{model}: gave up after {max_attempts} attempts; last error: {_short_error(last_exc)}",
            model=model, attempts=max_attempts, last_status=_status_of(last_exc),
        ) from last_exc

    # -- public API
    def chat(self, *, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
             thinking: bool = False, max_tokens: int = 2048, temperature: float = 0.2,
             seed: int | None = None, response_format: dict[str, Any] | None = None,
             tag: str = "") -> ChatResult:
        template_kwargs: dict[str, Any] = {"enable_thinking": bool(thinking)}
        if not thinking:
            template_kwargs["force_nonempty_content"] = True
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": int(max_tokens),
            "temperature": temperature,
            "extra_body": {"chat_template_kwargs": template_kwargs},
        }
        if tools:
            kwargs["tools"] = tools
        if seed is not None:
            kwargs["seed"] = int(seed)
        if response_format is not None:
            kwargs["response_format"] = response_format

        total_usage = Usage()
        total_attempts = 0
        total_latency = 0
        retried_empty = False
        while True:
            resp, attempts, latency_ms = self._create(model, kwargs)
            total_attempts += attempts
            total_latency += latency_ms
            message, content, reasoning, tool_calls, finish_reason = _normalize(resp)
            if not tool_calls and tools:
                text, recovered = parse_text_tool_calls(content, tools)
                if recovered:
                    log.info("crusoe %s tag=%s: recovered %d tool call(s) written as text", model, tag,
                             len(recovered))
                    content = text
                    stamp = int(time.time() * 1000) % 10**8
                    tool_calls = [ToolCall(id=f"call_txt{i}_{stamp}", name=n, arguments=a,
                                           raw_arguments=json.dumps(a, ensure_ascii=False))
                                  for i, (n, a) in enumerate(recovered)]
                    message = {"role": "assistant", "content": content or None,
                               "tool_calls": [{"id": tc.id, "type": "function",
                                               "function": {"name": tc.name, "arguments": tc.raw_arguments}}
                                              for tc in tool_calls]}
                    if finish_reason == "stop":
                        finish_reason = "tool_calls"
            usage = _parse_usage(resp, model, self.prices)
            total_usage = total_usage + usage
            self.ledger.record(tag=tag, model=model, usage=usage, latency_ms=latency_ms,
                               finish_reason=finish_reason, attempts=attempts, thinking=bool(thinking))
            log.debug("crusoe %s tag=%s finish=%s prompt=%d completion=%d cached=%s latency=%dms attempts=%d",
                      model, tag, finish_reason, usage.prompt_tokens, usage.completion_tokens,
                      usage.cached_tokens if usage.cached_reported else "n/a", latency_ms, attempts)
            empty = not content and not tool_calls
            if empty and finish_reason == "length" and not thinking:
                if retried_empty or kwargs["max_tokens"] >= MAX_TOKENS_CAP:
                    raise EmptyContentError(
                        f"{model}: empty content with finish_reason=length at max_tokens={kwargs['max_tokens']}")
                retried_empty = True
                kwargs = dict(kwargs)
                kwargs["max_tokens"] = min(MAX_TOKENS_CAP, kwargs["max_tokens"] * 2)
                log.warning("crusoe %s: empty content at length limit; retrying with max_tokens=%d",
                            model, kwargs["max_tokens"])
                continue
            break
        return ChatResult(
            model=model, message=message, content=content, reasoning=reasoning, tool_calls=tool_calls,
            finish_reason=finish_reason, usage=total_usage, latency_ms=total_latency,
            attempts=total_attempts, cached_reported=total_usage.cached_reported,
        )

    # -- models / pricing
    def list_models(self) -> list[dict]:
        """GET {base_url}/models -> the ``data`` list (raises on HTTP failure)."""
        import httpx

        r = httpx.get(f"{self.settings.crusoe_base_url.rstrip('/')}/models",
                      headers={"Authorization": f"Bearer {self.settings.crusoe_api_key}"},
                      timeout=min(30.0, self.settings.request_timeout_s))
        r.raise_for_status()
        data = r.json()
        models = data.get("data") if isinstance(data, dict) else data
        return [m for m in (models or []) if isinstance(m, dict)]

    def refresh_prices(self) -> dict[str, tuple[float, float, float]]:
        """Update ``self.prices`` from ``/v1/models`` pricing; keep config.PRICES_PER_M on failure."""
        try:
            live = parse_model_prices(self.list_models())
        except Exception as exc:  # noqa: BLE001 - never fatal
            log.warning("could not refresh prices from /models (%s); using built-in table", type(exc).__name__)
            return dict(self.prices)
        merged = dict(PRICES_PER_M)
        merged.update(live)
        self.prices = merged
        return dict(merged)
