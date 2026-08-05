# Gate mode is a human-settable, live, user-level-or-workspace preference

> **Status: retired by [ADR-0012](0012-html-hatch-is-the-surface.md) (2026-08-04).**
> The Legibility Gate was removed with the `svg` type, so this setting no longer
> exists. Kept for the record.

Issue 12 made the Legibility Gate's enforce/report mode a per-workspace
`config.json` value read ONCE at server startup, editable only by hand. That was
right for shipping enforcement safely, but a file-edit-and-restart is poor UX for a
setting people will actually toggle. We now make gate mode a first-class human
setting with three surfaces and live application, resolved by precedence:

    workspace config.json .gate  >  ~/.visual-chat/config.json .gate  >  "report"

- **User-level default** (`~/.visual-chat/config.json`) applies to every workspace.
- **Per-workspace override** (`<workspaceDir>/config.json`) wins for that workspace.
- **Canvas settings panel** — a token-gated control in the browser (the human's
  surface) that writes either level and applies LIVE (the server resolves gate mode
  per publish now, not once at boot). It also serves as the first-run prompt when no
  mode is set anywhere.

## Security invariant — preserved, and honestly framed

The issue-12 invariant stands: **no MCP tool can change gate mode.** The agent's
tool surface still cannot arm or disarm enforcement — the settings endpoints are
bearer-token-gated browser (human) surfaces, and the no-self-grant test is extended,
not weakened. What this ADR makes explicit: gate mode was never a hard boundary
against a filesystem-capable agent (a Bash-capable Claude Code agent can already
edit config.json directly). It is a QUALITY control the human owns, not a defense
against a compromised agent. A token-gated human toggle does not change that posture;
it just makes the human's own control ergonomic. The fail-open invariant (a gate
crash never blocks a publish) and the safe `report` default are unchanged.

## Consequences

- `readGateMode(stateDir)` becomes `resolveGateMode(workspaceDir)` (two-file
  precedence); gate mode is resolved per publish, so a flip takes effect on the next
  artifact with no restart.
- Two new bearer-gated routes: `GET /api/settings`, `POST /api/settings`. Still no
  MCP tool. Report remains the ultimate default when nothing is set.
