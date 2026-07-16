# Visual Chat — setup and walking-skeleton walkthrough

## Build

```sh
bun install
bun run build     # tsc (server + canvas typecheck) + vite build → dist/
bun test          # full suite, loopback only
```

## Register in Claude Code

Add the Canvas Server to the project's `.mcp.json` (replace `<abs path>` with
this repo's absolute path):

```json
{
  "mcpServers": {
    "visual-chat": {
      "command": "node",
      "args": ["<abs path>/dist/server/index.js"]
    }
  }
}
```

Restart Claude Code in the workspace. The server exposes the tools
`publish_artifact`, `update_artifact`, `check_askbacks`, `open_canvas`, and
`rotate_token`. Workspace state (capability token, artifacts, ask-back queue)
lives under `~/.visual-chat/<workspaceId>/` (0700 dirs, 0600 files).

The canvas URL carries the per-workspace capability token
(`http://127.0.0.1:<port>/?token=…`). Every browser-facing endpoint requires
it; treat the URL like a credential and use `rotate_token` if it leaks.

## Optional: the Claude Code ask-back hook (seamless delivery)

The portable loop works everywhere: the agent calls `check_askbacks` at the
start of a turn and you nudge the terminal to trigger it. On Claude Code, an
optional `UserPromptSubmit` hook removes that ritual — pending canvas ask-backs
are auto-appended to whatever you type next, so the agent sees them without
being told to check.

Build first (`bun run build` emits `dist/hooks/askback-hook.js`), then add to
your Claude Code `settings.json` (`~/.claude/settings.json`, or the project's
`.claude/settings.json`; replace `<abs path>` with this repo's absolute path):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <abs path>/dist/hooks/askback-hook.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The hook derives the workspace from its working directory (the same hash the
server uses), reads `~/.visual-chat/<id>/{port,token}`, and does a **read-only**
peek at `GET /api/askbacks/pending` (300ms timeout). It never marks anything
delivered — only `check_askbacks` does — so it can run on every prompt without
racing the tool or losing a queued ask-back. If the server is not running, the
state files are missing, or the request times out, the hook exits 0 with no
output and your prompt is untouched.

**Verify (manual):** with the hook installed and the server running, select
text on the canvas and ask a question, then type *anything* in Claude Code
(e.g. "ok"). The agent should answer the canvas ask-back — citing the quoted
anchor — without you telling it to check.

**Uninstall:** delete the `UserPromptSubmit` block above from `settings.json`.
Nothing else is installed — no daemon, no global state — and the portable
`check_askbacks` loop keeps working without it.

## Legibility gate: report vs. enforce (human-only switch)

The Legibility Gate ships **report-only**: it records coordinate findings next
to every free-form SVG version but never blocks or alters a publish. Arming
enforcement is a one-way trust decision you make **by hand** — there is no MCP
tool to change it, so the agent can neither grant itself enforcement nor remove
it (ADR-0007: calibrate before you enforce).

To arm it, first review calibration precision (open `/calibration?token=…` on
the canvas, or `GET /api/calibration`) and satisfy yourself the checks are
trustworthy. Then edit `~/.visual-chat/<workspaceId>/config.json`:

```json
{ "gate": "enforce" }
```

The mode is read once at startup, so **restart the server** to apply the change.
Anything other than an explicit `"enforce"` (missing file, malformed, unknown
value) stays in the safe `report` default. Delete the key or set `"report"` to
disarm.

Under `enforce`, a free-form SVG that trips the gate is **not stored**. The tool
returns the verbatim coordinate findings and a `repair_token`; the agent gets
ONE bounded repair round (fix only the flagged geometry and resubmit with the
token). A second failure in that context is published as an **honest-absence**
artifact ("Failed the legibility gate twice" + the findings summary) rather than
rendered — a first-class outcome, not an error. A gate *crash* never blocks or
converts anything; enforcement acts on real findings only. Repair contexts are
persisted (they survive a restart) and expire after one hour.

## Agent guidance (add to the host project's AGENTS.md / CLAUDE.md)

```markdown
## Visual Chat

A companion canvas is available via the visual-chat MCP tools. The terminal
stays the conversation driver; the canvas renders artifacts.

- Call `check_askbacks` at the START of every turn. It returns questions the
  human anchored to specific artifacts, versions, and text spans — answer
  them with the anchor's context, and prefer updating the same artifact.
- Publish an artifact (`publish_artifact`) when structure beats prose:
  design notes, comparisons, tabular data, multi-section explanations.
  Answer in plain text when a sentence or two suffices.
- Update artifacts in place (`update_artifact`) rather than republishing:
  the artifact keeps its identity and readers keep version history.
- Honest absence: if you cannot render something truthfully (too large,
  not enough data, would require guessing), publish `type: "absence"` with
  the reason. Never fabricate a visual.
- Bound large inputs: render a truthful subset and say so in the artifact
  itself ("showing 20 of 5,471"), or decline with an absence artifact.
```

## Manual walkthrough checklist (issue 06, criteria 2–3)

Perform once in a fresh Claude Code session after registering:

- [ ] Start Claude Code in a workspace whose `.mcp.json` registers
      visual-chat as above; confirm the `visual-chat` server shows as
      connected (`/mcp`).
- [ ] Ask the agent: "publish a short design note to the canvas".
- [ ] Confirm the browser opens (first publish auto-opens unless
      `VISUAL_CHAT_NO_OPEN=1`) and the document renders at the tokened URL
      with title, blocks, `document` badge, and `v1` chip.
- [ ] Ask the agent to revise the note; confirm the open page live-updates
      to `v2` without reload, and the ‹ scrubber shows v1 with a
      "viewing v1 of 2" marker.
- [ ] In the browser, select a sentence in a paragraph → "Ask about this"
      pill → type a question → Enter → "sent — reaches the agent next
      turn ✓".
- [ ] Back in the terminal, nudge the agent (any message, e.g. "anything
      from the canvas?"); confirm it calls `check_askbacks` and answers the
      question, citing the quoted anchor.
- [ ] Ask again; confirm the agent reports no pending questions (delivery
      marked).

## Scripted demo (no Claude Code needed)

```sh
bun run build
bun scripts/demo.ts
```

Publishes a six-block document, updates it to v2, prints the canvas URL,
then polls `check_askbacks` every 2s and prints anything you submit from the
browser. Exits 0 on Ctrl+C or after the poll window
(`VISUAL_CHAT_DEMO_TIMEOUT_MS`, default 120000). Set `VISUAL_CHAT_NO_OPEN=1`
to keep it from opening a browser.
