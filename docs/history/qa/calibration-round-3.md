# Legibility gate — calibration round 3 (2026-07-15, live dogfood)

Surfaced during the first real Claude Code dogfood session (not a seeded set): the
agent drew an architecture diagram as a free-form SVG artifact, the gate ran on it,
and the owner ruled the findings in `/calibration`.

## Result

| Check | correct | false-positive | precision | verdict |
|-------|---------|----------------|-----------|---------|
| text-overlap | 1 | 0 | 100% | trustworthy (held) |
| clipped | 1 | 0 | 100% | trustworthy (held) |
| sub-legible | 2 | 0 | 100% | trustworthy (held, post round-2 fix) |
| edge-straddle | 0 | **8** | **0%** | **miscalibrated — over-fires, must fix before enforcing** |

## Root cause (edge-straddle over-fires)

The diagram was legible; a human would call none of the 8 findings a real defect.
Two failure modes, both visible in the ledger:

1. **Flags a label against every container rect its bbox merely grazes.** The
   flagged texts were edge-labels sitting ON the connector arrows (e.g. "SSE push,
   token fetch", "anchored ask-back", "selection + bearer token", "check_askbacks
   or hook"), intentionally placed and readable. The check reported each as
   "straddling" the big MCP-server / browser container rects because the label's
   bounding box crosses those container edges — a technically-true overlap that is
   visually a non-issue.
2. **Double-counts.** One label produced multiple findings — the SAME text flagged
   against `rect[9]` AND `rect[25]` — because its bbox grazes more than one rect.
   So 4 real labels inflated into 8 findings.

## Proposed fix (issue 17)

- Only flag a straddle against the shape the text is *associated with* (the nearest
  containing/adjacent shape), not every rect the bbox grazes.
- Dedupe: one text → at most one edge-straddle finding.
- Consider excluding text whose center is clearly OUTSIDE all shapes (an on-arrow
  edge-label) from the straddle check entirely — straddle is about a label half-in /
  half-out of the box it belongs to, not a label passing over a distant container.

Stays report-only. After the fix, re-seed (a set with a REAL straddle — a label
genuinely half-inside its own box — plus legit edge-labels that should NOT flag) and
re-calibrate to trust before edge-straddle is enforced. M5 enforcement already
merged, but the owner has not flipped `gate: enforce`; keep it in `report` until
edge-straddle is re-calibrated.

## Note

The dogfood itself was a success: a real Claude Code session published a clean
dashboard and this diagram end-to-end, and the gate + calibration gallery worked
live. This finding is the report-only phase doing its job on real output — the same
way round 1 caught sub-legible.
