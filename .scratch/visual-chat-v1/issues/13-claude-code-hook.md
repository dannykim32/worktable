# 13 — Claude Code UserPromptSubmit hook

Status: done
Type: task
Milestone: M6
Blocked by: 05

## Context

ADR-0004: the hook removes the "nudge the terminal" ritual on Claude Code — pending
ask-backs auto-append to whatever the user types next. Optional layer; portable core
(check_askbacks) keeps working without it.

## Implementation Details

`hooks/askback-hook.ts` compiled to `dist/hooks/askback-hook.js`:

1. Derive workspaceId from cwd (same fn as server — export it from a shared module).
2. Read `~/.visual-chat/<id>/port` + `token`; if either missing → exit 0 silently.
3. `GET /api/askbacks/pending` (bearer, 300ms timeout) — new authed route, read-only,
   does NOT mark delivered (idempotent peek; delivery marking stays with
   check_askbacks so hook + tool don't race destructively).
4. Pending items → emit UserPromptSubmit JSON:
   `{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
      "additionalContext": "<formatted ask-backs with anchors + instruction to call
      check_askbacks to acknowledge>" } }`. None → exit 0, no output.

docs/setup.md gains the settings.json hook block (command, 5s timeout) and the
uninstall note.

## Acceptance Criteria

1. With server running + pending ask-backs: hook emits additionalContext containing
   each question + quote + artifact title within 300ms.
2. Server not running: exit 0, empty output, <400ms (measured in test).
3. Missing token/port files: exit 0 silently.
4. Hook never mutates queue state (peek route asserted read-only; pending still
   pending after 10 hook runs).
5. Manual walkthrough in docs: type anything in Claude Code after asking in browser →
   agent answers the ask-back without being told to check.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Integration | hook subprocess vs live server: pending/empty/down/missing-files | +4 |

## Effort

~3h.

## Out of Scope

Hooks for other MCP hosts, auto-installation of settings.json (documented, not
performed — user edits their own settings).

## Comments

Done. `hooks/askback-hook.ts` derives the workspace id via the shared
`deriveWorkspaceId` (extracted to `src/shared/workspaceId.ts`, re-exported from
`server/workspace.ts` — one hash, no fork), reads `~/.visual-chat/<id>/{port,
token}`, and does a 300ms read-only peek at the new `GET /api/askbacks/pending`
route, which returns pending items enriched with artifact titles WITHOUT marking
delivery. Any failure (missing files, server down, timeout) exits 0 silently.

The peek route calls `askbacks.pending()` (pure filter) — delivery marking stays
exclusively with `check_askbacks`/`drainPending`. The regression test runs the
hook subprocess 10× against a live server and asserts the item is still pending
after every run, then that `check_askbacks` finally drains it — proof the hook
is non-destructive.

Build: `hooks/tsconfig.json` typechecks the hook; `bun build --target=node`
bundles it to `dist/hooks/askback-hook.js` (both wired into `bun run build`).
Tests (5, all green): pending → additionalContext with question+quote+title;
read-only 10× peek; empty → no output; server-down → exit 0, empty, <400ms;
missing files → exit 0. docs/setup.md gains the settings.json hook block, a
manual verify step, and an uninstall note.

AC1–5 satisfied. Committed as feat(13).
