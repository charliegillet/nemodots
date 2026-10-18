#!/usr/bin/env bash
# Stop what integrations/openbot/setup.sh started (crusoe proxy + agent-bot), using its pid files.
# Never touches processes it did not start. With --stack also runs OpenBot's own scripts/stop.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${RATCHET_RUNS_DIR:-$ROOT/runs}/openbot"

stop_pid() {
  local name="$1" file="$STATE/$1.pid" pid
  if [ ! -f "$file" ]; then
    printf '  -     %s (not started by setup.sh)\n' "$name"
    return
  fi
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    printf '  ok    stopped %s (pid %s)\n' "$name" "$pid"
  else
    printf '  -     %s was not running\n' "$name"
  fi
  rm -f "$file"
}

stop_pid agent-bot
stop_pid proxy

if [ "${1:-}" = "--stack" ] && [ -f "$ROOT/vendor/openbot/scripts/stop.sh" ]; then
  (cd "$ROOT/vendor/openbot" && bash scripts/stop.sh)
fi
