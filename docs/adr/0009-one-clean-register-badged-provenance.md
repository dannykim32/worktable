# One clean aesthetic register for all artifacts; provenance is badged, not styled

> **Status: retired by [ADR-0012](0012-html-hatch-is-the-surface.md) (2026-08-04).**
> With the `svg` type and the component vocabulary gone, the free-form provenance
> badging this record defined went with them. Kept for the record.

Deliberate deviation from the prior project's hand-drawn sketch identity for
AI-authored visuals: every artifact on the canvas — trusted components and
free-form SVG alike — wears the same clean, product-grade register. The honesty
signal ("rendered fact" vs "model's abstraction") moves from style to explicit
markers: the artifact-header provenance badge (e.g. "svg · free-form") and the
standing caption on free-form artifacts ("depicts the idea, not the exact code").
A two-register scheme (clean components, server-enforced sketch styling for
free-form) was considered and rejected in favor of visual cohesion; if calibration
review later shows readers over-trusting model-drawn diagrams, the sketch register
remains available as a server-side style layer without any format change.
