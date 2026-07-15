# Legibility gate — calibration round 1 (2026-07-15)

First human calibration of the report-only legibility gate (ADR-0007 evidence
step). Six seeded free-form SVGs, one clean + one per check + one mixed; findings
ruled by the owner in `/calibration`.

## Result

| Check | correct | false-positive | precision | verdict |
|-------|---------|----------------|-----------|---------|
| text-overlap | 1 | 0 | 100% | trustworthy — ready to enforce |
| edge-straddle | 1 | 0 | 100% | trustworthy — ready to enforce |
| clipped | 2 | 0 | 100% | trustworthy — ready to enforce |
| sub-legible | 0 | 2 | 0% | **miscalibrated — must fix before enforcing** |

The clean SVG produced zero findings (no false alarm).

## Root cause of the sub-legible failure

The check compares font-size in the SVG's own coordinate space (after transform
scale only) against a 9px floor. It does NOT apply the viewBox→viewport display
scale. The canvas renders every SVG to the artifact card content width (~836px:
`.artifact` max-width 880 − 2×22 body padding), so a 6px font inside a 400-wide
viewBox displays at ~12.5px — legible. The owner ruled both the 6px and 7px
samples "small but not impossibly small, fine if we need to fit some text in,"
which is correct: they render legibly. The other three checks are scale-invariant
(overlap, edge-straddle, and clipping-relative-to-viewBox all hold at any display
scale), which is why they scored 100%.

## Decision (owner, 2026-07-15)

Fix the sub-legible check to judge RENDERED pixels (apply display scale), then
re-calibrate it to trust, THEN enforce all four checks in M5. Do NOT ship
enforcement with sub-legible in its current form, and do NOT drop the check —
the genuinely-illegible case (e.g. tiny text in a very wide viewBox) still matters.
Tracked in issue 16; M5 (issue 12) is blocked on the re-calibration passing.
