#!/usr/bin/env bash
# One-command install for worktable — self-contained bundle, no npm/network.
#   ./install.sh                 register for EVERY Claude Code session (user scope)
#   ./install.sh /path/to/repo   ALSO drop the canvas guidance + ask-back hook into
#                                that project (so the agent uses the canvas proactively)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$HERE/dist/server/index.js"

echo "worktable installer"

# node is the only runtime requirement the bundle can't carry.
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found. Install Node.js (any recent version), then re-run."
  exit 1
fi
echo "  ✓ node $(node --version)"

if [ ! -f "$SERVER" ]; then
  echo "  ✗ $SERVER is missing — run this from inside the extracted bundle folder."
  exit 1
fi

# Register for every Claude Code session (user scope). Idempotent: remove then add.
if command -v claude >/dev/null 2>&1; then
  claude mcp remove worktable -s user >/dev/null 2>&1 || true
  if claude mcp add -s user worktable -- node "$SERVER"; then
    echo "  ✓ registered 'worktable' for every Claude Code session"
  else
    echo "  ! auto-register failed — add it manually:"
    echo "      claude mcp add -s user worktable -- node \"$SERVER\""
  fi
else
  echo "  ! the 'claude' CLI isn't on your PATH. Register manually once it is:"
  echo "      claude mcp add -s user worktable -- node \"$SERVER\""
fi

# Optional: wire a specific project (guidance so the agent uses the canvas + the hook).
if [ "${1:-}" != "" ]; then
  if [ -d "$1" ]; then
    node "$HERE/scripts/register.mjs" "$1" --guidance --hook
    echo "  ✓ guidance + ask-back hook added to $1"
  else
    echo "  ! '$1' is not a directory — skipped project setup"
  fi
fi

echo
echo "Done. Restart Claude Code, then run  /mcp  — 'worktable' should show connected."
echo "In any project, ask the agent to publish something to the canvas."
