# 17 — Fix the edge-straddle check over-firing (calibration-driven)

Status: ready-for-agent
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
