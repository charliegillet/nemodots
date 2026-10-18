#!/usr/bin/env bash
# Bring up OpenBot as Ratchet's worker host (owner I4). Idempotent.
#
#   bash integrations/openbot/setup.sh            # agui mode: Crusoe proxy (8787) + OpenBot agent-bot (4200)
#   bash integrations/openbot/setup.sh --restart  # stop what this script started, then start again
#   bash integrations/openbot/setup.sh --status   # health of both, no changes
#   bash integrations/openbot/setup.sh --stack    # full OpenBot stack (needs a CopilotKit Intelligence key)
#
# Never prints secrets. The Crusoe key stays in the repo's .env and is read only by crusoe_proxy.py;
# agent-bot talks to the proxy on loopback with MANAGED_AGENT_TOKEN as its API key, and the proxy
# rejects chat calls without it (RATCHET_PROXY_CLIENT_KEY), so other local processes cannot spend the
# Crusoe key. Do not run an OpenBot smoke while a local DEMO is running: both pace Lightning
# independently and together exceed the per-model rate limit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENDOR="$ROOT/vendor/openbot"
PY="$ROOT/.venv/bin/python"
ENV_FILE="$HERE/.env.openbot"
RUNS="${RATCHET_RUNS_DIR:-$ROOT/runs}"
STATE="$RUNS/openbot"
PROXY_PORT="${OPENBOT_PROXY_PORT:-8787}"
AGENT_PORT="${OPENBOT_AGENT_PORT:-4200}"
BLOCKER="BLOCKER: CopilotKit Intelligence key (INTELLIGENCE_API_KEY) is required by OpenBot and is not set"

MODE="agui"
case "${1:-}" in
  "") ;;
  --restart) MODE="restart" ;;
  --status) MODE="status" ;;
  --stack) MODE="stack" ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--restart|--status|--stack]" >&2; exit 64 ;;
esac

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31merror\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

health() { curl -fsS --max-time 2 "$1" 2>/dev/null; }
json_field() { "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get(sys.argv[1], ""))
except Exception: print("")' "$1"; }

# Read one NAME=value from an env file without sourcing it (so nothing else is exported or echoed).
env_value() {
  local file="$1" name="$2"
  [ -f "$file" ] || return 0
  grep -E "^(export )?$name=" "$file" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}

# Set NAME=value in an env file, replacing an existing line (no blank or duplicate lines).
set_env_value() {
  local file="$1" name="$2" value="$3" tmp
  touch "$file"
  tmp="$(mktemp)"
  grep -vE "^(export )?$name=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

worker_model() {
  "$PY" -c 'from ratchet.config import Settings; print(Settings.from_env().worker_model)'
}

status() {
  local p a
  p="$(health "http://127.0.0.1:$PROXY_PORT/health" || true)"
  a="$(health "http://127.0.0.1:$AGENT_PORT/health" || true)"
  if [ -n "$p" ]; then ok "crusoe proxy  http://127.0.0.1:$PROXY_PORT/v1  (key loaded: $(printf '%s' "$p" | json_field key_loaded), calls: $(printf '%s' "$p" | json_field calls))"
  else warn "crusoe proxy  not answering on 127.0.0.1:$PROXY_PORT"; fi
  if [ -n "$a" ]; then ok "agent-bot     http://127.0.0.1:$AGENT_PORT/ag-ui  (model: $(printf '%s' "$a" | json_field model))"
  else warn "agent-bot     not answering on 127.0.0.1:$AGENT_PORT"; fi
  [ -n "$p" ] && [ -n "$a" ]
}

stop_ours() { bash "$HERE/stop.sh" >/dev/null 2>&1 || true; }

if [ "$MODE" = "status" ]; then
  [ -x "$PY" ] || die ".venv missing: run 'uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -e .[dev]'"
  status && exit 0 || exit 1
fi
if [ "$MODE" = "restart" ]; then
  say "Stopping what setup.sh started ..."
  stop_ours
  MODE="agui"
fi

say "Ratchet x OpenBot setup ($MODE mode)"

# ---------------------------------------------------------------------------------------- prerequisites
[ -x "$PY" ] || die ".venv missing: run 'uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -e .[dev]'"
command -v bun >/dev/null 2>&1 || die "bun not found: install it from https://bun.sh (official installer or 'brew install oven-sh/bun/bun')"
command -v curl >/dev/null 2>&1 || die "curl not found"
command -v openssl >/dev/null 2>&1 || die "openssl not found"
ok "bun $(bun --version), $("$PY" --version 2>&1)"

if [ ! -d "$VENDOR/.git" ] && [ ! -f "$VENDOR/agent-bot/src/index.ts" ]; then
  say "Cloning OpenBot into vendor/openbot (gitignored) ..."
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 https://github.com/CopilotKit/OpenBot "$VENDOR"
fi
[ -f "$VENDOR/agent-bot/src/index.ts" ] || die "vendor/openbot/agent-bot/src/index.ts missing: is vendor/openbot a CopilotKit/OpenBot clone?"
ok "OpenBot at vendor/openbot ($(git -C "$VENDOR" rev-parse --short HEAD 2>/dev/null || echo unknown))"

if [ ! -d "$VENDOR/agent-bot/node_modules/@ag-ui/encoder" ] || [ ! -d "$VENDOR/agent-bot/node_modules/openai" ]; then
  say "Installing agent-bot dependencies (bun install --frozen-lockfile) ..."
  (cd "$VENDOR/agent-bot" && bun install --frozen-lockfile)
fi
ok "agent-bot dependencies installed"

"$PY" -c 'import sys; from ratchet.config import Settings; sys.exit(0 if Settings.from_env().crusoe_api_key else 1)' \
  || die "CRUSOE_API_KEY is not set in $ROOT/.env" 2

# ---------------------------------------------------------------------------------------- token
mkdir -p "$STATE"
TOKEN="$(env_value "$ENV_FILE" MANAGED_AGENT_TOKEN)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 32)"
  set_env_value "$ENV_FILE" MANAGED_AGENT_TOKEN "$TOKEN"
  ok "generated MANAGED_AGENT_TOKEN into integrations/openbot/.env.openbot"
else
  ok "MANAGED_AGENT_TOKEN present in integrations/openbot/.env.openbot"
fi
chmod 600 "$ENV_FILE"
MODEL="$(worker_model)"

# ---------------------------------------------------------------------------------------- stack mode
if [ "$MODE" = "stack" ]; then
  # Environment first, then the repo's .env, integrations/openbot/.env.openbot, vendor/openbot/.env.
  # The two URLs default to OpenBot's public endpoints (vendor/openbot/.env.example); the key may be
  # stored as CPK_INTELLIGENCE_API_KEY (the name OpenBot's own `copilotkit project select` writes).
  ival() { local v="${!1:-}"; [ -n "$v" ] || v="$(env_value "$ROOT/.env" "$1")"; [ -n "$v" ] || v="$(env_value "$ENV_FILE" "$1")"; [ -n "$v" ] || v="$(env_value "$VENDOR/.env" "$1")"; printf '%s' "$v"; }
  I_URL="$(ival INTELLIGENCE_API_URL)"; [ -n "$I_URL" ] || I_URL="https://api.intelligence.copilotkit.ai"
  I_WS="$(ival INTELLIGENCE_GATEWAY_WS_URL)"; [ -n "$I_WS" ] || I_WS="wss://realtime.intelligence.copilotkit.ai"
  I_KEY="$(ival INTELLIGENCE_API_KEY)"; [ -n "$I_KEY" ] || I_KEY="$(ival CPK_INTELLIGENCE_API_KEY)"
  missing=""
  [ -n "$I_URL" ] || missing="$missing INTELLIGENCE_API_URL"
  [ -n "$I_WS" ] || missing="$missing INTELLIGENCE_GATEWAY_WS_URL"
  [ -n "$I_KEY" ] || missing="$missing INTELLIGENCE_API_KEY"
  if [ -n "$missing" ]; then
    echo "$BLOCKER"
    echo "  missing:$missing"
    echo "  OpenBot's server refuses to start without them (vendor/openbot/server/src/config.ts), and the key"
    echo "  needs a CopilotKit account. Ratchet will not create one. Use agui mode instead:"
    echo "    bash integrations/openbot/setup.sh && .venv/bin/python -m ratchet run --config smoke --worker openbot"
    exit 2
  fi
  command -v docker >/dev/null 2>&1 || die "docker not found (the OpenBot stack is a Docker Compose deployment)"
  # Renders the tenant package, points the stack's model calls at the Crusoe proxy and hands over to
  # OpenBot's own start script.
  say "Rendering the Ratchet tenant package into vendor/openbot/examples/ratchet ..."
  "$PY" - "$HERE/tenant" "$VENDOR/examples/ratchet" "$RUNS" "$ROOT" <<'PYEOF'
import json, shutil, sys
from pathlib import Path
src, dst, runs, root = (Path(a) for a in sys.argv[1:5])
dst.mkdir(parents=True, exist_ok=True)
for f in src.glob("*.yaml"):
    shutil.copy(f, dst / f.name)
playbook = None
hist = runs / "history.json"
if hist.exists():
    h = json.loads(hist.read_text())
    inc = next((v for v in h.get("versions", []) if v.get("status") == "incumbent"), None)
    if inc and (root / inc["playbook_path"]).exists():
        playbook = (root / inc["playbook_path"]).read_text()
if playbook is None and (root / "playbooks" / "v0.md").exists():
    playbook = (root / "playbooks" / "v0.md").read_text()
playbook = (playbook or "Read the task, write solution.py, test it, then call submit.").rstrip()
indented = "\n".join(("      " + line) if line else "" for line in playbook.splitlines())
text = (src / "skills.yaml").read_text().replace("      {{PLAYBOOK}}", indented)
(dst / "skills.yaml").write_text(text)
PYEOF
  [ -f "$VENDOR/.env" ] || cp "$VENDOR/.env.example" "$VENDOR/.env"
  set_env_value "$VENDOR/.env" TENANT_PACKAGE_DIR "../examples/ratchet"
  set_env_value "$VENDOR/.env" OPENBOT_SINGLE_USER "true"
  set_env_value "$VENDOR/.env" OPENAI_API_KEY "$TOKEN"
  set_env_value "$VENDOR/.env" OPENAI_BASE_URL "http://127.0.0.1:$PROXY_PORT/v1"
  set_env_value "$VENDOR/.env" OPENAI_CONTAINER_BASE_URL "http://host.docker.internal:$PROXY_PORT/v1"
  set_env_value "$VENDOR/.env" BOT_PROVIDER "openai"
  set_env_value "$VENDOR/.env" BOT_MODEL "$MODEL"
  set_env_value "$VENDOR/.env" AGENT_BOT_MODEL "$MODEL"
  set_env_value "$VENDOR/.env" MANAGED_AGENT_TOKEN "$TOKEN"
  set_env_value "$VENDOR/.env" INTELLIGENCE_API_URL "$I_URL"
  set_env_value "$VENDOR/.env" INTELLIGENCE_GATEWAY_WS_URL "$I_WS"
  set_env_value "$VENDOR/.env" INTELLIGENCE_API_KEY "$I_KEY"
  chmod 600 "$VENDOR/.env"
  # The stack runs its own agent-bot container on 4200; stop ours so the port is free.
  if pid_alive "$STATE/agent-bot.pid"; then kill "$(cat "$STATE/agent-bot.pid")" 2>/dev/null || true; rm -f "$STATE/agent-bot.pid"; fi
  # The proxy stays on loopback (it holds the Crusoe key). Docker Desktop and colima both route
  # host.docker.internal to the host's loopback, which is how the stack's containers reach it.
fi

# ---------------------------------------------------------------------------------------- proxy
start_proxy() {
  local host="127.0.0.1"
  local h
  if h="$(health "http://127.0.0.1:$PROXY_PORT/health")"; then
    ok "crusoe proxy already running on $PROXY_PORT"
    if [ "$(printf '%s' "$h" | json_field client_auth)" != "True" ]; then
      warn "that proxy does not require a client key (started by an older setup.sh): run setup.sh --restart"
    fi
    return
  fi
  say "Starting crusoe proxy on $host:$PROXY_PORT ..."
  # `exec` so the recorded pid is the proxy itself, and every inherited stream is redirected so no
  # caller pipe is held open (a `cmd | tail` of this script returns as soon as it finishes).
  ( cd "$ROOT" && RATCHET_PROXY_CLIENT_KEY="$TOKEN" exec nohup "$PY" "$HERE/crusoe_proxy.py" --host "$host" --port "$PROXY_PORT" \
      --log-file "$STATE/proxy.log" < /dev/null > "$STATE/proxy.out" 2>&1 ) &
  echo $! > "$STATE/proxy.pid"
  for _ in $(seq 1 50); do
    health "http://127.0.0.1:$PROXY_PORT/health" >/dev/null && { ok "crusoe proxy up (pid $(cat "$STATE/proxy.pid"))"; return; }
    pid_alive "$STATE/proxy.pid" || break
    sleep 0.2
  done
  tail -n 20 "$STATE/proxy.out" >&2 || true
  die "crusoe proxy did not come up (log: runs/openbot/proxy.out)"
}
start_proxy

if [ "$MODE" = "stack" ]; then
  say "Handing over to OpenBot's scripts/start.sh (Docker Compose; first build takes a while) ..."
  (cd "$VENDOR" && bash scripts/start.sh)
  exit $?
fi

# ---------------------------------------------------------------------------------------- agent-bot
AGENT_HEALTH="$(health "http://127.0.0.1:$AGENT_PORT/health" || true)"
if [ -n "$AGENT_HEALTH" ]; then
  RUNNING_MODEL="$(printf '%s' "$AGENT_HEALTH" | json_field model)"
  if [ "$RUNNING_MODEL" != "$MODEL" ]; then
    if pid_alive "$STATE/agent-bot.pid"; then
      warn "agent-bot runs $RUNNING_MODEL, worker model is $MODEL: restarting it"
      kill "$(cat "$STATE/agent-bot.pid")" 2>/dev/null || true
      rm -f "$STATE/agent-bot.pid"
      sleep 0.5
      AGENT_HEALTH=""
    else
      die "something else answers on 127.0.0.1:$AGENT_PORT with model $RUNNING_MODEL (not started by this script). Stop it or set OPENBOT_AGENT_PORT."
    fi
  else
    ok "agent-bot already running on $AGENT_PORT (model $MODEL)"
  fi
fi
if [ -z "$AGENT_HEALTH" ]; then
  say "Starting OpenBot agent-bot on 127.0.0.1:$AGENT_PORT (model $MODEL) ..."
  # A clean environment: agent-bot sees the proxy and a placeholder key, never the Crusoe key.
  ( cd "$VENDOR" && exec nohup env -i PATH="$PATH" HOME="$HOME" \
      PORT="$AGENT_PORT" \
      MANAGED_AGENT_TOKEN="$TOKEN" \
      OPENAI_BASE_URL="http://127.0.0.1:$PROXY_PORT/v1" \
      OPENAI_API_KEY="$TOKEN" \
      BOT_MODEL="$MODEL" \
      AGENT_BOT_MODEL="$MODEL" \
      bun agent-bot/src/index.ts < /dev/null > "$STATE/agent-bot.log" 2>&1 ) &
  echo $! > "$STATE/agent-bot.pid"
  for _ in $(seq 1 75); do
    health "http://127.0.0.1:$AGENT_PORT/health" >/dev/null && { ok "agent-bot up (pid $(cat "$STATE/agent-bot.pid"))"; break; }
    pid_alive "$STATE/agent-bot.pid" || { tail -n 20 "$STATE/agent-bot.log" >&2 || true; die "agent-bot exited (log: runs/openbot/agent-bot.log)"; }
    sleep 0.2
  done
fi

say ""
status || die "not healthy; see runs/openbot/*.log"
say ""
say "Ready. Next:"
say "  .venv/bin/python -m ratchet run --config smoke --worker openbot"
say "  bash integrations/openbot/stop.sh   # when done"
