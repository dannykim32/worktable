# Purview

A framework + plugin that gives a terminal coding agent a local browser canvas for
rendering rich, honest visual artifacts (architecture, diffs, flowcharts, diagrams)
instead of a wall of terminal text. The surface is exactly `{html, prose, absence}`.

**Cold start / context recovery: read `docs/STATUS.md` FIRST** — it holds the
always-current status, milestone history, and open follow-ups. `README.md` is the
public front door; `CONTEXT.md` is the glossary. Standing rule: any merge to `main`
updates the Status section in `docs/STATUS.md` in the same change.

## Agent skills

### Issue tracker

The v1 build's issue specs and PRD are archived under `docs/history/v1-tracker/`
(historical record); there's no active in-repo tracker. See
`docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human,
wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.

## Purview

A companion canvas is available via the purview MCP tools (register per
`docs/setup.md`). The terminal stays the conversation driver; the canvas
renders artifacts.

- Call `check_askbacks` at the START of every turn. It returns questions the
  human anchored to specific artifacts, versions, and text spans — answer
  them with the anchor's context, and prefer updating the same artifact.
- Publish an artifact (`publish_artifact`) whenever a response is worth designing —
  an explainer, a diagram or flowchart, a before/after, a dashboard, a walkthrough,
  a multi-section answer. Answer in plain text only when a sentence or two suffices.
  The surface is exactly three types: `html`, `prose`, `absence`.
- **`html` is the primary path.** Author the page the way you'd author a
  first-class artifact — run the **artifact-design** skill's full process
  (treatment → an explicit color/type/layout plan → semantic color →
  one-figure-one-claim diagrams in HTML/CSS or inline SVG → an anti-default pass) —
  but publish it HERE via `type: "html"`, **NOT** to the native Artifact tool /
  claude.ai artifacts. Only this canvas can be selected-and-asked-back on; that is
  the entire reason to use it. Two hard rules for this canvas:
  - **Self-contained.** Inline all CSS and SVG; embed assets as `data:` URIs; no
    external `<link>`/fonts/CDN and no `<meta http-equiv>`. The frame has no network.
  - **Static.** Your own `<script>` is neutralized — draw diagrams with HTML/CSS
    and inline SVG, not JS. (Live-JS interactivity is a deferred capability.)
  - **Fit the width.** The page must not clip. Scale inline SVG with a `viewBox` +
    `width:100%; height:auto` (never a hard-coded pixel width wider than the page);
    wrap or put `overflow-x:auto` on any table or diagram that could exceed the
    viewport. A diagram the reader can't fully see is worse than a sentence.
- `prose` (send `markdown`) for a long plain-text answer with no bespoke visual —
  the canvas renders it richly and select-and-ask-ably. `absence` (with a `reason`)
  to decline honestly instead of fabricating. Never fabricate a visual.
- If a publish is rejected, the error names exactly what to fix and nothing was
  stored: fix it (inline the external resource, drop the `<meta http-equiv>`) and
  re-publish HERE. Never fall back to a different rendering surface — that drops the
  ask-back loop.
- Update artifacts in place (`update_artifact`) rather than republishing: the
  artifact keeps its identity and readers keep version history.
- Bound large inputs: render a truthful subset and say so in the artifact itself
  ("showing 20 of 5,471"), or decline with an absence artifact.

### Design doctrine (the artifact-design essentials, baked in)

Prefer the full **artifact-design** skill when it's available; these are its core
moves, kept here so quality travels even where the skill isn't installed. A page
that is just the terminal wall in a browser has bought nothing. Before you publish
an `html` artifact, make these decisions:

1. **Decide the treatment first.** Is this a *document* (read top-to-bottom —
   craft goes into typography and spacing) or a *decision surface* (scanned and
   operated — summary before detail, state encoded in the form)? The job picks
   the shape. An over-designed memo reads as untrustworthy; a flashy visual
   identity is sometimes wrong, a well-composed page never is.
2. **Lead with the claim.** The heading and first line carry the point, compressed
   to headline level — a page needs more compression than a terminal dump, not
   less. Never open on a runway.
3. **Make color semantic, not decorative.** If you use accent color, let it carry
   an argument (this category vs that one, this state vs that one) so a reader
   learns the taxonomy from the hues before reading a word. A color that just
   decorates is noise.
4. **Promote monospace to first-class.** Every literal a reader could look up — a
   file path, an identifier, a status code, a field name, a citation — goes in
   `code`. It signals "this is a real thing you can go find," and does more work
   than another font would.
5. **A diagram must earn its place.** Draw one ONLY when it lets a cold reader see
   a mechanism they'd otherwise assemble from prose — **one figure, one claim**,
   and *if a sentence says it faster, write the sentence*. The common failure is
   over-drawing: never inventory a whole system as boxes, and comparing options
   means drawing the *difference*, not restating a list as rectangles.
6. **Run an anti-default pass.** AI-authored pages cluster. Revise anything that
   matches the templated look: warm-cream + serif + terracotta, a purple→blue
   gradient hero, everything centered, `rounded-lg` on every card, emoji as
   section markers. If the human specified a direction, follow it exactly — their
   words always win. Where nothing is specified, don't spend the freedom on a
   default.
