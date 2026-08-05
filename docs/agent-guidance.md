# Agent guidance snippet

Drop the block below into any repo's `AGENTS.md` or `CLAUDE.md` to make the agent
use the worktable canvas proactively. `scripts/register.mjs --guidance` appends
exactly this block — substituting `<abs-path-to-worktable>` with the install's real
path — and the `<!-- worktable-guidance -->` marker comments let it detect an
existing copy and stay idempotent (do not remove or edit the markers). If you paste
it by hand, replace `<abs-path-to-worktable>` yourself.

This file is the canonical copy. `AGENTS.md` in this repo carries the same block
(this project dogfoods its own canvas); when you change one, change both.

Everything between the markers (inclusive) is the copy-paste payload:

<!-- worktable-guidance -->
## Worktable

A companion canvas is available via the worktable MCP tools. The terminal stays
the conversation driver; the canvas renders artifacts the human reads, selects,
and asks about.

**Default to the canvas for anything structural.** If an answer explains how
something works or what changed — an architecture, a code walkthrough, a bug
postmortem, a plan, a comparison, anything that would have two or more sections —
publish it as an artifact and leave a terse terminal pointer ("published to the
canvas — ask about any part"). Answer in plain terminal text only when a sentence
or two suffices. A visual the human can interrogate beats a wall of text they
have to trust.

- Call `check_askbacks` at the START of every turn. It returns questions the human
  anchored to specific artifacts, versions, and text spans — answer them with the
  anchor's context, and prefer updating the same artifact. (With the Claude Code
  hook installed, pending questions are auto-appended to your prompt; the
  `check_askbacks` call is still what marks them delivered.)
- **Arm the listener after every publish**, so canvas questions reach you without
  the human touching the terminal: run
  `node <abs-path-to-worktable>/dist/hooks/await-askback.js`
  as a BACKGROUND Bash job — never foreground; it waits up to four minutes. When
  it completes reporting questions, call `check_askbacks`, answer, then re-arm.
  When it completes on a quiet timeout, re-arm if the human is still reading the
  canvas; otherwise let it rest.
- After answering an ask-back, also call `answer_askback` with its `askback_id` —
  your reply then appears in the canvas drawer, threaded under the exact selection,
  so the loop closes where the human asked.
- **`html` is the primary type.** Author the page as a first-class artifact — pick
  the treatment, plan color/type/layout, use color semantically, draw
  one-figure-one-claim diagrams in HTML/CSS or inline SVG, then pass over anything
  that looks templated — and publish it HERE via `type: "html"`, never to the
  native Artifact tool: only this canvas can be selected-and-asked-back on. Three
  hard rules:
  - **Self-contained.** Inline all CSS and SVG; embed assets as `data:` URIs; no
    external `<link>`/fonts/CDN and no `<meta http-equiv>`. The frame has no
    network.
  - **Static.** Your own `<script>` is neutralized — draw with HTML/CSS and inline
    SVG, not JS.
  - **Fit the width.** Scale inline SVG with `viewBox` + `width:100%;height:auto`;
    give wide tables/diagrams `overflow-x:auto`. A clipped diagram is worse than a
    sentence.
- **Glossary, sparingly.** If the artifact leans on a term you coined or one that
  was never agreed on with the human, add a compact "Terms" section: one line per
  term, ONLY the few the reader genuinely needs. Skip anything obvious — the
  reader can select any phrase and ask.
- `prose` (send `markdown`) for a long text answer with no bespoke visual — the
  canvas renders it richly and every part is select-and-askable. `absence` (with a
  `reason`) to decline honestly instead of fabricating. Never fabricate a visual.
- Update artifacts in place (`update_artifact`) rather than republishing: the
  artifact keeps its identity and readers keep version history.
- Bound large inputs: render a truthful subset and say so in the artifact itself
  ("showing 20 of 5,471"), or decline with an absence artifact.
- If a publish is rejected, the error names exactly what to fix and nothing was
  stored: fix it and re-publish HERE. Never fall back to a different rendering
  surface — that drops the ask-back loop.
<!-- /worktable-guidance -->
