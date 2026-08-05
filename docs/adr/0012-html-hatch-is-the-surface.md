# The HTML hatch is the artifact surface; the structured vocabulary is retired

Supersedes the posture of ADR-0002 (free-form HTML was a deferred *exception* to a
structured-component default) and ADR-0007 (the Document/Dashboard/Compare
vocabulary with svg owning diagrams), and retires ADR-0009 (the clean-register /
badged-provenance scheme for free-form svg) and ADR-0011 (the legibility-gate mode
config). Decided 2026-08-04 after dogfooding.

## Context

v1 shipped a structured Component Vocabulary (document / dashboard / compare) as
the safe default, free-form SVG under a sanitizer + legibility gate as the
expressiveness hatch, and — once issue 25 landed — a sandboxed HTML hatch as a
last resort. Dogfooding showed the ordering was backwards. Given the same request,
our canvas produced a `type:"document"` wall of headings with zero diagrams; a
native Claude artifact, authored with the **artifact-design** skill, produced rich
hand-crafted **HTML+CSS** flowcharts. Those native visuals are self-contained
HTML+CSS (no JS, no external libraries, no runtime SVG) — exactly what the
iframe-isolated hatch (issue 25) already renders safely.

The lesson: our value is **local hosting + selection-anchored ask-back**, not a
visualization vocabulary. The model's native artifact quality beats anything our
components produce, and the hatch already hosts it. Maintaining a second, inferior
rendering path (and the svg sanitizer / legibility gate / calibration / repair /
gate-mode machinery that existed only to make free-form SVG safe) was pure cost.

## Decision

The artifact surface is exactly three types: **`html`** (primary — a self-contained,
sandboxed, model-authored page), **`prose`** (a long markdown answer via the trusted
markdown→DOM renderer), and **`absence`** (Honest Absence). The agent authors html
artifacts with the artifact-design skill's process but publishes them to *this*
canvas (for the ask-back loop), never to the native Artifact tool.

Retired and deleted (git preserves the history): the `document` / `dashboard` /
`compare` / `svg` types and components; the SVG sanitizer (`src/sanitizer/`); the
legibility gate (`src/gate/`) and its calibration + repair round; the gate-mode
config and settings panel. ~9,250 LOC removed.

The security posture is unchanged and, for the visual use case, stronger: the hatch
serves model markup verbatim into a sandboxed, origin-split, CSP-locked iframe
(issue 25), which is a stricter boundary than image-isolated SVG — and `frameGuard`
still reject-not-drops no-click network-egress at ingest. The ask-back queue remains
the one authenticated write channel (ADR-0010).

## Consequences

- **Static HTML/CSS/SVG only.** The win covers documents, diagrams, flowcharts,
  before/after, CSS dashboards — everything dogfooding wanted. JS-*interactive*
  artifacts remain the deferred Tier 2 (issue 25), with its documented residual.
- **No truth/legibility gate.** The gate was svg-geometry-only; model-authored
  HTML/CSS layout is the browser's job. Logical Fidelity and Honest Absence still
  bind by doctrine, enforced by the agent, not a geometry checker.
- **The exposed schema is flat** (`type` enum of the three), which LLM tool-use
  fills reliably (a prior top-level `oneOf` did not — it made the model emit the
  wrong type).

## Considered alternatives

- **Keep the components as a fallback, lead with html** — rejected: a second
  inferior path the agent would still sometimes take, plus the maintenance of the
  whole svg-safety apparatus, for no benefit over the hatch.
- **Keep svg (and its sanitizer/gate)** — rejected: SVG lives inside an html
  artifact now, served verbatim under iframe isolation; the standalone type and its
  sanitize-and-gate machinery are redundant.
