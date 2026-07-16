# 19 — edge-straddle: flag "box too small" (2+ sides), not overhang magnitude

Status: ready-for-agent
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
