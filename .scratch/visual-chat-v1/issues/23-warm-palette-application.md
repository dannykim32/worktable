# 23 — Apply the warm palette to the real theme (owner-picked)

Status: done
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

## Comments

Applied to `src/canvas/styles.css` `:root` (light-only; no dark block reintroduced).

Vars changed (before -> after):
- `--series-1` `#2a78d6` -> `#fc6c26`; `--series-2` `#1baf7a` -> `#c9551b`;
  `--series-3` `#9a5bd2` -> `#9a4a2a`; `--series-4` `#c85c8e` -> `#6e4630` (variant C ramp).
- `--delta-good` `#006300` -> `#6b7233` (warm olive). `--delta-bad` `#b23127` and
  `--muted` `#9a8b70` kept.
- `--add-bg` `#e2f2e2` -> `#f0ecd8` (warm cream); `--del-bg` `#fbe3e3` -> `#f5e3d8`
  (warm clay) — distinguished by the +/- glyph, not hue.
- Added `--callout-accent: #a06a3c`; repointed `.doc .callout` border-left from
  `var(--series-1)` to `var(--callout-accent)`.
- `--dot-live` `#0ca30c` -> `var(--accent-warm)` so the live connection dot leads
  with the accent (AC4 / the owner principle name it a lead element; it had been
  green from issue 07).

`.badge` reworked to quiet metadata: `color: var(--muted)`, `1px solid var(--border)`,
transparent fill, uppercase, `.06em` tracking, `10.5px`, `border-radius: 6px` — no
accent-warm border, no accent-wash fill. `.badge.absence` left as-is. `.badge.freeform`
kept distinguishable-but-quiet: warm `--accent-ink` text + an `--accent-warm` hairline
+ italic (no filled orange pill); provenance carried by the "svg · free-form" text.

`--accent-warm` still leads only on: masthead border-bottom, `:focus-visible`, the live
dot, and `.viewing-marker`. Renderers (`dashboard.ts`/`compare.ts`/`document.ts`) carry
no hardcoded hex — they read the CSS vars, so the var swap sufficed (no renderer edits).

AC verification: `bun test` green (303 pass / 0 fail, 27 files); zero new deps. QA
screenshots re-captured on the warm theme via the real renderers (happy-dom) + the real
stylesheet, headless Chrome, light mode: `docs/qa/m2-dashboard-light.png`,
`docs/qa/m2-compare-light.png`.

Judgment call: the live connection dot. The spec's "keep accent where it leads" section
and AC4 both name the live dot as an accent-warm lead element, but the merged issue-07
theme rendered it green (`--dot-live: #0ca30c`, "true status signal"). Followed the
newer explicit owner direction and pointed the connected dot at `--accent-warm` (a
color-var change, in scope); idle/disconnected stays muted-neutral.

Review follow-up (owner, post-capture): walked the live dot back off the accent —
`--dot-live` now uses the warm-olive `--delta-good` (#6b7233), keeping the green-family
"connected" convention while staying warm. Accent-warm now leads on masthead +
`:focus-visible` + `.viewing-marker` only; the dot is a status signal, not a brand lead.
