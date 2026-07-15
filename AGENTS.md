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
- Update artifacts in place (`update_artifact`) rather than republishing:
  the artifact keeps its identity and readers keep version history.
- Honest absence: if you cannot render something truthfully (too large, not
  enough data, would require guessing), publish `type: "absence"` with the
  reason. Never fabricate a visual.
- Bound large inputs: render a truthful subset and say so in the artifact
  itself ("showing 20 of 5,471"), or decline with an absence artifact.
