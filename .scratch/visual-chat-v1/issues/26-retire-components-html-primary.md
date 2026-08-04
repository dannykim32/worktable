# 26 — Retire the structured components; the HTML hatch is the surface

Status: ready-for-agent
Type: refactor (large deletion)
Milestone: M8

## Why (evidence, owner-decided 2026-08-04)

Dogfooding proved our structured components lose to the model's native artifact
quality. Given the same ask, our canvas got a `type:"document"` wall of headings
(0 diagrams); the native Claude artifact produced rich hand-crafted **HTML+CSS**
flowcharts. Crucially those native visuals are **self-contained HTML+CSS** — no
JS, no external libs, no runtime SVG — so they render perfectly in the html hatch
we already built (issue 25). Our value is **local hosting + ask-back**, NOT a
visualization vocabulary. So: retire the components, make the hatch the surface,
and have the agent author at native artifact-design quality (wired separately).

Owner ruling: "Html-primary AND retire components" + "the html hatch + prose +
absence become the whole surface."

## Target surface

`publish_artifact` / `update_artifact` accept exactly three types:
- **html** (issue 25) — the primary path: self-contained, sandboxed, ask-backable.
- **prose** (issue 24) — a long markdown answer via the safe markdown→DOM renderer.
- **absence** — Honest Absence (first-class refusal).

Everything else is removed.

## Remove (delete, don't deprecate — no sunk-cost, git preserves history)

- Types + canvas components: `document`, `dashboard`, `compare`, `svg` →
  `src/canvas/components/{document,dashboard,compare,svg}.ts`; update `registry.ts`.
- `src/sanitizer/` (whole dir) — svg-only boundary; the hatch serves verbatim
  under iframe isolation, so it is dead.
- `src/gate/` (whole dir) — the legibility gate was svg-geometry only.
- `src/server/calibration.ts` + the `/api/calibration*` routes + any calibration
  canvas page/gallery.
- `src/server/repair.ts` + the repair-token flow (svg gate repair round only).
- `src/server/config.ts` gate-mode machinery (`resolveGateMode`/`shouldEnforce`/
  `writeGateSetting`/settings route) + the canvas gate gear-panel — the gate is
  gone, so the mode setting is moot. (If config.ts holds anything NON-gate that
  something still needs, keep only that; otherwise delete the file.)
- `validate.ts`: the flat schema's `blocks`/`tiles`/`charts`/`panes`/`svg`/
  `repair_token` fields; `blockSchemas`/`tileSchema`/`chartSchema`/`paneSchema`;
  the `document`/`dashboard`/`compare`/`svg` validator cases. The `type` enum
  becomes `["html","prose","absence"]`.
- The svg publish path in `index.ts` (`prepareContent`'s sanitize+gate+repair
  logic collapses — html/prose/absence need no sanitization pass) and the svg
  branch of `update_artifact`.
- Tests + fixtures for all of the above: `document-renderer`, `dashboard-renderer`,
  `compare-renderer`, `svg-artifact*`, `svg-sanitizer`, `legibility-gate*`,
  `gate-enforcement*`, calibration/repair tests, sanitizer hostile/fuzz fixtures.

## Keep (must stay green)

Server + MCP (stdio), HTTP + capability URL, **frame server + `frameGuard`** (the
hatch's boundary), ask-back queue + hook + `request_review`, SSE, workspace,
inline reply threads, the canvas shell, the html hatch (issue 25), prose (issue
24), absence, the Slate theme. The 7 tools stay (html/prose/absence are the
`publish_artifact` surface now).

## Acceptance criteria

- [ ] `publish_artifact` inputSchema `type` enum is exactly `["html","prose","absence"]`
      and exposes only `title`/`html`/`markdown`/`reason` content fields.
- [ ] `validateArtifactContent` accepts html/prose/absence and rejects every removed
      type with a clear error.
- [ ] `src/sanitizer/`, `src/gate/`, `calibration.ts`, `repair.ts`, the four retired
      components, and their tests/fixtures are gone; no dangling imports.
- [ ] `bun run build` (tsc + vite + hooks) and `bun run build:standalone` succeed;
      `bun test` green; the release publish-smoke (html/prose) passes.
- [ ] The canvas loads and renders an html and a prose artifact; ask-back works on
      both; no references to the removed calibration/gate UI remain.
- [ ] No dead code left behind (unused imports/consts/constants like SVG_MAX,
      gate/calibration constants — remove them too).

## Out of scope (follow-ups, do NOT do here)

- Wiring the artifact-design skill into the html path + the guidance/doctrine
  overhaul (separate step).
- ADR + README updates (the coordinator does these at merge). Note in your report
  which ADRs are now superseded (0002 exception is now the norm; the gate/
  calibration ADRs 0009/0011 and issue 09/10/11 are retired).
