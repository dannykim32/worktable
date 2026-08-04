# visual-chat

A framework + plugin that gives an LLM agent a local browser surface for rendering
rich, interactive, honest visual artifacts (design docs, flowcharts, diagrams,
dashboards) instead of plain terminal text.

**Cold start / context recovery: read `README.md` FIRST** — it is the always-current
project status, philosophy, and map of record. Standing rule: any merge to `main`
updates README.md's Status section in the same change.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo
(no remote tracker). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human,
wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.

## Visual Chat

A companion canvas is available via the visual-chat MCP tools (register per
`docs/setup.md`). The terminal stays the conversation driver; the canvas
renders artifacts.

- Call `check_askbacks` at the START of every turn. It returns questions the
  human anchored to specific artifacts, versions, and text spans — answer
  them with the anchor's context, and prefer updating the same artifact.
- Publish an artifact (`publish_artifact`) when structure beats prose:
  design notes, comparisons, tabular data, multi-section explanations.
  Answer in plain text when a sentence or two suffices.
- When a response would be a terminal wall (long or multi-section),
  publish it as `type: "prose"` (send your answer as `markdown`) and give a
  terse terminal pointer ("published to the canvas — read it there, ask about
  any section"), rather than dumping the full text. The canvas renders the
  markdown richly and any part is select-and-ask-able.
- Update artifacts in place (`update_artifact`) rather than republishing:
  the artifact keeps its identity and readers keep version history.
- Honest absence: if you cannot render something truthfully (too large, not
  enough data, would require guessing), publish `type: "absence"` with the
  reason. Never fabricate a visual.
- Bound large inputs: render a truthful subset and say so in the artifact
  itself ("showing 20 of 5,471"), or decline with an absence artifact.

### Design doctrine (how to make an artifact worth opening)

A page that is just the terminal wall in a browser has bought nothing. Before you
publish, make these decisions — they are what turn an analytical answer into
something worth the extra surface:

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
