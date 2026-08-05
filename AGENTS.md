# Worktable

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

## Worktable

The canonical copy of this block is `docs/agent-guidance.md` (what
`register.mjs --guidance` installs into target repos); when you change one, change
both. In this repo the listener path is simply `dist/hooks/await-askback.js`.

A companion canvas is available via the worktable MCP tools (register per
`docs/setup.md`). The terminal stays the conversation driver; the canvas renders
artifacts the human reads, selects, and asks about.

**Default to the canvas for anything structural.** If an answer explains how
something works or what changed — an architecture, a code walkthrough, a bug
postmortem, a plan, a comparison, anything that would have two or more sections —
publish it as an artifact and leave a terse terminal pointer ("published to the
canvas — ask about any part"). Answer in plain terminal text only when a sentence
or two suffices. A visual the human can interrogate beats a wall of text they
have to trust.

- Call `check_askbacks` at the START of every turn. It returns questions the
  human anchored to specific artifacts, versions, and text spans — answer
  them with the anchor's context, and prefer updating the same artifact.
- **Arm the listener after every publish**, so canvas questions reach you without
  the human touching the terminal: run `node dist/hooks/await-askback.js` as a
  BACKGROUND Bash job — never foreground; one arming listens for ~45 minutes.
  When it completes reporting questions, call `check_askbacks`, answer, then
  re-arm. When its budget ends quietly, DEFAULT TO RE-ARMING while the canvas is
  still the active surface (an artifact awaiting the human's decisions counts);
  only let it rest once the conversation has clearly moved on.
- After answering an ask-back, also call `answer_askback` with its `askback_id` —
  your reply then appears in the canvas drawer, threaded under the exact
  selection. **Format that answer as compact markdown** (short bullets over
  paragraphs, `code` for literals): it renders formatted in a narrow column.
- **Link your references.** When you cite a ticket, PR, doc, or any web page,
  make it a real link (absolute `https://` URL — markdown links in `prose`,
  `<a href>` in `html`). They open safely in a new tab; a reference the human
  can't follow is half a reference. Relative links don't resolve on the canvas —
  use absolute URLs or plain `code` paths.
- **`html` is the primary path.** Author the page the way you'd author a
  first-class artifact — run the **artifact-design** skill's full process
  (treatment → an explicit color/type/layout plan → semantic color →
  one-figure-one-claim diagrams in HTML/CSS or inline SVG → an anti-default pass) —
  but publish it HERE via `type: "html"`, **NOT** to the native Artifact tool /
  claude.ai artifacts. Only this canvas can be selected-and-asked-back on; that is
  the entire reason to use it. Three hard rules for this canvas:
  - **Self-contained.** Inline all CSS and SVG; embed assets as `data:` URIs; no
    external `<link>`/fonts/CDN and no `<meta http-equiv>`. The frame has no network.
  - **Static.** Your own `<script>` is neutralized — draw diagrams with HTML/CSS
    and inline SVG, not JS. (Live-JS interactivity is a deferred capability.)
  - **Fit the width.** The page must not clip. Scale inline SVG with a `viewBox` +
    `width:100%; height:auto` (never a hard-coded pixel width wider than the page);
    wrap or put `overflow-x:auto` on any table or diagram that could exceed the
    viewport. A diagram the reader can't fully see is worse than a sentence.
- **Glossary, sparingly.** If the artifact leans on a term you coined or one that
  was never agreed on with the human, add a compact "Terms" section NEAR
  THE TOP — right after the lead, so the reader has the vocabulary before
  they need it, never buried at the end. One line per term, ONLY the few the
  reader genuinely needs; skip anything obvious — the reader can select any
  phrase and ask.
- `prose` (send `markdown`) for a long plain-text answer with no bespoke visual —
  the canvas renders it richly and select-and-ask-ably. `absence` (with a `reason`)
  to decline honestly instead of fabricating. Never fabricate a visual.
- If a publish is rejected, the error names exactly what to fix and nothing was
  stored: fix it (inline the external resource, drop the `<meta http-equiv>`) and
  re-publish HERE. Never fall back to a different rendering surface — that drops the
  ask-back loop.
- **One topic, one artifact.** The canvas persists across sessions: call
  `list_artifacts` before your first publish of a session, and if an artifact
  already covers the topic, revise it with `update_artifact` (readers keep
  version history) instead of publishing a near-duplicate card. Publish new
  only for a genuinely new topic, or when the human asks for a fresh doc.
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
