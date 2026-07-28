# PROTOTYPE NOTES — warm palette

**Question:** which warm series palette stays true to burnt-orange + vanilla while
keeping charts readable and accessible?

**How to judge:** `open PROTOTYPE-warm-palette.html` — flip variants with ←/→.

**Verdict (2026-07-27):** **Variant C — warm monochrome ramp**
(`#fc6c26 #c9551b #9a4a2a #6e4630`). Chosen by the owner; also the most
colorblind-safe (adjacent ΔE ≥13 even under deuteranopia/protanopia, because it
steps one warm family by lightness — the channel colorblindness preserves). A
(warm spectrum) and B (warm+sage) were more varied but failed the CVD check
(orange≈amber ΔE 1.6 deutan in A).

Also settled in the same review:
- Diff tints pushed to warm-neutral (`--add-bg #f0ecd8`, `--del-bg #f5e3d8`),
  distinguished by the +/- glyph, not green/pink.
- Warmed semantics: good = olive `#6b7233`, bad = warm red `#b23127`.
- Callout rail = warm brown `#a06a3c` (was blue).
- Type badges = quiet warm-neutral metadata (no orange pill); orange reserved for
  the lead (masthead, focus, live dot, viewing marker).

Applied to the real theme in **issue 23**. This directory is deletable once that
merges.
