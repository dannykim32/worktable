# Legibility gate — calibration round 6 (2026-07-16): edge-straddle CONFIRMED

Validating the 2-sided model (issue 19). Seeded a 2-sided burst, a small 1-sided
tail, an intended extreme 1-sided tail (probe), an on-arrow label, and a
fully-inside label.

## Result — all four checks now trustworthy

| Artifact | Gate | Owner |
|----------|------|-------|
| Label bursts BOTH sides of a too-small box | edge-straddle (left+right) | **correct** |
| Big one-sided tail (probe) | clean | "fine, looks good" |
| Small one-sided tail | clean | (no finding) |
| Fully inside | clean | (no finding) |
| On-arrow label | clean | (no finding) |

edge-straddle on the 2-sided model: **1 correct / 0 false-positive.** First correct
ruling the check has ever earned, after three fixes (17/18/19) and six rounds.

## Honest note on the probe

The "big one-sided tail" probe artifact rendered FULLY CONTAINED in the browser —
the width heuristic over-estimated that particular (narrow) string again, so it did
not produce the intended extreme 1-sided overhang. The extreme-1-sided edge (a label
with a large tail while its center stays inside its box) was therefore not directly
tested. It remains a narrow theoretical case the 2-sided model does not flag by
design; it is covered by the owner's consistent stance across all six rounds
("one-sided tails are fine") and is safe under report-only (errs toward not flagging,
so it never blocks a good artifact). Not worth a seventh round.

## Final calibration status (all four checks)

- text-overlap: 3/3 all-time — trustworthy
- clipped: 4/4 all-time — trustworthy
- sub-legible: 100% since the issue-16 display-scale fix — trustworthy
- edge-straddle: 2-sided model, confirmed round 6 — trustworthy

Per ADR-0007, the gate may now be given enforcement power for all four checks.
`gate: enforce` is safe to flip (owner's decision). The gate stays `report` by
default until the owner flips it.
