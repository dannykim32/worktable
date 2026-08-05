# Purview

Purview gives your terminal coding agent a local browser canvas. Instead of
describing an architecture change or a bug fix in a wall of text, the agent draws it
as a page you can open, read, and point at - and when you select something and ask
about it, the question lands back in the terminal conversation.

## Why

When a coding agent explains a big change - a new module boundary, a refactor, why a
bug happened - it usually hands you a mountain of text. You have two options: trust
it, or grind through the whole thing to check it. Neither is great. I kept hitting
this myself: the model clearly understood the change, but I couldn't *see* it, so I
couldn't audit it without re-reading everything.

A picture fixes that. Give me a diagram of the call path, a before/after of the
module graph, a flowchart of the failure, and I understand in seconds what a page of
prose was trying to say - and I can spot the part that's wrong.

Purview's whole job is to make that the default. It nudges the model to render its
work locally, honestly, and in a form you can interrogate. You shouldn't have to
trust the wall of text - you should be able to look at it.

The value isn't a chart library. It's the loop: a local canvas plus a way to point
at any part of it and ask.

## What it looks like

The agent publishes an artifact and the canvas opens on `127.0.0.1`. Select any
region - a box in a diagram, a line of a plan, a cell in a table - and an "Ask about
this" pill hands off to a side drawer where you type the question. It travels home to
the terminal anchored to exactly what you selected, and the agent's answer fills in
next to your question. It works from inside a model-drawn HTML page too, not just
plain prose.

## Quickstart

Requires [Bun](https://bun.sh) for dev and Node 20+ to run.

```sh
bun install
bun run build
bun test          # ~154 tests
```

Register the canvas with Claude Code for every session:

```sh
./install.sh
```

To also wire a specific project so the agent uses the canvas proactively (drops in a
guidance snippet + the ask-back hook):

```sh
./install.sh /path/to/your/repo
```

Restart Claude Code, run `/mcp`, and `purview` should show connected. Then ask the
agent to show you something - "walk me through this architecture on the canvas."

Firewalled machine with no npm access? `docs/install.md` covers the self-contained
bundle and a network-free registration helper.

## How it works

```
Terminal agent  ──MCP (stdio)──▶  Canvas Server  ──127.0.0.1──▶  Browser canvas
 (Claude Code)                    (this project)                  (you read + select)
      ▲                                                                  │
      └──────────────  ask-back, anchored to your selection  ◀───────────┘
```

The terminal stays the driver; the canvas is a companion, not a chat client. The
agent publishes versioned **artifacts** to a capability-gated local server, which
serves them to the browser. Your selection-anchored questions - **ask-backs** - flow
back into the conversation.

There are exactly three artifact types, on purpose:

- **`html`** - the primary type. A self-contained, model-authored HTML/CSS/SVG page:
  bespoke layout, real diagrams, whatever the content needs. The model writes it with
  the same design process it uses for native artifacts.
- **`prose`** - a long markdown answer, for substance that reads better as text.
- **`absence`** - honest absence. When the model can't render something truthfully,
  it declines and says why instead of faking a picture. A first-class outcome, not an
  error.

## Security

Model-authored HTML is untrusted input, so Purview never trusts it into the page. An
`html` artifact is served verbatim from a *second* `127.0.0.1` origin into an iframe
that is `sandbox="allow-scripts"` and never `allow-same-origin`, under a
header-delivered CSP whose `script-src` is a per-response nonce the model never sees.
The model's own `<script>` and `onclick` have no nonce, so they never run - script
execution is impossible by construction, not by filtering. The capability token lives
only in the parent origin and never enters the frame.

Anything that could phone home without a click - `<meta http-equiv>`, an external
`<link>` - is rejected at ingest by a zero-dependency guard that **rejects the whole
artifact rather than silently stripping it**, because a stripped artifact can tell a
different story than the one you reviewed. That boundary is backed by 80+ adversarial
test fixtures. See `docs/adr/` for the reasoning and `src/server/frameGuard.ts` for
the code.

Live model JavaScript (Tier 2) is deliberately deferred - the static surface is what
ships today, and it's labeled as such.

## Layout

| Where | What |
|-------|------|
| `CONTEXT.md` | The domain glossary - the exact terms used in code and docs |
| `docs/adr/` | Every architectural decision, with the why and the rejected alternatives |
| `docs/STATUS.md` | Current status, milestone history, and open follow-ups |
| `src/server/` | The Canvas Server (MCP) - artifact store, canvas HTTP, the frame-isolation boundary |
| `src/canvas/` | The browser canvas - renderers, gallery, ask-back drawer |
| `hooks/` | The Claude Code `UserPromptSubmit` hook that delivers queued ask-backs |
| `docs/history/` | The original PRD, issue tracker, and QA evidence, kept for the record |

## Status

`{html, prose, absence}` is the surface; the full loop works end to end. For the
running log, milestone history, and known follow-ups, see
[`docs/STATUS.md`](docs/STATUS.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for build, test, and the ADR convention.

## License

MIT - see [`LICENSE`](LICENSE).
