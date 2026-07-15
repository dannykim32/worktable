# 16 — Fix the sub-legible check to judge rendered pixels (calibration-driven)

Status: ready-for-agent
Type: task
Milestone: M4.5 (blocks M5 enforcement of the sub-legible check)
Blocked by: 11

## Context

Calibration round 1 (docs/qa/calibration-round-1.md) found the sub-legible check
at 0% precision (2/2 false positives) while the other three checks scored 100%.
Root cause: the check compares font-size in SVG user space (after transform scale
only) to a 9px floor, but ignores the viewBox→viewport DISPLAY scale. The canvas
renders every SVG to the artifact card content width, so small user-space fonts
often display legibly. Owner ruled 6px and 7px samples legible — correctly.

The check must judge RENDERED pixels. This stays REPORT-ONLY (M4); it does not add
enforcement (that is M5/issue 12).

## Implementation

1. **Documented display-width constant.** Add `CANVAS_CONTENT_WIDTH = 836` to the
   gate (derive in a comment: `.artifact` max-width 880 − 2×22 `.body` padding,
   from src/canvas/styles.css; `.svg-holder img` is max-width:100%). If the layout
   constant ever changes, this is the single place to update — reference styles.css
   in the comment.
2. **Display scale.** The gate already reads the root `viewBox` (width `vbW`).
   `displayScale = CANVAS_CONTENT_WIDTH / vbW`. An SVG with no viewBox width, or a
   degenerate/zero width, must not divide-by-zero or throw (runGateSafe catches
   throws, but handle it honestly: skip the display-scale factor, i.e. treat
   displayScale = 1, and note it).
3. **Rendered font size.** `renderedPx = userFontSize × transformScale ×
   displayScale`. Compare `renderedPx` to `MIN_LEGIBLE_FONT` (9). Update the
   finding message to state the estimated rendered px and the displayScale used, so
   a human/agent can see the reasoning.
4. Keep the finding shape and the report-only wiring unchanged.

## Acceptance Criteria

1. The round-1 seed SVGs (6px caption in a 400-viewBox; 7px note in a 400-viewBox)
   now produce ZERO sub-legible findings (they render ≥9px).
2. A genuinely-illegible case — small font in a WIDE viewBox (e.g. 6px in a
   1600-wide viewBox → renders ~3px) — STILL produces a sub-legible finding.
3. A boundary fixture at exactly the rendered-9px threshold behaves correctly on
   both sides (±small margin), asserted with coordinates.
4. Degenerate viewBox (missing/zero width) does not throw and does not
   false-positive; documented behavior (displayScale = 1) tested.
5. The other three checks are UNCHANGED — their existing fixtures still pass
   identically (regression guard).
6. `bun test` green; zero new deps in src/gate/.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | rendered-px math incl. display + transform scale; degenerate viewBox | +5 |
| Fixtures | round-1 samples now clean; wide-viewBox tiny text still flagged; boundary | +4 |

## After merge (owner)

Re-seed calibration (a fresh set including render-time-illegible cases) and
re-rule sub-legible in /calibration. When its precision is acceptable to the owner,
M5 (issue 12) is unblocked to enforce all four checks.

## Out of Scope

Enforcement / repair round (issue 12). Changing the other three checks. Making
CANVAS_CONTENT_WIDTH dynamic (a documented constant is the v1 contract; the gate
runs at publish time with no client viewport).
