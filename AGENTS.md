# visual-chat

A framework + plugin that gives an LLM agent a local browser surface for rendering
rich, interactive, honest visual artifacts (design docs, flowcharts, diagrams,
dashboards) instead of plain terminal text.

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
