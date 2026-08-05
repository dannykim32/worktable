# Purview — setup and walking-skeleton walkthrough

## Build

```sh
bun install
bun run build     # tsc (server + canvas typecheck) + vite build → dist/
bun test          # full suite, loopback only
```

> **Firewalled / no-npm machine?** This page is the dev path (needs
> `node_modules`). To install where npm/npx/`bun install` are unreachable, build a
> self-contained bundle (`bun run build:standalone`) and register it with the
> network-free helper (`node scripts/register.mjs`). Full walkthrough:
> [install.md](./install.md).

## Register in Claude Code

Add the Canvas Server to the project's `.mcp.json` (replace `<abs path>` with
this repo's absolute path):

```json
{
  "mcpServers": {
    "purview": {
      "command": "node",
      "args": ["<abs path>/dist/server/index.js"]
    }
  }
}
```

Restart Claude Code in the workspace. The server exposes the tools
`publish_artifact`, `update_artifact`, `check_askbacks`, `request_review`,
`open_canvas`, and `rotate_token`. Workspace state (capability token, artifacts,
ask-back queue) lives under `~/.purview/<workspaceId>/` (0700 dirs, 0600
files).

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
server uses), reads `~/.purview/<id>/{port,token}`, and does a **read-only**
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

## Optional: request_review (blocking Review Moment)

`request_review({ artifact_id, timeout_s? })` lets the agent deliberately block
awaiting your feedback on one artifact (timeout clamped to 30–600s, default
180). The canvas shows a banner on that artifact — "agent is waiting for your
review" with a **Looks good — continue** button. Clicking approve, or sending an
anchored ask-back on that artifact, resolves the wait; the approval travels as
an ordinary `kind:"approval"` ask-back (ADR-0010 — no new channel). On timeout
the call returns `{ timed_out: true }` (a normal result, not an error) and any
feedback you send later still arrives via `check_askbacks`. Pressing **Esc** in
the terminal interrupts the call safely — the queue keeps your feedback.

## Agent guidance (add to the host project's AGENTS.md / CLAUDE.md)

The canonical, marker-wrapped copy lives in [agent-guidance.md](./agent-guidance.md)
(what `register.mjs --guidance` appends). Reproduced here for convenience:

```markdown
## Purview

A companion canvas is available via the purview MCP tools. The terminal
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
      purview as above; confirm the `purview` server shows as
      connected (`/mcp`).
- [ ] Ask the agent: "walk me through this on the canvas" (or "publish a short
      explainer"). It publishes an `html` or `prose` artifact.
- [ ] Confirm the browser opens (first publish auto-opens unless
      `PURVIEW_NO_OPEN=1`) and the artifact renders at the tokened URL with its
      title and a `v1` chip.
- [ ] Ask the agent to revise it; confirm the open page live-updates to `v2`
      without reload, and the ‹ scrubber shows v1 with a "viewing v1 of 2"
      marker.
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

Publishes a prose artifact, updates it to v2, prints the canvas URL,
then polls `check_askbacks` every 2s and prints anything you submit from the
browser. Exits 0 on Ctrl+C or after the poll window
(`PURVIEW_DEMO_TIMEOUT_MS`, default 120000). Set `PURVIEW_NO_OPEN=1`
to keep it from opening a browser.
