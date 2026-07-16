# 20 — Gate mode as a live, user-level human setting + canvas settings panel

Status: ready-for-agent
Type: task
Milestone: post-v1 (UX + config)
Blocked by: 12

## Context

The Legibility Gate's enforce/report mode (issue 12) is a per-workspace config.json
value read once at startup, hand-edited. ADR-0011 makes it a first-class human
setting: a user-level default + per-workspace override, set via a token-gated canvas
settings panel, applied LIVE (no restart). The panel also serves as the first-run
prompt. Precedence: `workspace config.json .gate` > `~/.visual-chat/config.json
.gate` > `"report"`.

CRITICAL invariant to preserve (issue 12 / ADR-0011): NO MCP tool changes gate mode.
The settings endpoints are bearer-gated browser (human) surfaces only. The no-self-
grant test must still pass and be EXTENDED to the new endpoint, never weakened.

## Implementation

**Config (src/server/config.ts):**
- Add `resolveGateMode(workspaceDir): { mode: GateMode; source: "workspace"|"user"|"default" }`
  — read `<workspaceDir>/config.json` `.gate`; if not "enforce"/"report" explicit,
  fall to `~/.visual-chat/config.json` `.gate`; else `report`/`default`. Anything
  malformed/missing degrades safely (report). Return the source for the UI.
- Keep `shouldEnforce` as-is (fail-open invariant unchanged).
- The user-level file is `~/.visual-chat/config.json` (sibling of the workspace
  dirs). Ensure `~/.visual-chat/` is 0700; write the file 0600, atomically.

**Live re-read (src/server/index.ts):** replace the boot-time `const gateMode =
readGateMode(...)` with a per-publish resolve — resolve gate mode inside the
publish/update handlers (or a getter called there) so a settings flip takes effect
on the next artifact with no restart. Two small file reads per publish is fine.

**Routes (bearer-gated, index.ts/http.ts):**
- `GET /api/settings` → `{ gate: { effective: "report"|"enforce", source } }`.
- `POST /api/settings` → body `{ gate: "report"|"enforce", scope: "workspace"|"user" }`;
  validate strictly (reject unknown gate/scope → 400); write the chosen config file
  (workspace or user-level) atomically 0600, preserving any other keys in that file;
  return the new resolution. 401 without the bearer token.

**Canvas settings panel (src/canvas/):** a gear button in the header (next to the
calibration link). Opens a small popover:
- Shows the effective mode + source ("Enforce · this workspace" / "Report · default").
- Report↔Enforce toggle; scope selector "This workspace" (default) / "All my
  workspaces". Microcopy: report = findings only, never blocks; enforce = an
  illegible SVG gets one repair round, then honest absence.
- On change: POST /api/settings, update the panel from the response (live). ALL text
  via textContent/createElement — no innerHTML.
- First-run: if GET /api/settings `source === "default"` (nothing set anywhere),
  surface the panel once on load (auto-open or a subtle header highlight) so the
  human sets it the first time.

**Docs:** update docs/setup.md — gate mode is now set in the canvas panel (or the two
config files); note the precedence and that no MCP tool can change it.

## Acceptance Criteria

1. `resolveGateMode` precedence: workspace override wins over user default wins over
   `report`; malformed/missing at either level degrades to the next; source reported
   correctly. Unit-tested for all combinations.
2. LIVE: with the server running in report mode, POST /api/settings to enforce, then
   publish a finding-laden SVG → it is enforced (gate:failed / repair), NO restart.
   Integration test proves it.
3. Scope: POST scope:"user" writes ~/.visual-chat/config.json; scope:"workspace"
   writes the workspace config.json; each file 0600; other keys preserved.
4. Auth: GET and POST /api/settings return 401 without the bearer token.
5. Validation: unknown gate or scope → 400, nothing written.
6. No-self-grant (EXTENDED, not weakened): the issue-12 security test still passes;
   listTools() still returns exactly the 6 tools (no settings/gate/config tool); and
   assert the /api/settings write path is reachable ONLY via the token, never via any
   MCP tool.
7. First-run: with no gate set anywhere, the panel surfaces on canvas load; once set,
   it doesn't nag.
8. Report-only fail-open unchanged; report remains the ultimate default.
9. `bun test` green; zero new deps.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | resolveGateMode precedence + degrade + source; settings body validation | +6 |
| Integration | live report→enforce flip drives enforcement; scope writes right file; 401s; no-self-grant extended | +6 |
| Canvas (jsdom) | panel renders effective mode; toggle POSTs; textContent-only; first-run surfaces | +3 |

## Out of Scope

Changing the four checks or enforcement mechanics (issue 12). Per-artifact gate
settings. A general settings framework beyond gate mode (keep the panel focused; it
can grow later).
