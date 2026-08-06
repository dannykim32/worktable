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
# Also drop the pre-rename "visual-chat" registration if this machine has one —
# left behind, it registers a second (usually dead) copy of this same server.
if command -v claude >/dev/null 2>&1; then
  if claude mcp remove visual-chat -s user >/dev/null 2>&1; then
    echo "  ✓ removed stale 'visual-chat' registration (project renamed)"
  fi
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

# Guidance + ask-back hook USER-WIDE (~/.claude): every repo gets the canvas
# behavior with no per-repo setup. Re-running upgrades the guidance in place.
if node "$HERE/scripts/register.mjs" --user >/dev/null 2>&1; then
  echo "  ✓ guidance + ask-back hook installed user-wide (~/.claude)"
else
  echo "  ! user-wide guidance/hook install failed — run manually:"
  echo "      node \"$HERE/scripts/register.mjs\" --user"
fi

# Optional: ALSO wire a specific project (a repo-local copy of guidance + hook;
# useful when a repo should carry the setup for teammates, or to migrate away
# stale pre-rename blocks). Not required for the canvas to work there.
if [ "${1:-}" != "" ]; then
  if [ -d "$1" ]; then
    node "$HERE/scripts/register.mjs" "$1" --guidance --hook
    echo "  ✓ guidance + ask-back hook added to $1"
  else
    echo "  ! '$1' is not a directory — skipped project setup"
  fi
fi

if [ -d "$HOME/.visual-chat" ]; then
  echo "  ! pre-rename state found at ~/.visual-chat (old tokens/artifacts) —"
  echo "    the server now uses ~/.worktable. Safe to delete: rm -rf ~/.visual-chat"
fi

echo
echo "Done. Restart Claude Code, then run  /mcp  — 'worktable' should show connected."
echo "In any project, ask the agent to publish something to the canvas."
