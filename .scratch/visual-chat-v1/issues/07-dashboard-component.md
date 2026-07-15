# 07 — Dashboard component

Status: done
Type: task
Milestone: M2
Blocked by: 04

## Context

ADR-0007 vocabulary. Reference rendering: the prototype's "Pilot gallery health"
artifact (stat tiles + labeled bar chart + sparkline), including its palette and mark
conventions (thin marks, rounded data ends, direct value labels, single axis).

## Implementation Details

Schema (added to publish/update tool union; `additionalProperties: false`):

```jsonc
{ "type": "dashboard", "title": "string",
  "tiles": [ { "label": "string", "value": "string|number",
               "delta": { "text": "string", "tone": "good"|"bad"|"neutral" }? } ], // 0..8
  "charts": [ { "kind": "bar"|"line", "title": "string",
                "unit": "string?",
                "series": [ { "label": "string", "points":
                  [ { "x": "string|number", "y": "number" } ] } ] } ] } // 0..4
```

Renderer rules (from the dataviz method used in the prototype): SVG built by trusted
code; ONE y-axis per chart (schema has no second axis — by construction); ≤4 series
per chart, categorical palette slots assigned in fixed order; direct labels on bar
ends; hairline grid; hover tooltip per mark; values/labels always in ink colors, never
series colors. Numbers formatted with tabular-nums in axis/table contexts.

## Acceptance Criteria

1. Golden fixture (4 tiles + bar + line) renders matching expected DOM/SVG structure.
2. Series count >4 → schema rejection at the tool boundary (not a legend explosion).
3. Bars/lines with negative and zero y render correctly (baseline anchored at 0).
4. Hover tooltip shows label + value; keyboard focus reaches each mark (tabindex).
5. XSS canary: tile label with HTML renders as literal text.
6. Light + dark legible (manual screenshot check).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit (jsdom) | tile/bar/line renderers, scale fn edge cases (neg/zero/single-point) | +7 |

## Effort

~4h: 2.5h renderers, 1.5h tests.

## Out of Scope

Heatmaps, stacked/multi-axis charts, filters (ADR-0010 — no app-like state).

## Comments

2026-07-14 — done. Schema added verbatim to the publish/update tool union
(src/server/validate.ts: tiles 0..8, charts 0..4, series ≤4, all objects
additionalProperties:false), mirrored in the hand validator with JSON-path
rejections at the tool boundary. Renderer (src/canvas/components/dashboard.ts)
is a pure DOM function behind the registry seam: trusted-code SVG via
createElementNS, all model-influenced strings land as textContent/aria-label.
One zero-anchored value axis per chart (a second is unrepresentable —
AC2 test asserts /charts/0/y2 rejects); fixed categorical slots s1–s4;
rounded 4px data ends; hairline grid; direct value labels and series labels
in ink colors only; per-mark hover tooltip + tabindex=0 keyboard focus.
Slots 3–4 (--series-3/4 in styles.css) chosen with the dataviz six-checks
validator against --surface-1: light `#9a5bd2 #c85c8e` (PASS; series-2
contrast WARN relieved by mandatory direct labels), dark `#a97ae0 #cf6690`
(all PASS, selected separately — not a flipped light palette).
Tests: +13 in test/dashboard-renderer.test.ts (boundary rejections, scale
edge cases neg/zero/single-point, golden 4-tiles+bar+line fixture, legend
order, baseline anchoring, tooltip hover/focus, XSS canary); suite 71 pass.
AC6 verified by headless-Chromium captures of the real renderer+stylesheet:
docs/qa/m2-dashboard-light.png and docs/qa/m2-dashboard-dark.png (dark run
exercises the real dark custom-property block made unconditional in the
harness copy of the stylesheet).

2026-07-14 — review addition: points per series are now capped at
POINTS_MAX = 200 (src/shared/constraints.ts), enforced in both the
declared JSON schema (maxItems) and the hand validator (rejection path
/charts/N/series/M/points), per the PRD's bound-large-inputs doctrine.
Boundary tests: 200 accepted, 201 rejected.
