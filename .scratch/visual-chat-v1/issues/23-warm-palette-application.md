# 23 — Apply the warm palette to the real theme (owner-picked)

Status: ready-for-agent
Type: task
Milestone: post-v1 (design)
Blocked by: 07

## Context

The owner reviewed the warm-palette prototype (prototype/warm-palette/) and picked
**variant C (warm monochrome ramp)**, plus: warm-neutral diff tints, warmed semantics,
a warm-brown callout rail, and QUIET type badges. Guiding principle from the owner:
**burnt orange (`--accent-warm`) leads only — masthead rule, focus outline, live dot,
the version "viewing" marker. Static metadata (type badges, callout rails) stays
warm-neutral so the accent isn't sprayed everywhere.** The current merged theme still
uses a COOL data-viz palette (blue/green/purple/pink) + cool green "good" + cool
green/pink diff tints + an orange type-badge pill — all of which fight the warm brand.

Apply the exact values below to `src/canvas/styles.css` (and any renderer that
references the changed vars). All values are contrast-validated; do not re-derive.

## Exact values (src/canvas/styles.css :root — light-only, no dark block)

Series (variant C — a warm ramp by lightness; validated ≥13 ΔE adjacent even under
deuteranopia/protanopia):
- `--series-1: #fc6c26`  `--series-2: #c9551b`  `--series-3: #9a4a2a`  `--series-4: #6e4630`

Warmed semantics:
- `--delta-good: #6b7233`  (warm olive, 4.97:1 on surface — REPLACES the cool green)
- `--delta-bad:  #b23127`  (warm red — keep)
- `--muted:      #9a8b70`  (keep — neutral deltas/ticks)

Diff tints — pushed to warm-neutral (subtle washes, distinguished by the +/- glyph,
NOT by green/pink):
- `--add-bg: #f0ecd8`  (warm cream)
- `--del-bg: #f5e3d8`  (warm clay)

Callout rail — warm brown, NOT `--series-1`/blue. Add `--callout-accent: #a06a3c` and
point `.doc .callout` border-left at it (it currently uses `var(--series-1)`).

## Badge — quiet metadata (not the loud orange pill)

Rework `.badge` to: `color: var(--muted)`, `border: 1px solid var(--border)`,
`background: transparent`, small uppercase (`text-transform: uppercase;
letter-spacing: .06em; font-size: 10.5px`), `border-radius: 6px`. No `--accent-warm`
border, no `--accent-wash` fill. Keep `.badge.absence` calm as it is. The `.badge.freeform`
(SVG provenance, ADR-0009) must stay DISTINGUISHABLE from component badges but also
warm-neutral — do it with the text + a subtle cue (e.g. italic or a hairline in
`--accent-warm` at most), not a filled orange pill. Provenance is carried by the text
("svg · free-form"), not loudness.

## Keep accent where it LEADS (do not neutralize these)

`--accent-warm` stays on: the masthead border-bottom rule, the `:focus-visible`
outline, the live connection dot, and the `.viewing-marker` (an active "not on latest"
signal). Those are functional/lead elements, not static metadata.

## Acceptance Criteria

1. styles.css :root carries the exact values above; the cool series/green/pink values
   are gone. No dark-mode block reintroduced.
2. The dashboard chart series render in the warm ramp (they read `--series-N`, so a var
   change suffices — confirm no hardcoded cool hex in dashboard.ts).
3. Deltas: good=olive, bad=warm-red, neutral=muted. Compare diff lines use the warm
   `--add-bg`/`--del-bg`. Callout rail is warm brown.
4. Type badges are quiet (muted uppercase, hairline, no orange fill); the freeform
   badge stays distinguishable but warm-neutral; accent-warm remains on masthead/
   focus/live-dot/viewing-marker.
5. Re-capture the QA screenshots (docs/qa/m2-dashboard-light.png, m2-compare-light.png)
   on the new theme; light + legible.
6. No behavior change (renderers/logic untouched beyond color vars + the callout
   accent ref); existing tests + XSS canaries pass. `bun test` green; zero new deps.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Visual | re-captured docs/qa screenshots (dashboard + compare) on the warm theme | (manual) |
| Regression | existing renderer/canary tests unaffected by the var changes | 0 new |

## Out of Scope

Changing chart logic, adding a theme toggle, dark mode. Reworking non-canvas surfaces.
