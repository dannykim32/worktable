# Legibility gate — calibration round 5 (2026-07-16, the overhang ladder)

To pin the edge-straddle tolerance, seeded four artifacts with the SAME label
("Wide overflowing label", text-anchor:middle, centered) in boxes of decreasing
width, so the label pokes ~5 / 20 / 40 / 60px past EACH side. Owner ruled by eye.

## Result — the surprise

| Computed overhang (each side) | Owner verdict |
|-------------------------------|---------------|
| ~5px | correct (flag) |
| ~20px | correct |
| ~40px | correct |
| ~60px | correct |

**All four flagged — even 5px.** On its face this contradicts round 4, where the
owner called a 17px overhang "fine." It does not.

## The real model: gestalt, not magnitude

- **Round 4** ("label runs off right", left-anchored): the label sat mostly inside
  its box with a small tail off ONE side. Fine.
- **The ladder** (centered): the label bursts out BOTH sides of a too-small box.
  Wrong — even at 5px.

The owner's judgment is **"does the box actually contain this label."** A label
bursting symmetrically means the box is genuinely too small (flag). A one-sided tail
means the label is just positioned long (fine). A poke-MAGNITUDE threshold — all the
gate could cheaply compute — cannot separate these (5px symmetric should flag, 17px
one-sided should not). That is why five rounds of tuning a magnitude threshold kept
missing: the check was measuring the wrong thing.

## Decision (owner): switch to a 2-sided model (issue 19)

Flag a straddle only when the label pokes past its owning box on **2 or more sides**
(the box is too small to contain it), not on overhang magnitude. This matches EVERY
ruling across all rounds: ladder (2-sided → flag), round 4 (1-sided tail → fine),
round 3 on-arrow (no owning box → excluded). Keeps the issue-17 owning-shape/on-arrow
logic and the issue-18 conservative width; only the flag CONDITION changes.
