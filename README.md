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

## Status (updated 2026-07-15)

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
- **Calibration round 2 (2026-07-15): PASSED — owner sign-off given.** The fixed
  sub-legible check flipped 0% → 100%; all four checks trustworthy. The 9px floor
  is confirmed well-placed. Evidence: `docs/qa/calibration-round-2.md`. This is the
  ADR-0007 gate — enforcement is now unblocked.
- **Next:** M5 enforcement + bounded repair round (in progress — enforce all four
  checks: fail → repair round → honest absence), then M6 Claude Code hook +
  request_review.
- **Deferred with labeled slots:** free-form HTML hatch (security model +
  pre-decisions already recorded — issue 15), structured Diagram component,
  native MCP Apps hosting, sketch aesthetic register.

## Run it

```sh
bun install && bun run build && bun test
bun scripts/demo.ts        # publishes a doc, prints the tokened canvas URL, polls ask-backs
```

Claude Code registration + manual walkthrough: `docs/setup.md`.

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
