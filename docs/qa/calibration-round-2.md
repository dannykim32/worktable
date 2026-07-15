# Legibility gate — calibration round 2 (2026-07-15)

Re-calibration after the sub-legible display-scale fix (issue 16). This is the
ADR-0007 sign-off that unblocks M5 enforcement.

## Result — PASS

| Check | correct | false-positive | precision | vs round 1 |
|-------|---------|----------------|-----------|------------|
| text-overlap | 1 | 0 | 100% | held |
| clipped | 1 | 0 | 100% | held |
| sub-legible | 2 | 0 | **100%** | **0% → 100%** |
| edge-straddle | (not re-seeded) | — | — | 100% in round 1; unchanged by the fix (other three checks byte-identical, regression-guarded in code + tests) |

## What proved the fix

- The **exact 6px and 7px captions the owner ruled "fine" in round 1** now produce
  ZERO sub-legible findings (they render ~12.5px / ~14.6px after the 836px display
  scale) — the false positives are gone at the source.
- Genuinely render-illegible text still flags and the owner agreed: 6px in a
  1600-wide viewBox (~3px) → "illegible"; 16px in a 1672-wide viewBox (~8px) →
  "really close but lean slightly illegible, probably too small for most people."
  The owner's borderline ruling on the ~8px case confirms the 9px floor is
  well-placed — no floor change needed.
- Regression guards held: text-overlap and clipped still 100%; the clean SVG
  produced no findings.

## Sign-off

Owner accepted all four checks as trustworthy (2026-07-15). Per ADR-0007, the
legibility gate may now be given enforcement power. M5 (issue 12) is unblocked:
fail → one bounded repair round with coordinate findings → honest absence on a
second failure. Round-1 ledger archived at `calibration.round1.jsonl`.
