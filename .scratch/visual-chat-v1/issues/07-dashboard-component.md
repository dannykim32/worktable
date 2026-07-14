# 07 — Dashboard component

Status: ready-for-agent
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
