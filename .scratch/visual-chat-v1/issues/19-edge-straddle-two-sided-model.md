# 19 — edge-straddle: flag "box too small" (2+ sides), not overhang magnitude

Status: done
Type: task
Milestone: M4.5 (blocks enforcing the edge-straddle check)
Blocked by: 18

## Context

Calibration round 5 (docs/qa/calibration-round-5.md) — an overhang ladder — revealed
the owner's edge-straddle judgment is GESTALT, not magnitude: a label bursting BOTH
sides of a too-small box is wrong even at 5px, while a one-sided tail is fine even at
17px. A poke-magnitude threshold cannot separate these; that's why rounds 3–4 kept
missing. Switch the flag CONDITION to "the label pokes past its owning box on 2+
sides" = the box is genuinely too small to contain the label.

This matches EVERY ruling to date: ladder (2-sided → flag), round 4 "label runs off
right" (1-sided tail → fine), round 3 on-arrow labels (no owning box → already
excluded by issue 17).

Stays REPORT-ONLY.

## Implementation

In `checkEdgeStraddle` (src/gate/checks.ts): KEEP the issue-17 owning-shape selection
(center-in-box, innermost tie-break, on-arrow exclusion) and the issue-18 conservative
`straddleBbox` (0.45em) for the poke geometry. CHANGE only the flag condition:

- Compute the four side-pokes (left, right, top, bottom) of the straddleBbox past the
  owning shape, each vs `STRADDLE_TOLERANCE` (2px).
- Count how many of the four sides poke past the tolerance.
- Flag ONLY when the count is >= 2 (the box cannot contain the label). A single-side
  poke (a positioned tail) is NOT a straddle.
- The finding message should say the box is too small to contain the label and name
  which sides poke (e.g. "left+right"), with coordinates. Reported bbox stays the
  0.6em bbox (issue-18 behavior).

Do NOT change the other three checks. Do NOT change ownership or on-arrow exclusion.

## Acceptance Criteria

1. The round-5 ladder cases (label bursting BOTH sides, any magnitude incl. ~5px) →
   FLAGGED. Fixture for a small (~5px each side) 2-sided burst asserts a finding.
2. The round-4 case (label poking ONE side only — "label runs off right", box x=40
   w=160, text x=100) → NOT flagged (1-sided tail). Fixture asserts zero.
3. A vertically-too-short box (label pokes top AND bottom) → flagged (2 sides works on
   either axis, not just horizontal).
4. A label fully inside its box → not flagged.
5. The other three checks UNCHANGED — their fixtures pass identically (regression).
6. `bun test` green; zero new deps in src/gate/.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit  | side-poke counting; 1-side vs 2-side threshold; vertical burst | +4 |
| Fixtures | ladder 2-sided → flag; round-4 1-sided → clean; fully-inside → clean | +3 |

## After merge (owner)

Re-seed (a 2-sided burst + a 1-sided tail + on-arrow + fully-inside) and re-rule in
/calibration (round 6). When precision holds, all four checks are trustworthy and
`gate: enforce` is safe to flip.

## Out of Scope

Enforcement/repair (issue 12). Changing the other three checks. Real font metrics.

## Comments

Changed ONLY the flag condition in `checkEdgeStraddle` (src/gate/checks.ts). The
issue-17 owning-shape selection (center-in-box, innermost tie-break, on-arrow
exclusion) and the issue-18 conservative `straddleBbox` (0.45 em) poke geometry
are byte-for-byte intact; the reported finding bbox stays the 0.6-em `bbox`.

**The new flag condition (gestalt, not magnitude):** count how many of the four
sides of the conservative box poke past the owning shape by MORE than
`STRADDLE_TOLERANCE` (2px) — `left` (`s.x - p.x`), `right`
(`p.x + p.w - (s.x + s.w)`), `top` (`s.y - p.y`), `bottom`
(`p.y + p.h - (s.y + s.h)`) — and flag ONLY when `sides.length >= 2`. A
single-side poke is a positioned tail, not a straddle. The poke is a STRICT `>`
tolerance, so a 2px graze does not count. Two-sided works on either axis.

**Message:** `text "…" bursts out of <rect> #id on left+right — the box is too
small to contain the label` (names the poking sides; coordinates carried by the
finding bbox, which stays the 0.6-em box).

**Validated against every calibration ruling:**
- Round-5 ladder (centred label bursting BOTH sides, ~5px each): `left`/`right`
  each poke 4.65px → 2 sides → **FLAG**. Before this fix the old check flagged
  it too (worst poke 4.65 > 2), but a magnitude threshold could not have
  separated it from the round-4 tail; the side-count does.
- Round-4 "label runs off right" (box x=100 w=160, 20 chars @13px start-anchored
  at x=120): the 0.45 box lands at x=237, **0 sides** poke → clean (and even at
  the wide 0.6 width it pokes only the ONE right side → still clean). Before/
  after: NO flag, correctly.
- On-arrow labels (center outside every shape): owner stays null → excluded,
  unchanged from issue 17.
- Vertically-too-short box (top+bottom poke): 2 sides → **FLAG** (AC3).
- Fully-inside label: 0 sides → no flag (AC4).

**Fixtures reworked:** the two edge-straddle BAD fixtures were 1-sided pokes
(a right-edge and a top-edge tail) that the old magnitude check flagged but the
2-sided model correctly does not; replaced with genuine 2-sided bursts — a
~5px horizontal burst (round-5 ladder, AC1) and a vertically-too-short-box
top+bottom burst (AC3). The issue-17/18 unit + AC tests that asserted findings on
1-sided geometry were re-cast as 2-sided bursts, preserving the mechanism each
tests (ownership/innermost/dedupe/on-arrow exclusion; conservative-width poke,
reported-bbox-stays-wide, absent-straddleBbox fallback).

**Other three checks:** untouched — `checkTextOverlap`, `checkClipped`,
`checkSubLegible` bodies are byte-identical; only the `checkEdgeStraddle` doc
comment and body changed. Report-only preserved (`runGateSafe` untouched, no
throw path). Zero new deps in `src/gate/`.

**Tests** (`test/legibility-gate.test.ts`): new 8-test issue-19 `describe` —
unit 1-sided→clean, 2-sided horizontal→flag+names left+right, vertical burst→
flag+names top+bottom (AC3), fully-inside→clean (AC4), strict-tolerance boundary
(2px graze vs just-past); fixtures round-5 ~5px burst→flag (AC1), round-4 tail→
clean (AC2), fully-inside→clean (AC4). This file: **63 pass** (was 55). Full
suite: **257 pass, 0 fail** across 20 files (was 249 at issue 18); `tsc -p
tsconfig.json --noEmit` clean.
