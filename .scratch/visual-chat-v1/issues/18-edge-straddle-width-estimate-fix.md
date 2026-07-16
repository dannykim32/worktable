# 18 — edge-straddle: stop the char-width over-estimate manufacturing straddles

Status: ready-for-agent
Type: task
Milestone: M4.5 (blocks enforcing the edge-straddle check)
Blocked by: 17

## Context

Calibration round 4 (docs/qa/calibration-round-4.md): after the owning-shape fix
(issue 17) silenced the on-arrow false positives, the ONE genuine-looking straddle
was still ruled a false positive. Root cause confirmed by the owner: the label
VISUALLY FIT its box; the gate's text-width heuristic (`chars × fontSize × 0.6`, a
generous upper bound) over-estimated the width, so the poke test thought the text ran
56px past a box it actually fit inside.

The over-estimate is SAFE for clipped/text-overlap (they err toward flagging, both at
100%), but for edge-straddle it manufactures straddles. Owner wants the check kept —
a genuinely visible straddle should still flag — so fix the geometry, not the concept.

Stays REPORT-ONLY.

## Implementation

The poke test in `checkEdgeStraddle` must use a CONSERVATIVE (lower-bound) text width,
so it only flags when even a narrow width estimate clearly pokes past the owning box —
giving a label that merely might-or-might-not fit the benefit of the doubt.

Recommended approach (agent to confirm the numbers): compute a second, narrower width
estimate for the straddle poke only — a lower-bound em-ratio (e.g. ~0.45em/char, vs
the 0.6 upper bound the other checks keep) — and/or require the poke to exceed a
margin that absorbs width-estimate error. Do NOT change the shared 0.6 width used by
text-overlap and clipped (those are at 100% — changing their geometry risks
regressing them). Scope any width change to the straddle poke calculation.

Whatever mechanism: a label whose real rendered width fits its box must NOT flag; a
label that pokes CLEARLY past (well beyond the width-estimate uncertainty) must still
flag.

## Acceptance Criteria

1. The round-4 fixture ("label runs off right", 20 chars @13px in a 160px box starting
   at x=100 — real render fits) → ZERO edge-straddle findings.
2. A CLEARLY visible straddle — text poking well past its box, unambiguous even under
   a conservative width (e.g. a short label placed so most of it is outside the box) →
   STILL flagged, with coordinates.
3. The other three checks UNCHANGED — their fixtures pass identically (regression
   guard). If the shared width constant is touched at all, text-overlap and clipped
   fixtures must still pass, proven explicitly.
4. `bun test` green; zero new deps in src/gate/.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit  | conservative-width poke math; fits-vs-pokes boundary | +3 |
| Fixtures | round-4 fit → clean; clear straddle → flags; regression on other 3 | +3 |

## After merge (owner)

Re-seed (a clearly-visible straddle + a fits-fine label) and re-rule edge-straddle in
/calibration (round 5). When precision is acceptable, all four checks are trustworthy
and `gate: enforce` is safe to flip.

## Out of Scope

Enforcement/repair (issue 12). Changing the other three checks' behavior. Pixel-exact
font metrics (the gate has no font engine server-side; a conservative heuristic is the
v1 contract).
