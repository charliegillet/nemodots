"""OpenBotWorker: Ratchet tasks done by CopilotKit OpenBot coworkers (owner I4).

Two modes behind the `ratchet.types.Worker` interface:

* ``"agui"`` (default, works without any CopilotKit account). OpenBot's shipped Bot, ``agent-bot``
  (vendor/openbot/agent-bot/src/index.ts), is the coworker's brain. It is an AG-UI HTTP service
  (``POST /ag-ui``, ``RunAgentInput`` in, SSE events out) that publishes no tools of its own: every tool
  arrives in ``input.tools`` and "the loop runs on the client". When the model calls a tool the Bot ends
  the run; the surface executes the tool, appends the result and starts a new run. Ratchet is that
  surface: it owns the workspace and the tools (the same ``ToolBox``/``Sandbox`` as ``LocalWorker``), so
  verification is identical for both hosts. agent-bot reaches Crusoe through
  ``integrations/openbot/crusoe_proxy.py``, which disables Nemotron reasoning, injects the paired seed and
  records token usage per AG-UI run. Started by ``bash integrations/openbot/setup.sh``.

* ``"stack"`` (full OpenBot deployment). Same client loop, but each run goes through the OpenBot
  server's CopilotKit runtime (``POST /api/copilotkit/agent/<botId>/run``, verified against
  @copilotkit/runtime 1.77.0), so the coworker gets its standing role from the tenant package, its runs
  land in OpenBot's audit trail, and the accepted playbook is published as the ``ratchet-playbook``
  skill (``POST /api/plugins/skills``, an upsert). The OpenBot server refuses to start without a
  CopilotKit Intelligence key, which needs a CopilotKit account we may not create, so this mode is
  gated by ``availability(mode="stack")`` and has not been exercised end to end.

Decisions where docs/PLAN.md was silent or did not match the code in vendor/openbot (verified there):

* agent-bot authenticates the caller with the header ``x-openbot-agent-token`` (shared/
  agent-authorisation.ts), not ``Authorization: Bearer``.
* agent-bot does not forward request headers to the model endpoint, so an ``X-Ratchet-Tag`` header can
  never reach the proxy. The tag travels as an AG-UI ``context`` item (``META_DESCRIPTION``) that
  agent-bot turns into a system message; the proxy strips it before the model sees it.
* Per-turn usage is read back from the proxy (``GET /usage/<runId>``), which is exact even with
  concurrent runs and repeated tags. When a ``ledger`` is passed to the constructor the worker records
  each turn into it (so ``ledger.total("v3:")`` includes OpenBot runs) and tells the proxy not to write
  ``runs/llm_calls.jsonl`` itself; without one the proxy writes the JSONL line.
* agent-bot sends no ``finish_reason``; the proxy reports it with the usage, so the "cut off" nudge
  behaves like ``LocalWorker``'s.
* Each AG-UI turn's raw events are appended to ``run_dir/openbot_events.jsonl`` (OpenBot-style audit
  trail; no secrets, only what the Bot streamed).
* A turn that ends in ``RUN_ERROR``, an HTTP 5xx or a dropped stream is retried twice (2 s, 4 s) before
  the run stops with ``stop_reason="error"``; a 401 is not retried (wrong token: re-run setup.sh), and
  neither is an empty cut-off answer the proxy reports as ``error="empty_content"`` in ``/usage`` (the
  same case where ``CrusoeClient`` raises ``EmptyContentError``).
* Everything else in the loop mirrors ``ratchet.worker.LocalWorker`` exactly (workspace wipe, malformed
  argument handling, timing-normalized run_tests circuit breaker, ``final_answer`` falling back to the
  submit summary), and the run metadata asks the proxy to strip agent-bot's COMPUTER_GUIDANCE system
  message, so a LocalWorker run and an OpenBot run of the same playbook send the model the same prompt. The proxy
  answers agent-bot's streamed requests from a non-streamed Crusoe completion (see crusoe_proxy.py), so
  the model sees the same request shape as with ``CrusoeClient``.
* ``availability`` checks the token without a model call by sending an unparseable body: agent-bot checks
  the token first (401) and only then parses JSON (500). agent-bot logs that probe as a SyntaxError.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from ratchet import interrupt
from ratchet.config import ROOT, Settings, load_dotenv
from ratchet.types import Task, ToolCall, ToolStep, Transcript, Usage, utcnow

log = logging.getLogger("ratchet.openbot")

OPENBOT_ENV_FILE = ROOT / "integrations" / "openbot" / ".env.openbot"
META_DESCRIPTION = "[ratchet-run-meta]"          # must equal crusoe_proxy.META_DESCRIPTION
DEFAULT_AGENT_URL = "http://127.0.0.1:4200/ag-ui"
DEFAULT_PROXY_URL = "http://127.0.0.1:8787"
DEFAULT_SERVER_URL = "http://127.0.0.1:3001"
DEFAULT_APP_ORIGIN = "http://localhost:3010"
DEFAULT_BOT_ID = "ratchet-coworker"
PLAYBOOK_SKILL_SLUG = "ratchet-playbook"
AGENT_TOKEN_HEADER = "x-openbot-agent-token"
INTELLIGENCE_VARS = ("INTELLIGENCE_API_URL", "INTELLIGENCE_GATEWAY_WS_URL", "INTELLIGENCE_API_KEY")
# OpenBot's public defaults (vendor/openbot/.env.example); only the key is account-specific.
INTELLIGENCE_DEFAULTS = {
    "INTELLIGENCE_API_URL": "https://api.intelligence.copilotkit.ai",
    "INTELLIGENCE_GATEWAY_WS_URL": "wss://realtime.intelligence.copilotkit.ai",
}
# OpenBot's own tooling (`npx copilotkit project select`) writes the key as CPK_INTELLIGENCE_API_KEY.
INTELLIGENCE_KEY_ALIASES = ("INTELLIGENCE_API_KEY", "CPK_INTELLIGENCE_API_KEY")
BLOCKER = "BLOCKER: CopilotKit Intelligence key (INTELLIGENCE_API_KEY) is required by OpenBot and is not set"
SETUP_HINT = "run: bash integrations/openbot/setup.sh"
CUT_OFF_NUDGE = "Your previous message was cut off. Continue by calling a tool, or call submit."
TURN_RETRIES = 2
HEALTH_TIMEOUT_S = 2.0
MODES = ("agui", "stack")
_TIMING_RE = re.compile(r"\bin \d+(?:\.\d+)?s\b")   # same normalization as LocalWorker's breaker


class OpenBotUnavailable(RuntimeError):
    """OpenBot (or the proxy) cannot serve runs; the message says what to do."""


# --------------------------------------------------------------------------- helpers (unit-tested)


def load_openbot_env(path: Path | None = None) -> None:
    """Load integrations/openbot/.env.openbot (written by setup.sh) without overriding the environment."""
    load_dotenv(path or OPENBOT_ENV_FILE)


def seed_for(task_id: str, repeat: int) -> int:
    """Same paired seed as ratchet.gate.seed_for (PLAN 4.6)."""
    return (zlib.crc32(task_id.encode()) + repeat) % 2**31


def intelligence_config(env: dict[str, str] | None = None) -> dict[str, str]:
    """The three values OpenBot's server needs: URLs default to OpenBot's public endpoints, the key may
    come from INTELLIGENCE_API_KEY or its alias CPK_INTELLIGENCE_API_KEY. Missing values are ""."""
    env = os.environ if env is None else env
    out = {name: (env.get(name) or "").strip() or INTELLIGENCE_DEFAULTS.get(name, "")
           for name in ("INTELLIGENCE_API_URL", "INTELLIGENCE_GATEWAY_WS_URL")}
    out["INTELLIGENCE_API_KEY"] = next((v for v in ((env.get(a) or "").strip() for a in INTELLIGENCE_KEY_ALIASES) if v), "")
    return out


def missing_intelligence(env: dict[str, str] | None = None) -> list[str]:
    cfg = intelligence_config(env)
    return [name for name in INTELLIGENCE_VARS if not cfg.get(name)]


def agui_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """OpenAI function schemas -> AG-UI ``Tool`` objects ``{name, description, parameters}`` (order kept)."""
    out = []
    for s in schemas:
        fn = s.get("function", s)
        out.append({"name": fn["name"], "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {"type": "object", "properties": {}})})
    return out


def _arguments_text(args: Any) -> str:
    if isinstance(args, str):
        return args
    if args is None:
        return "{}"
    return json.dumps(args)


def to_agui_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """OpenAI chat messages -> AG-UI messages (``toolCalls`` / ``toolCallId`` camelCase, ids per message)."""
    out: list[dict[str, Any]] = []
    for i, m in enumerate(messages):
        role = m.get("role")
        mid = f"msg-{i}"
        if role in ("system", "developer", "user"):
            out.append({"id": mid, "role": role, "content": "" if m.get("content") is None else m["content"]})
        elif role == "assistant":
            msg: dict[str, Any] = {"id": mid, "role": "assistant"}
            if m.get("content"):
                msg["content"] = m["content"]
            calls = []
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                calls.append({"id": tc.get("id"), "type": "function",
                              "function": {"name": fn.get("name", ""), "arguments": _arguments_text(fn.get("arguments"))}})
            if calls:
                msg["toolCalls"] = calls
            out.append(msg)
        elif role == "tool":
            out.append({"id": mid, "role": "tool", "content": "" if m.get("content") is None else str(m["content"]),
                        "toolCallId": m.get("tool_call_id", "")})
        else:
            raise ValueError(f"unsupported message role {role!r}")
    return out


def parse_sse_events(sse_text: str) -> list[dict[str, Any]]:
    """Split an SSE body into JSON event objects (multi-line ``data:`` joined; comments/garbage skipped)."""
    events: list[dict[str, Any]] = []
    data_lines: list[str] = []

    def flush() -> None:
        if data_lines:
            raw = "\n".join(data_lines)
            data_lines.clear()
            try:
                obj = json.loads(raw)
            except ValueError:
                return
            if isinstance(obj, dict):
                events.append(obj)

    for line in sse_text.replace("\r\n", "\n").split("\n"):
        if line == "":
            flush()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" ") if line.startswith("data: ") else line[5:])
        # "event:", "id:", "retry:" and ":" comment lines are ignored; AG-UI puts the type in the JSON
    flush()
    return events


def arguments_malformed(raw: str) -> bool:
    """Same rule as LocalWorker: non-empty arguments that are not a JSON object are not executed."""
    raw = (raw or "").strip()
    if not raw:
        return False
    try:
        return not isinstance(json.loads(raw), dict)
    except (ValueError, TypeError):
        return True


def _tool_call(call_id: str, name: str, raw: str) -> ToolCall:
    raw = raw or "{}"
    try:
        args = json.loads(raw)
        if not isinstance(args, dict):
            args = {}
    except ValueError:
        args = {}
    return ToolCall(id=call_id, name=name, arguments=args, raw_arguments=raw)


def events_to_turn(events: list[dict[str, Any]]) -> tuple[str, list[ToolCall], str | None]:
    """AG-UI events -> (assistant text, tool calls in order, error or None)."""
    text: list[str] = []
    calls: dict[str, dict[str, str]] = {}
    order: list[str] = []
    error: str | None = None
    finished = False
    for ev in events:
        t = ev.get("type")
        if t in ("TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK"):
            if isinstance(ev.get("delta"), str):
                text.append(ev["delta"])
        elif t in ("TOOL_CALL_START", "TOOL_CALL_CHUNK"):
            cid = str(ev.get("toolCallId") or f"call_{len(order)}")
            if cid not in calls:
                calls[cid] = {"name": "", "args": ""}
                order.append(cid)
            if ev.get("toolCallName"):
                calls[cid]["name"] = str(ev["toolCallName"])
            if t == "TOOL_CALL_CHUNK" and isinstance(ev.get("delta"), str):
                calls[cid]["args"] += ev["delta"]
        elif t == "TOOL_CALL_ARGS":
            cid = str(ev.get("toolCallId") or "")
            if cid not in calls:
                calls[cid] = {"name": "", "args": ""}
                order.append(cid)
            if isinstance(ev.get("delta"), str):
                calls[cid]["args"] += ev["delta"]
        elif t == "RUN_ERROR":
            error = str(ev.get("message") or ev.get("code") or "RUN_ERROR")
        elif t == "RUN_FINISHED":
            finished = True
    if error is None and not finished:
        error = "AG-UI stream ended without RUN_FINISHED"
    tool_calls = [_tool_call(cid, calls[cid]["name"], calls[cid]["args"]) for cid in order if calls[cid]["name"]]
    return "".join(text).strip(), tool_calls, error


def parse_agui_events(sse_text: str) -> tuple[str, list[ToolCall], str | None]:
    """SSE text from an AG-UI run -> (assistant text, tool calls, error or None)."""
    return events_to_turn(parse_sse_events(sse_text))


def _base(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _hostport(url: str) -> str:
    return urlsplit(url).netloc


# --------------------------------------------------------------------------- worker


@dataclass
class _Turn:
    content: str
    tool_calls: list[ToolCall]
    finish_reason: str
    usage: Usage
    model: str
    events: list[dict[str, Any]] = field(default_factory=list)


def _default_http() -> Any:
    import httpx

    return httpx.Client(timeout=httpx.Timeout(300.0, connect=5.0))


class OpenBotWorker:
    """Implements ratchet.types.Worker with OpenBot's agent-bot (mode "agui") or a full OpenBot deployment
    (mode "stack"). Thread-safe: gate.evaluate runs several tasks concurrently on one instance."""

    name = "openbot"

    def __init__(self, settings: Settings, *, mode: str = "agui", agent_url: str | None = None,
                 proxy_url: str | None = None, server_url: str | None = None, token: str | None = None,
                 sandbox: Any | None = None, http: Any | None = None, ledger: Any | None = None,
                 bot_id: str | None = None, toolbox_factory: Callable[..., Any] | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        if mode not in MODES:
            raise ValueError(f"unknown OpenBot mode {mode!r} (expected one of {MODES})")
        load_openbot_env()
        self.settings = settings
        self.mode = mode
        self.agent_url = agent_url or os.environ.get("OPENBOT_AGENT_URL") or DEFAULT_AGENT_URL
        self.proxy_url = (proxy_url or os.environ.get("OPENBOT_PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")
        self.server_url = (server_url or os.environ.get("OPENBOT_SERVER_URL") or DEFAULT_SERVER_URL).rstrip("/")
        self.app_origin = os.environ.get("OPENBOT_APP_ORIGIN") or DEFAULT_APP_ORIGIN
        self.bot_id = bot_id or os.environ.get("OPENBOT_BOT_ID") or DEFAULT_BOT_ID
        self.token = token if token is not None else os.environ.get("MANAGED_AGENT_TOKEN", "").strip()
        self.http = http if http is not None else _default_http()
        self.ledger = ledger
        self._sandbox = sandbox
        self._toolbox_factory = toolbox_factory
        self._sleep = sleep
        self._lock = threading.Lock()
        self._published: str | None = None   # stack mode: playbook text last pushed as the skill
        self.turn_timeout_s = float(max(settings.request_timeout_s, 60.0) + 180.0)

    # ------------------------------------------------------------------ availability

    @classmethod
    def availability(cls, settings: Settings, *, mode: str = "agui", agent_url: str | None = None,
                     proxy_url: str | None = None, server_url: str | None = None,
                     http: Any | None = None) -> tuple[bool, str]:
        """(ok, reason). Never raises; every check has a 2 s timeout."""
        try:
            return cls._availability(settings, mode=mode, agent_url=agent_url, proxy_url=proxy_url,
                                     server_url=server_url, http=http)
        except Exception as exc:  # noqa: BLE001
            return False, f"openbot availability check failed: {type(exc).__name__}: {exc}"

    @classmethod
    def _availability(cls, settings: Settings, *, mode: str, agent_url: str | None, proxy_url: str | None,
                      server_url: str | None, http: Any | None) -> tuple[bool, str]:
        if mode not in MODES:
            return False, f"unknown OpenBot mode {mode!r} (expected one of {', '.join(MODES)})"
        load_openbot_env()
        agent_url = agent_url or os.environ.get("OPENBOT_AGENT_URL") or DEFAULT_AGENT_URL
        proxy_url = (proxy_url or os.environ.get("OPENBOT_PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")
        server_url = (server_url or os.environ.get("OPENBOT_SERVER_URL") or DEFAULT_SERVER_URL).rstrip("/")
        if mode == "stack":
            missing = missing_intelligence()
            if missing:
                return False, f"{BLOCKER} (missing: {', '.join(missing)}); see integrations/openbot/README.md"
        if not settings.crusoe_api_key:
            return False, "CRUSOE_API_KEY is not set in .env"
        token = os.environ.get("MANAGED_AGENT_TOKEN", "").strip()
        if not token:
            return False, f"MANAGED_AGENT_TOKEN is not set (integrations/openbot/.env.openbot missing) — {SETUP_HINT}"
        client = http if http is not None else _default_http()

        def get_json(url: str) -> tuple[int, Any]:
            r = client.get(url, timeout=HEALTH_TIMEOUT_S)
            try:
                return r.status_code, r.json()
            except Exception:  # noqa: BLE001
                return r.status_code, None

        try:
            status, body = get_json(proxy_url + "/health")
        except Exception:  # noqa: BLE001
            return False, f"Crusoe proxy not reachable on {_hostport(proxy_url)} — {SETUP_HINT}"
        if status != 200 or not isinstance(body, dict) or body.get("status") != "ok":
            return False, f"Crusoe proxy on {_hostport(proxy_url)} is unhealthy (HTTP {status}) — {SETUP_HINT}"
        if not body.get("key_loaded"):
            return False, f"Crusoe proxy on {_hostport(proxy_url)} has no CRUSOE_API_KEY — fix .env, then {SETUP_HINT} --restart"

        try:
            status, body = get_json(_base(agent_url) + "/health")
        except Exception:  # noqa: BLE001
            return False, f"agent-bot not reachable on {_hostport(agent_url)} — {SETUP_HINT}"
        if status != 200 or not isinstance(body, dict) or body.get("status") != "ok":
            return False, f"agent-bot on {_hostport(agent_url)} is unhealthy (HTTP {status}) — {SETUP_HINT}"
        bot_model = str(body.get("model") or "")
        if bot_model != settings.worker_model:
            return False, (f"agent-bot on {_hostport(agent_url)} runs model {bot_model!r} but the worker model is "
                           f"{settings.worker_model!r} — {SETUP_HINT} --restart")
        # Token check without a model call: the token is checked before the body is parsed, so an
        # unparseable body answers 401 for a wrong token and an error (not 401) for the right one.
        try:
            r = client.post(agent_url, content=b"ratchet-token-probe", timeout=HEALTH_TIMEOUT_S,
                            headers={AGENT_TOKEN_HEADER: token, "content-type": "application/json"})
            if r.status_code == 401:
                return False, (f"agent-bot on {_hostport(agent_url)} rejected MANAGED_AGENT_TOKEN (started by another "
                               f"setup?) — {SETUP_HINT} --restart")
        except Exception:  # noqa: BLE001
            return False, f"agent-bot not reachable on {_hostport(agent_url)} — {SETUP_HINT}"

        if mode == "stack":
            try:
                status, _ = get_json(server_url + "/health")
            except Exception:  # noqa: BLE001
                return False, f"OpenBot server not reachable on {_hostport(server_url)} — {SETUP_HINT} --stack"
            if status != 200:
                return False, f"OpenBot server on {_hostport(server_url)} is unhealthy (HTTP {status})"
            return True, f"OpenBot stack at {_hostport(server_url)} (agent-bot {bot_model} via proxy {_hostport(proxy_url)})"
        return True, f"OpenBot agent-bot {bot_model} at {_hostport(agent_url)} via Crusoe proxy {_hostport(proxy_url)}"

    # ------------------------------------------------------------------ Worker interface

    def reset(self) -> None:
        """agui: nothing to wipe (agent-bot is stateless; every run has its own workspace dir).
        stack: reset the coworker's computer (best effort, idempotent)."""
        if self.mode != "stack":
            return
        try:
            self.http.post(f"{self.server_url}/api/computers/{self.bot_id}/computers/reset",
                           headers=self._server_headers(), json={}, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            log.warning("openbot stack reset failed: %s", type(exc).__name__)

    def run_task(self, task: Task, playbook: str, *, version: int, repeat: int, run_dir: Path,
                 tag: str) -> Transcript:
        """Same contract, step cap, circuit breaker, wall clock and stop reasons as LocalWorker; only the
        model turn differs (an AG-UI run of OpenBot's agent-bot instead of a direct Crusoe call)."""
        from ratchet.worker import build_system_prompt, build_task_message  # I1

        s = self.settings
        started_at = utcnow()
        t0 = time.monotonic()
        run_dir = Path(run_dir)
        workspace = run_dir / "workspace"
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": build_system_prompt(playbook)},
            {"role": "user", "content": build_task_message(task)},
        ]
        steps: list[ToolStep] = []
        usage = Usage()
        usage_by_model: dict[str, Usage] = {}
        stop_reason = "step_cap"
        error: str | None = None
        submit_summary = ""
        toolbox = None
        thread_id = f"ratchet-v{version}-{task.task_id}-r{repeat}"
        seed = seed_for(task.task_id, repeat)
        events_path = run_dir / "openbot_events.jsonl"

        try:
            if workspace.exists():
                shutil.rmtree(workspace)
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / task.entry_file).parent.mkdir(parents=True, exist_ok=True)
            (workspace / task.entry_file).write_text(task.starter_code, encoding="utf-8")
            if events_path.exists():
                events_path.unlink()
            toolbox = self._make_toolbox(workspace, tag)
            tools = agui_tools(toolbox.schemas())
            if self.mode == "stack":
                self._ensure_playbook_published(playbook, version)
                thread_id = self._mint_thread() or thread_id
            nudges = 0
            finished = False
            signatures: list[tuple[str, str]] = []
            test_outputs: list[str] = []
            for _ in range(s.worker_max_steps):
                if interrupt.stop_requested():
                    stop_reason = "interrupted"
                    finished = True
                    break
                if time.monotonic() - t0 > s.task_wallclock_s:
                    stop_reason = "wallclock"
                    finished = True
                    break
                turn = self._turn(messages, tools, thread_id=thread_id, tag=tag, seed=seed, events_path=events_path)
                usage = usage + turn.usage
                usage_by_model[turn.model] = usage_by_model.get(turn.model, Usage()) + turn.usage
                assistant: dict[str, Any] = {"role": "assistant", "content": turn.content or None}
                if turn.tool_calls:
                    assistant["tool_calls"] = [
                        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.raw_arguments}}
                        for c in turn.tool_calls
                    ]
                messages.append(assistant)
                if not turn.tool_calls:
                    if turn.finish_reason == "length" and nudges < 2:   # same rule as LocalWorker
                        nudges += 1
                        from ratchet.worker import NUDGE_CUT_OFF_TOOL
                        lost_call = "<function=" in (turn.content or "") or "<tool_call>" in (turn.content or "")
                        messages.append({"role": "user", "content": NUDGE_CUT_OFF_TOOL if lost_call else CUT_OFF_NUDGE})
                        continue
                    stop_reason = "done"
                    finished = True
                    break
                for call in turn.tool_calls:
                    t_call = time.monotonic()
                    if arguments_malformed(call.raw_arguments):
                        msg = f"arguments for {call.name} were not valid JSON; send a JSON object"
                        text, err, is_submit = f"error: {msg}", msg, False
                    else:
                        outcome = toolbox.call(call.name, call.arguments)
                        text, err, is_submit = outcome.text, outcome.error, outcome.is_submit
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": text})
                    steps.append(ToolStep(step=len(steps) + 1, tool=call.name, arguments=call.arguments, result=text,
                                          duration_ms=int((time.monotonic() - t_call) * 1000), error=err))
                    if is_submit:
                        summary = call.arguments.get("summary")
                        submit_summary = summary if isinstance(summary, str) else ""
                        stop_reason = "done"
                        finished = True
                        break
                    signatures.append((call.name, json.dumps(call.arguments, sort_keys=True)))
                    if call.name == "run_tests":
                        test_outputs.append(_TIMING_RE.sub("in Ns", text))
                    if (len(signatures) >= 3 and len(set(signatures[-3:])) == 1) or \
                            (len(test_outputs) >= 3 and len(set(test_outputs[-3:])) == 1):
                        stop_reason = "circuit_breaker"
                        finished = True
                        break
                if finished:
                    break
            if not finished:
                stop_reason = "wallclock" if time.monotonic() - t0 > s.task_wallclock_s else "step_cap"
        except interrupt.RunInterrupted:
            stop_reason = "interrupted"  # the gate discards this run instead of scoring it
        except Exception as exc:  # noqa: BLE001 - a Transcript is always returned (workspace may still pass)
            stop_reason = "error"
            error = f"{type(exc).__name__}: {exc}"[:500]
            log.warning("openbot run %s failed: %s", tag, error)

        workspace_files: dict[str, str] = {}
        if toolbox is not None:
            try:
                workspace_files = toolbox.snapshot_files()
            except Exception as exc:  # noqa: BLE001
                error = error or f"snapshot failed: {type(exc).__name__}: {exc}"[:500]
        final_answer = ""
        for m in reversed(messages):
            if m.get("role") == "assistant" and isinstance(m.get("content"), str) and m["content"].strip():
                final_answer = m["content"]
                break
        if not final_answer:
            final_answer = submit_summary
        log.debug("openbot %s done stop=%s steps=%d tokens=%d", tag, stop_reason, len(steps),
                  usage.prompt_tokens + usage.completion_tokens)
        return Transcript(
            task_id=task.task_id, worker=self.name, model=s.worker_model, version=version, repeat=repeat,
            started_at=started_at, finished_at=utcnow(), messages=messages, steps=steps,
            final_answer=final_answer, stop_reason=stop_reason, usage=usage, usage_by_model=usage_by_model,
            workspace_files=workspace_files, error=error,
        )

    # ------------------------------------------------------------------ internals

    def _make_toolbox(self, workspace: Path, tag: str) -> Any:
        if self._toolbox_factory is not None:
            return self._toolbox_factory(workspace, tag)
        from ratchet.sandbox import Sandbox  # I1
        from ratchet.tools import ToolBox  # I1

        with self._lock:
            if self._sandbox is None:
                self._sandbox = Sandbox(self.settings)
        return ToolBox(workspace, self._sandbox, self.settings, search_enabled=True, tag=tag)

    def _run_input(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, thread_id: str,
                   run_id: str, tag: str, seed: int) -> dict[str, Any]:
        # host_guidance=strip: the proxy removes agent-bot's fixed COMPUTER_GUIDANCE system message (it
        # describes computer_* browser tools this coworker does not have) so the model reads the same
        # prompt as a LocalWorker run of the same playbook.
        meta = {"tag": tag, "run": run_id, "seed": seed, "ledger": "caller" if self.ledger is not None else "proxy",
                "host_guidance": "strip"}
        return {
            "threadId": thread_id,
            "runId": run_id,
            "messages": to_agui_messages(messages),
            "tools": tools,
            "context": [{"description": META_DESCRIPTION, "value": json.dumps(meta, sort_keys=True)}],
            "state": {},
            "forwardedProps": {},
        }

    def _server_headers(self) -> dict[str, str]:
        # Single-user OpenBot admits loopback requests; setting writes want same-origin JSON.
        return {"Origin": self.app_origin, "Content-Type": "application/json"}

    def _post_run(self, body: dict[str, Any], tag: str) -> Any:
        headers = {"Accept": "text/event-stream", "Content-Type": "application/json", "X-Ratchet-Tag": tag}
        if self.mode == "agui":
            headers[AGENT_TOKEN_HEADER] = self.token
            url = self.agent_url
        else:
            headers.update(self._server_headers())
            url = f"{self.server_url}/api/copilotkit/agent/{self.bot_id}/run"
        return self.http.post(url, json=body, headers=headers, timeout=self.turn_timeout_s)

    def _fetch_usage(self, run_id: str) -> dict[str, Any] | None:
        """Usage the proxy recorded for this AG-UI run (polls briefly; None if it made no model call)."""
        for attempt in range(10):
            try:
                r = self.http.get(f"{self.proxy_url}/usage/{run_id}", timeout=HEALTH_TIMEOUT_S)
            except Exception:  # noqa: BLE001
                return None
            if r.status_code == 200:
                try:
                    return r.json()
                except Exception:  # noqa: BLE001
                    return None
            if r.status_code != 404:
                return None
            self._sleep(0.05 * (attempt + 1))
        return None

    def _turn(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, thread_id: str, tag: str,
              seed: int, events_path: Path) -> _Turn:
        total = Usage()
        model = self.settings.worker_model
        last_error = ""
        for attempt in range(TURN_RETRIES + 1):
            interrupt.check()  # a stopping gate starts no new AG-UI runs
            run_id = f"{thread_id}-{uuid.uuid4().hex[:12]}"
            body = self._run_input(messages, tools, thread_id=thread_id, run_id=run_id, tag=tag, seed=seed)
            content, calls, err, events, status = "", [], None, [], 0
            try:
                resp = self._post_run(body, tag)
                status = resp.status_code
                if status == 401:
                    raise OpenBotUnavailable(f"OpenBot refused the run (HTTP 401): MANAGED_AGENT_TOKEN mismatch — {SETUP_HINT} --restart")
                if status >= 400:
                    err = f"HTTP {status}: {resp.text[:200]}"
                else:
                    events = parse_sse_events(resp.text)
                    content, calls, err = events_to_turn(events)
            except OpenBotUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001 - network error / timeout: retry the turn
                err = f"{type(exc).__name__}: {exc}"
            rec = self._fetch_usage(run_id)
            finish = ""
            if rec:
                u = Usage.from_dict(rec.get("usage") or {})
                total = total + u
                model = rec.get("model") or model
                finish = rec.get("finish_reason") or ""
                if self.ledger is not None:
                    try:
                        self.ledger.record(tag=tag, model=model, usage=u, latency_ms=int(rec.get("latency_ms") or 0),
                                           finish_reason=finish or ("error" if err else "stop"),
                                           attempts=int(rec.get("attempts") or 1), thinking=self.settings.worker_thinking)
                    except Exception:  # noqa: BLE001
                        log.exception("ledger record failed")
            self._log_events(events_path, thread_id=thread_id, run_id=run_id, attempt=attempt, status=status,
                             error=err, events=events)
            if rec and rec.get("error") == "empty_content":
                # The proxy got an empty cut-off answer even with the doubled budget (CrusoeClient raises
                # EmptyContentError there): end the run with stop_reason="error" like LocalWorker, no retry.
                raise RuntimeError(f"EmptyContentError: {model}: empty content with finish_reason=length "
                                   "after the doubled max_tokens retry")
            if err is None:
                return _Turn(content=content, tool_calls=calls, finish_reason=finish, usage=total, model=model,
                             events=events)
            last_error = err
            log.info("openbot turn %s attempt %d failed: %s", tag, attempt + 1, err[:200])
            if attempt < TURN_RETRIES:
                self._sleep(2.0 * (attempt + 1))
        raise RuntimeError(f"OpenBot run failed after {TURN_RETRIES + 1} attempts: {last_error}"[:500])

    def _log_events(self, path: Path, **row: Any) -> None:
        try:
            row = {"ts": utcnow(), "mode": self.mode, **row}
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001 - the audit file is best effort
            pass

    # ------------------------------------------------------------------ stack mode

    def _mint_thread(self) -> str | None:
        """A deployment-prefixed thread id from OpenBot (POST /api/threads/mint)."""
        r = self.http.post(f"{self.server_url}/api/threads/mint", headers=self._server_headers(), json={}, timeout=10.0)
        if r.status_code == 200:
            try:
                return str(r.json().get("threadId") or "") or None
            except Exception:  # noqa: BLE001
                return None
        raise OpenBotUnavailable(f"OpenBot server refused to mint a thread (HTTP {r.status_code})")

    def publish_playbook(self, playbook: str, version: int) -> None:
        """Publish the playbook as the deployment-wide `ratchet-playbook` skill (POST is an upsert)."""
        body = {
            "slug": PLAYBOOK_SKILL_SLUG,
            "title": f"Ratchet playbook v{version}",
            "summary": "How the Ratchet coworker solves Python tasks; rewritten by Ratchet and kept only if it wins on the sealed holdout.",
            "instructions": playbook,
            "global": True,
        }
        r = self.http.post(f"{self.server_url}/api/plugins/skills", headers=self._server_headers(), json=body, timeout=30.0)
        if r.status_code >= 400:
            raise OpenBotUnavailable(f"OpenBot refused the playbook skill (HTTP {r.status_code}): {r.text[:200]}")

    def _ensure_playbook_published(self, playbook: str, version: int) -> None:
        with self._lock:
            if self._published == playbook:
                return
            self.publish_playbook(playbook, version)
            self._published = playbook
