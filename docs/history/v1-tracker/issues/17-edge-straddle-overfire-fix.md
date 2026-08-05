# 17 — Fix the edge-straddle check over-firing (calibration-driven)

Status: done
Type: task
Milestone: M4.5 (blocks enforcing the edge-straddle check)
Blocked by: 11

## Context

Calibration round 3 (docs/qa/calibration-round-3.md), from the first live Claude Code
dogfood: the agent drew a legible architecture diagram, and edge-straddle flagged 8
findings — the owner ruled ALL 8 false positives (0% precision). The other three
checks held at 100%. Same class of miscalibration sub-legible had in round 1.

Root cause: the check (a) flags a text against EVERY container rect its bounding box
grazes, not just the shape the text belongs to, and (b) double-counts — one label
became multiple findings (same text vs rect[9] AND rect[25]). The flagged texts were
on-arrow edge-labels, intentionally placed and readable.

Stays REPORT-ONLY. Do not add enforcement.

## Implementation

1. **Associate a straddle with one shape.** For each text run, consider only the
   nearest/containing shape (the box the label belongs to), not every rect its bbox
   overlaps. A label passing over a distant container edge is not a straddle.
2. **Dedupe:** one text run → at most one edge-straddle finding.
3. **Exclude clear on-arrow edge-labels:** a text whose center is outside all shapes
   (sitting on a connector between boxes) should not be treated as straddling — a
   straddle is a label half-inside / half-outside the box it is labeling, not a label
   crossing a distant container's edge.
4. Preserve the coordinate-bearing finding shape. Do not touch the other three checks.

## Acceptance Criteria

1. The round-3 diagram pattern (on-arrow edge-labels grazing container rects) → ZERO
   edge-straddle findings. Fixture reproduces an on-arrow label near a container edge.
2. A REAL straddle — a label genuinely half-inside/half-outside its OWN box → still
   flagged, with coordinates. Fixture included.
3. One text run yields at most one edge-straddle finding (no double-count) — fixture
   with a label grazing two rects asserts a single finding.
4. The other three checks (text-overlap, clipped, sub-legible) are UNCHANGED — their
   fixtures pass identically (regression guard).
5. `bun test` green; zero new deps in src/gate/.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit  | association-to-nearest-shape, dedupe, on-arrow exclusion | +4 |
| Fixtures | on-arrow labels clean; real straddle still flags; double-graze → 1 finding | +3 |

## After merge (owner)

Re-seed calibration (real straddle + legit edge-labels) and re-rule edge-straddle in
/calibration. When precision is acceptable, all four checks are trustworthy and
`gate: enforce` is safe to flip.

## Out of Scope

Enforcement/repair (issue 12, already merged). Changing the other three checks.

## Comments

Fixed in `src/gate/checks.ts` — `checkEdgeStraddle` rewritten to associate each
text run with ONE owning shape instead of iterating every grazed rect. Added a
`centerGap(cx, cy, box)` helper (Chebyshev distance from a point to a box, 0 when
inside/on an edge). The other three checks and all geometry helpers are untouched;
`runGateSafe` and the report-only contract are preserved. Zero new deps.

**The rule for "the shape a label belongs to":** the nearest closed shape whose
interior the text's CENTER sits in — or within `STRADDLE_TOLERANCE` (2px) of an
edge, so a label centred exactly on the boundary still counts. Ties break to the
smaller (innermost) box, so a label nested in an inner box is judged against that
box, not the outer container. A text whose center is more than the tolerance
outside every shape is an on-arrow edge-label (sitting on a connector between
boxes) and is excluded entirely — its bbox may clip a distant container's edge,
but that is not a straddle. This yields at most one finding per run (dedupe).

**Before → after (same fixtures):**
- Round-3 on-arrow label grazing two container rects: **2 findings → 0**.
- Real straddle whose bbox also grazes a neighbouring box: **2 findings
  (double-count, one per rect) → 1**, referencing only the owning box.
- Existing genuine straddles (right-edge, top-edge fixtures): still flagged with
  identical coordinates (their centers sit on/within 2px of the box edge).

**Tests:** `test/legibility-gate.test.ts` — added one on-arrow GOOD fixture plus a
7-test `describe` block (AC1 on-arrow→zero, AC2 real straddle flagged with coords,
AC3 double-graze→exactly one; unit tests for on-arrow exclusion, nearest/innermost
association, dedupe, and center-on-edge). All AC verified. Full suite: **243 pass,
0 fail** across 20 files; `tsc -p tsconfig.json --noEmit` clean. The other three
checks' fixtures pass identically (regression guard).
