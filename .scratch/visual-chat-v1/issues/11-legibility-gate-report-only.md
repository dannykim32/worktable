# 11 — Legibility gate, report-only + calibration gallery

Status: done
Type: task
Milestone: M4
Blocked by: 10

## Context

ADR-0007: SVG-owns-diagrams is CONTINGENT on this gate. CONTEXT.md: Legibility Gate
judges readability only, never truth. Doctrine: evidence before power — the gate ships
report-only and gains enforcement (issue 12) only after human calibration.

## Implementation Details

`src/gate/` (zero-dep, consumes the sanitizer's AST — export the AST type from 09).

**Geometry model:** text bbox estimated per `text`/`tspan`: width = charCount ×
fontSize × 0.6 (monospace-ish upper bound), height = fontSize × 1.2, positioned by
x/y/text-anchor; shapes from their geometry attrs; transforms applied (translate/
scale/rotate on points).

**Checks (each returns coordinate-bearing findings):**
- `text-overlap`: two text bboxes intersect >15% of the smaller's area
- `edge-straddle`: text bbox crosses a shape boundary it isn't fully inside/outside
  (tolerance 2px)
- `clipped`: any element's bbox exceeds the viewBox
- `sub-legible`: font-size <9 at rendered scale

Finding shape: `{ check, elements: [id/path], bbox: {x,y,w,h}, message }` — precise
enough to hand straight back to a model for repair (issue 12).

**Wiring:** on svg publish/update, run gate, store findings alongside the version
(`v<N>.findings.json`). REPORT-ONLY: never blocks, never alters the artifact.

**Calibration gallery:** authed route `/calibration` — every svg version, rendered,
findings overlaid as outline boxes, and per-finding ruling buttons (correct /
false-positive) POSTing to `/api/calibration` → `<dir>/calibration.jsonl`. A summary
header shows precision so far per check.

## Acceptance Criteria

1. Fixture suite: ≥8 known-bad SVGs (overlapping labels, straddling text, clipped
   node, 6px text) each produce the expected finding with coords within ±5px; ≥5
   known-good produce zero findings.
2. Findings stored per version; updating an artifact re-runs the gate.
3. Publish of a finding-laden SVG still succeeds and renders (report-only proven).
4. Calibration rulings persist and the precision summary reflects them.
5. Gate module has zero runtime deps and no DOM usage (pure geometry).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | bbox math incl. transforms + anchors, each check | +10 |
| Fixtures | bad/good suites | +13 |

## Effort

~8h: 3h geometry, 2h checks, 2h calibration gallery, 1h tests.

## Out of Scope

Enforcement/repair (12), truth/fidelity checking (doctrine: never a truth gate),
pixel-perfect text metrics (heuristic model is the v1 contract).

## Comments

Done. `src/gate/` is a zero-dependency, DOM-free geometry module that CONSUMES
the sanitizer's AST — it never reparses SVG. The sanitizer is the project's only
SVG parser: `sanitizeSvg`'s `ok` result now also returns the validated `root`
(the tree the canonical output was written from), and the gate walks that same
tree. Coordinates therefore match the stored canonical svg exactly (the writer
canonicalises attribute order/escaping, never numbers).

Module layout:
- `geometry.ts` — 2-D affine matrices (translate/scale/rotate/matrix, composed
  down the tree), point/bbox transforms (rotation → conservative AABB of the
  four corners), text bbox estimation, shape geometry incl. a path `d`
  point-collector. Pure functions, no state.
- `checks.ts` — the four checks, each emitting coordinate-bearing
  `{ check, elements, bbox, message }` findings (element ref = `#id` when
  present, else the AST path — precise enough to hand to issue 12).
- `index.ts` — `runGate(root): Finding[]`: one tree walk collecting text runs
  and shapes (with inherited font-size / text-anchor / transform), then the
  four checks. Pure, side-effect free.

Thresholds per spec: text-overlap >15% of the smaller box; edge-straddle when a
label overlaps a closed shape yet pokes past an edge by >2px (neither fully in
nor out); clipped when a bbox exceeds the viewBox (1px slack); sub-legible when
the *rendered* font size (font-size × transform scale) < 9.

Wiring (`src/server/index.ts`): on svg publish/update the gate runs over the
sanitizer's AST and `store.writeFindings` persists `v<N>.findings.json` next to
the version. REPORT-ONLY and proven so — the publish has already succeeded
before findings are written; a finding-laden svg still publishes and renders.
Non-svg types get no findings file. The store gained `writeFindings`/
`getFindings` (typed `unknown[]`, so the store keeps no gate dependency).

Calibration gallery: a second Vite entry (`calibration.html` + `calibration.ts`)
served at the authed canvas route `/calibration` (token-injected assets, 401
without the token). It renders every svg Version as an inert
`data:image/svg+xml` `<img>` (Image Isolation preserved) with the gate findings
drawn as numbered outline boxes over the image, a per-finding message + element
refs, and correct / false-positive buttons that POST to `/api/calibration`
(appending to `<stateDir>/calibration.jsonl`, 0600). A header shows precision
per check (correct ÷ ruled, latest ruling per finding wins). `CalibrationLedger`
(`src/server/calibration.ts`) owns the append-only ledger + summary. All
model-influenced strings reach the DOM via textContent only. The main canvas
header links to it.

### Acceptance criteria
1. ✅ Fixture suite (`test/legibility-gate.test.ts`): 9 known-bad SVGs (2
   overlap, 2 straddle, 3 clipped, 2 sub-legible) each produce the expected
   finding with coords asserted within ±5px; 6 known-good produce zero findings.
2. ✅ Findings stored per version; update re-runs the gate into
   `v<N+1>.findings.json` (integration test).
3. ✅ Report-only proven: a finding-laden svg publishes (version returned) and
   is served/renders (integration test).
4. ✅ Rulings persist to `calibration.jsonl`; the precision summary reflects
   them; a bad ruling → 400, nothing appended.
5. ✅ Zero runtime deps + no DOM: guard test greps `src/gate/*` imports (only
   `./…` and the sanitizer AST *types*) and forbids DOM globals.

### Tests
`bun test` green: 199 pass (was 160; +39 = 30 gate unit/fixture + 8 integration
+ 1 ledger-math). Both tsconfigs typecheck clean; `bun run build` succeeds.

### Geometry judgment calls (heuristics are the v1 contract, per Out of Scope)
- Text baseline split: ascent = fontSize above the baseline, descent =
  0.2·fontSize below (sum = 1.2·fontSize = height). Width = charCount ·
  fontSize · 0.6 (monospace-ish upper bound, per spec).
- tspans without their own x/y inherit the parent text position; a tspan with
  x/y starts a fresh run. Direct text of a `<text>` and each `<tspan>` become
  separate runs.
- edge-straddle tests a label against the AABB of closed shapes (rect, polygon,
  circle, ellipse) — an over-approximation for circles/ellipses.
- path `d` bbox is the AABB of the anchor + control points it visits (curves
  bounded by their control polygon — the safe side for a clip check; arc
  radii/flags are not expanded, only the arc endpoint is taken).
- sub-legible uses transform scale only (sqrt|det|); the viewBox→viewport
  display scale is unknown at publish time, so user-space is the reference.
- Findings coordinates are rounded to 0.1px (they are approximate — full float
  precision would imply false exactness).

### 09-AC2 deferred manual-render check — RECORDED (done)
Rendered the benign flowchart fixture and its sanitized form to PNG via
QuickLook: byte-identical output (93,674 bytes each) — the sanitizer's
re-serialization renders visually identical. Also viewed the live calibration
gallery in headless Chrome driving the real server: both the flowchart and an
illegible sample render correctly as inert images with the finding overlays
positioned correctly. 09-AC2's one-time "renders visually identical" check is
satisfied.

### Bug found + fixed while verifying (not in original scope)
Adding the second Vite entry made Rollup hoist a shared module-preload helper
into its own chunk that BOTH entries imported via a token-less
`import "./styles-*.js"` — which 401s under the capability model, silently
breaking the whole canvas (main included) in a real browser. Fixed with
`build.modulePreload: false` so each HTML entry compiles to a single
self-contained JS file (the project's existing invariant). Added a regression
guard test asserting no built entry imports a sibling chunk.

### How to view the calibration gallery
`bun run build`, start the server, open the canvas URL the agent prints, and
click "calibration gallery →" in the header (or open `/calibration?token=…`
directly). Every free-form svg version appears with its findings overlaid;
rule each correct / false-positive and watch the per-check precision update.

### Known minor (non-blocking)
- The gate's edge-straddle fires on legitimately-adjacent labels in dense real
  diagrams (e.g. a numbered badge poking 2.6px past a box corner) — expected,
  and exactly what the report-only calibration pass exists to measure before
  issue 12 turns any of this into enforcement.
