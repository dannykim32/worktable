# 11 — Legibility gate, report-only + calibration gallery

Status: ready-for-agent
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
