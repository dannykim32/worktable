# 16 — Fix the sub-legible check to judge rendered pixels (calibration-driven)

Status: done
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

## Comments

Done. The sub-legible check now judges ON-SCREEN pixels, not raw user-space size.

What changed (src/gate/):
- `checks.ts`: added `CANVAS_CONTENT_WIDTH = 836` (documented derivation from
  styles.css: `.artifact` 880 − 2×22 `.body` padding; `.svg-holder img` is
  max-width:100%) and a pure `displayScaleFor(viewBoxWidth)` helper. `checkSubLegible`
  now takes the root viewBox width, computes `displayScale = 836 / vbW`, and judges
  `renderedPx = transformedFontSize × displayScale` against the 9px floor. The
  finding message now states the estimated rendered px and the display scale used.
  Renamed the `TextRun.renderedFontSize` field to `transformedFontSize` — it only
  ever held the post-transform user-space size, and the display scale is applied
  later, so the old name was a lie.
- `index.ts`: passes `viewBox ? viewBox.w : null` into `checkSubLegible`; sets
  `transformedFontSize`. Report-only wiring and `runGateSafe` unchanged.

Degenerate contract (AC4): `displayScaleFor` returns 1 for a null / zero /
negative / non-finite viewBox width — no divide-by-zero, no throw. The fallback
judges the user-space size as-is (the old behavior), which is the honest thing to
do when no display scale is knowable; a normal font does not false-positive.

Acceptance criteria — all met, verified:
- AC1: round-1 6px & 7px in a 400 viewBox → 0 sub-legible findings (render ~12.5 /
  ~14.6px).
- AC2: 6px in a 1600 viewBox → still flags, "renders at ~3.1px (display scale 0.5×)".
- AC3: boundary in a 1672 viewBox (display scale exactly 0.5×): 16px → 8px flags,
  18px → exactly 9px clean (floor inclusive). Fixtures assert coordinates.
- AC4: zero-width viewBox does not throw and does not false-positive a 16px font;
  displayScaleFor degenerate cases unit-tested.
- AC5: the other three checks (text-overlap, edge-straddle, clipped) are untouched;
  their fixtures pass identically.
- AC6: `bun test` green (210 pass); zero new deps in src/gate/.

Tests: legibility-gate.test.ts 32 → 41 pass (+5 display-scale units, +3 GOOD /
net +1 BAD fixtures). The integration `ILLEGIBLE` fixture was retuned (8px in a
1600-wide viewBox) so it still exercises the multi-finding report-only path
(sub-legible + clipped) under the render-aware logic.

Assumption on the display-scale model: it estimates the canvas render width as a
fixed 836px content box for every card, applying a uniform `836 / viewBoxWidth`
scale to font sizes. This assumes the SVG fills the card content width (true given
`.svg-holder img { max-width:100% }` and typical wide diagrams) and ignores the
narrower-viewport (mobile / very tall or portrait SVG) case where the image may be
height-constrained and render narrower than 836px — there the true display scale
is smaller, so the check could under-report on portrait SVGs. That is acceptable
for the report-only v1 contract (issue 16 Out of Scope: no dynamic width); if it
proves lossy in re-calibration, the constant is the single place to revisit.
