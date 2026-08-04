# visual-chat (placeholder name)

A framework + MCP plugin that gives a terminal LLM agent a **local browser canvas**
for rich, honest visual artifacts — design docs, diagrams, dashboards, before/after
comparisons — with **selection-anchored ask-backs** flowing from the browser back
into the terminal conversation. The terminal stays the conversation driver; the
canvas is a companion, not a chat client (ADR-0001).

Cold-start for any agent or human: this file + the map below is everything you need.
**Standing rule: whoever merges to `main` updates the Status section below in the
same change.** This document must always let a fresh session resume without any
prior conversation context.

## Status (updated 2026-07-15) — v1 FEATURE-COMPLETE

Every issue in the v1 spec (01–14, 16) is built, two-axis reviewed, and merged to
`main`. Full loop works: agent publishes versioned artifacts (document / dashboard /
compare / SVG / honest-absence) to a capability-gated local canvas; the human sends
selection-anchored ask-backs home; the SVG legibility gate runs (report-only by
default, human-calibrated, opt-in enforcement); and Claude Code gets an ask-back
auto-inject hook plus an agent-opt-in `request_review` Review Moment. Deferred by
design: free-form HTML hatch (issue 15, security model pre-decided), structured
Diagram component, native MCP Apps hosting, sketch aesthetic register.

### Milestone history

- **M1 — walking skeleton: DONE, merged, human-verified.** MCP server (stdio) +
  capability-URL canvas on 127.0.0.1; versioned artifact store + SSE; Document +
  absence renderers; ask-back queue with anchors; demo + E2E.
- **M2 — Dashboard + Compare: DONE, merged, both review axes passed.** Single-axis
  bar/line + stat tiles; two-pane compare. Points capped at 200/series.
- **Visual identity: committed light-only** (owner direction) — vanilla ground,
  burnt orange as the lead/brand color, warm espresso ink, warm red reserved for
  bad-state (orange never means "bad"), data-series colors held out of the brand
  lane. No dark mode. Canvas theme lives in `src/canvas/styles.css`.
- **M3 — SVG sanitizer + image-isolated SVG type: DONE, merged, security review
  passed (no bypass found).** Zero-dep reject-not-drop sanitizer (16 hostile
  fixtures + 10k fuzz), SVG rendered only as inert `<img>` data: URL. The one
  ratified deviation: `url(#id)` same-document marker refs are permitted
  (validated, fragment-only) so arrow-headed diagrams render — issue 09 amended.
  160 tests green on main.
- **Security drill (2026-07-15): passed.** An owner-run cookie-exfil injection into
  the sanitizer worktree was contained at every layer, nothing merged. See
  `docs/security/red-team-drills.md`.
- **M4 — legibility gate (report-only) + calibration gallery: DONE, merged, both
  axes passed.** Four geometry checks (text-overlap, edge-straddle, clipped,
  sub-legible) over the sanitizer AST; findings stored per version; token-authed
  `/calibration` gallery for ruling findings correct/false-positive with live
  precision. Report-only is STRUCTURAL — the gate affects a publish neither by
  its findings nor by throwing (`runGateSafe` fail-open). 201 tests green.
- **Calibration round 1 (2026-07-15):** overlap/straddle/clipped scored 100%;
  sub-legible scored 0% (judged SVG-space font, not rendered px). Fixed in issue 16
  (merged) — sub-legible now judges on-screen px via the 836px card display scale.
  Evidence: `docs/qa/calibration-round-1.md`.
- **Calibration round 2 (2026-07-15): PASSED — owner sign-off given.** All four
  checks trustworthy; 9px floor confirmed. Evidence: `docs/qa/calibration-round-2.md`.
- **M5 — gate enforcement + bounded repair round: DONE, merged, both axes passed.**
  Enforcement is human-only (`config.json` `gate: report|enforce`, default report;
  NO MCP tool can change it), fail-open against gate crashes, fail → one repair
  round → honest absence. Also fixed a latent `listTools()` failure (bare-oneOf
  inputSchema) that blocked spec-compliant MCP hosts since M1. 224 tests green.
- **To turn enforcement on:** edit `~/.visual-chat/<workspaceId>/config.json` to
  `{"gate":"enforce"}` and restart the server (per `docs/setup.md`). Off by default.
- **M6 — Claude Code hook + `request_review`: DONE, merged, both axes passed.**
  `UserPromptSubmit` hook auto-injects pending ask-backs (via a read-only peek route
  that never drains the queue); `request_review` is an agent-opt-in blocking Review
  Moment (long-poll, canvas banner + approve button, approvals travel as ask-backs
  per ADR-0010). 235 tests green.
- **Dogfooded (2026-07-15):** a real Claude Code session (server registered via
  `.mcp.json`) published a design doc, a dashboard, and an SVG architecture diagram;
  ask-backs landed anchored to the exact selection; the gate + calibration gallery
  ran live. Concept proven end-to-end.

## ▶ RESUME HERE (next session)

**v1 complete, and extended.** 315 tests green on `main` (also pushed to the private
GitHub remote `dannykim32/visual-chat`, release v0.1.0 has a firewall-friendly
self-contained tarball). The build history is in the milestone log below; the current
capability surface:

- Artifacts: document, dashboard, compare, SVG (sanitized + image-isolated + legibility
  gated), honest-absence, and **prose/markdown** (issue 24 — the agent renders a long
  answer as a safe rich webpage; own-built zero-dep markdown→DOM renderer, no HTML hole).
- Ask-back loop closes in the browser: select a section → question home to the terminal
  → the agent's reply threads inline (issue 22).
- Gate mode is a live human setting via a canvas gear panel (issue 20); all four
  legibility checks human-calibrated (round 6).
- Warm visual identity settled (issue 23); installs behind a firewall (issue 21).

**Open — the owner's, none are code:**
- **Flip enforce (or not)** — a click in the canvas gear panel (issue 20).
- **Name the project** — still the "visual-chat" placeholder.
- **Dogfood** — install into a real work repo per `docs/install.md` and use it.

**Known follow-ups (non-blocking):** prose relative/in-page-anchor links render as
literal text (issue 24 comments — allowing safe `#fragment` links is a clean win);
prose deep-blockquote depth cap (hardening). **Deferred, labeled:** free-form HTML
hatch for animations/interactivity (issue 15, security pre-decided — the "add motion"
decision), structured Diagram component, native MCP Apps hosting, sketch register.

## Run it

```sh
bun install && bun run build && bun test
bun scripts/demo.ts        # publishes a doc, prints the tokened canvas URL, polls ask-backs
```

Claude Code registration + manual walkthrough: `docs/setup.md`.
Firewalled / no-npm install (self-contained bundle + network-free register
helper): `docs/install.md`.

## Map of record (read in this order when coming in cold)

| Where | What |
|-------|------|
| `CONTEXT.md` | The domain glossary — use these exact terms in code, tests, prose |
| `docs/adr/0001–0010` | Every architectural decision, with the why and the rejected alternatives |
| `.scratch/visual-chat-v1/` | The tracker: PRD (epic, dependency graph) + numbered issues with pass/fail acceptance criteria |
| `docs/agents/` | Issue-tracker conventions, triage labels, domain-doc consumer rules |
| `docs/research/` | Landscape survey (niche analysis) + safe-HTML-rendering research (informs the deferred hatch) |
| `AGENTS.md` | Working conventions + how agents should use the canvas itself |
| `prototype/canvas-vocabulary/` | The judged prototype — reference rendering for components |

## Design philosophy (the owner's, distilled — binding)

- **Truth doctrine.** An artifact may abstract, but may never tell an untrue story.
  Honest absence is a first-class outcome: decline with a reason, never fabricate.
  Scale is a wall: bound the work and degrade visibly ("showing N of M"), never
  silently truncate.
- **Security is structural, not filtered.** Model output is untrusted. Prefer
  impossible-by-construction (image isolation, schema-validated structured intent)
  over sanitize-and-hope. Reject-not-drop: a stripped artifact can lie. One
  authenticated write channel (the ask-back queue) — ADR-0010.
- **Evidence over guessing.** Prototype before deciding; calibrate before
  enforcing; research before building. Gates gain power only after a human rules
  on real output.
- **Best-version engineering.** Optimize for the best long-term design, not for
  preserving effort already spent — no sunk-cost bias. Aggressive simplicity:
  fewer, denser artifacts beat complete ones.

## Implementation preferences (binding defaults)

- TypeScript + official `@modelcontextprotocol/sdk`, Node 20+, bun for dev/test.
- Canvas: vanilla TS + Vite; components are pure render functions behind the
  `ComponentRenderer` seam (a dedicated visual library may replace internals
  later — the seam is the contract).
- Model-influenced strings render via `textContent`/`createElement` only.
- Zero runtime dependencies in security modules (`src/sanitizer/`, gate); new
  dependencies anywhere require written justification — default no.
- Security invariants are test-enforced (perms via fs.stat, 401/403 over real
  HTTP, XSS canaries), not aspirational.
- Server logs to stderr only (stdout is the MCP transport).
- Placeholder name; `"private": true`; never publish to npm; never push or merge
  without the owner's say-so.
- Commits: one per issue/logical fix, `feat(NN):`/`fix(review):` style, ending
  ``.
