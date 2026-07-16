# Legibility gate — calibration round 4 (2026-07-16)

Re-calibrating edge-straddle after the owning-shape fix (issue 17). Seeded set: a
hand-built "genuine" straddle, two on-arrow patterns (incl. the exact dogfood case),
and regression cases for the other three checks.

## Result

| Check | correct | false-positive | precision |
|-------|---------|----------------|-----------|
| text-overlap | 1 | 0 | 100% (regression held) |
| clipped | 1 | 0 | 100% (regression held) |
| edge-straddle | 0 | 1 | **0% — still failing** |

The owning-shape fix worked as far as it went: both on-arrow patterns (which flagged
8× at 0% in round 3) produced ZERO findings this round. But the ONE edge-straddle
finding — the case built to be a genuine straddle ("label runs off right") — was
ruled **false positive** by the owner.

All-time edge-straddle: **1 correct / 9 false-positive** across every round.

## Root cause (this round): the char-width heuristic over-estimates

The gate models text width as `chars × fontSize × 0.6` (a generous upper bound). For
"label runs off right" (20 chars, 13px) that is 156px, so the gate believed the text
poked 56px past its 160px-wide box. The owner confirmed the label VISUALLY FIT inside
the box in the browser — system-ui renders that string well under 0.6em/char, so the
poke the gate "saw" wasn't there. The over-estimate is safe for the other checks
(clipped/overlap err toward flagging, both at 100%) but for edge-straddle it
manufactures straddles that don't exist.

Owner's call: the concept is worth keeping — a GENUINE, visible straddle should still
flag — so fix the geometry rather than drop the check. Tracked in issue 18.

## Note

This round still validated the round-17 fix (on-arrow exclusion held: 0 findings on
both on-arrow artifacts) and the regression guards (overlap, clipped 100%). The
remaining gap is purely the width estimate feeding the poke test.
