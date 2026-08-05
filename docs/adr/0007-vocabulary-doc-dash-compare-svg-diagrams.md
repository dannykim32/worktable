# V1 vocabulary is Document + Dashboard + Compare; free-form SVG owns diagrams

> **Status: superseded by [ADR-0012](0012-html-hatch-is-the-surface.md) (2026-08-04).**
> The structured vocabulary and the `svg` type were retired; the surface is
> `{html, prose, absence}`. Kept for the record. The judged prototype now lives at
> `docs/history/prototypes/canvas-vocabulary/`.

Settled by prototype (prototype/canvas-vocabulary/, judged 2026-07-14): the three
structured components cover the design-doc, metrics, and before/after jobs, and
flowcharts/diagrams go exclusively through the free-form SVG hatch — no structured
nodes/edges Diagram component in v1. The side-by-side comparison showed the
free-form version carrying in-place idioms (trust-boundary grouping, warnings
pinned to the edge they warn about, node size as importance, numbered flow) that
engine-owned layout exiles to footnotes; guaranteed tidiness did not compensate for
the lost expressiveness.

This decision is CONTINGENT on the legibility gate: free-form SVG ships only with
the deterministic gate (text overlap, edge-straddling, off-canvas/clipped,
sub-legible density) in front of it — one bounded repair round with
coordinate-bearing findings, second failure = honest absence, enforcement enabled
only after a report-only calibration gallery has been ruled on by the human.
A structured Diagram component remains a clean future addition if the calibration
gallery shows free-form diagram quality is too inconsistent.
