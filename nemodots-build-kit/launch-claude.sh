#!/usr/bin/env bash
# Interactive native teams require an interactive session, so do not use -p.
set -euo pipefail

kit_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd -- "$kit_dir/.." && pwd)"
app_dir="$workspace_dir/NemoDots"

if [[ ! -f "$app_dir/docs/nemodots/BUILD_PROMPT.md" ]]; then
  printf '%s\n' 'Run python3 nemodots-build-kit/prepare.py before launching.' >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  printf '%s\n' 'Claude Code is required. Install/authenticate using official Claude Code documentation.' >&2
  exit 1
fi

case "${1:-build}" in
  build)
    initial_prompt='Read CLAUDE.md and docs/nemodots/BUILD_PROMPT.md in full. Execute the implementation assignment. Begin the source/dependency audit and independent acceptance design, form the requested Opus 5 and Sonnet 5.5 team, verify effective models, then build and test through available live acceptance. Do not stop at a plan. Report blocked external gates honestly.'
    ;;
  verify)
    initial_prompt='Read CLAUDE.md, docs/nemodots/BUILD_PROMPT.md and docs/nemodots/TEST_PROMPT.md in full. Execute the independent verification and repair assignment against actual current files. Verify effective models, separate test/oracle ownership from implementation, run real checks, coordinate fixes, rerun and report PASS/FAIL/BLOCKED/NOT_RUN with evidence.'
    ;;
  --dry-run)
    printf 'Application: %s\n' "$app_dir"
    printf '%s\n' 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --model claude-opus-5 --effort high <interactive initial prompt>'
    printf '%s\n' 'No Claude session or API request launched.'
    exit 0
    ;;
  *)
    printf '%s\n' 'Usage: bash nemodots-build-kit/launch-claude.sh [build|verify|--dry-run]' >&2
    exit 2
    ;;
esac

cd -- "$app_dir"
# Do not unset model overrides, add permission bypasses, or silently pick newer models.
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
exec claude --model claude-opus-5 --effort high "$initial_prompt"
