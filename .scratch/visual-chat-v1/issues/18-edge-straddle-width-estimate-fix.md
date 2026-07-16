# 18 — edge-straddle: stop the char-width over-estimate manufacturing straddles

Status: done
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

## Comments

Fixed by giving the edge-straddle poke its OWN conservative width, leaving the shared
0.6-em box the other three checks read untouched.

**The rule (ratio, not margin):** `STRADDLE_WIDTH_PER_EM = 0.45` (new constant in
`src/gate/geometry.ts`, next to the existing `TEXT_WIDTH_PER_EM = 0.6`). At layout time
`src/gate/index.ts` now lays each text run out TWICE: the usual 0.6-em `bbox` (unchanged
— overlap, clip, and the reported finding bbox all still read it) and a second, narrower
`straddleBbox` at 0.45 em (same anchor, same height, only the width shrinks). The new
optional `TextRun.straddleBbox` field carries it. `checkEdgeStraddle` measures its poke
against `straddleBbox` (falling back to `bbox` when absent, so hand-built unit-test runs
keep the old semantics); ownership and the reported bbox stay on the 0.6-em `bbox`, so
issue-17's owning-shape association, dedupe, and on-arrow exclusion are byte-for-byte
intact.

**Why 0.45:** dense, lowercase-heavy strings in system-ui render around 0.45–0.5 em/char,
so 0.45 is a defensible LOWER bound on real width — if a box that narrow still pokes past
a shape edge, the straddle is real, not an artefact of the generous 0.6 estimate. Dropping
0.6 → 0.45 already absorbs ~25% of width-estimate error, so no extra poke margin is stacked
on top (that would risk missing genuine straddles). `STRADDLE_TOLERANCE` stays 2px.

**Before → after:**
- Round-4 fixture ("label runs off right", 20 chars @13px, box x=100 w=160): 0.6 width =
  156px poked **16px** past the right edge (false straddle); 0.45 width = 117px lands at
  x=237, **20px inside** the 260 edge → **0 findings** (AC1).
- Clear straddle ("Overflowing Wide Label", 22 chars centred on a 40px box): pokes **72px**
  at 0.6 and **49px** at 0.45 → still **flagged** with coords, reported bbox unchanged (AC2).
- The two round-11 edge-straddle BAD fixtures: narrow pokes 23.4px and 9.0px — still flag,
  identical coords (AC3 regression).

**Other three checks:** byte-identical. `checkTextOverlap`, `checkClipped`, and
`checkSubLegible` bodies are untouched; the only shared-code edit is `textLocalBbox` gaining
an optional `widthPerEm` param that DEFAULTS to `TEXT_WIDTH_PER_EM`, so every existing caller
still gets the 0.6 box. Proven: the full BAD/GOOD fixture suite (both overlap + both clip +
all sub-legible fixtures) passes with identical assertions.

**Report-only preserved:** `runGateSafe` untouched, no throw path, zero new deps in
`src/gate/`.

**Tests** (`test/legibility-gate.test.ts`): +6 in a new issue-18 `describe` — AC1 round-4→
clean (fixture) + a mechanism unit proving the same geometry flagged at 0.6 and is silenced
at 0.45; AC2 clear straddle→flagged with coords (fixture); AC3 both existing straddles still
flag (regression fixture); a fits-vs-pokes boundary unit (poke reads `straddleBbox`, reported
bbox stays the wide box); a fallback unit (absent `straddleBbox` → old semantics). Full suite:
**249 pass, 0 fail** across 20 files (was 243 at issue 17); `tsc -p tsconfig.json --noEmit`
clean.
