# V1 artifacts are structured components plus an SVG escape hatch — no free-form HTML

Even though the canvas is an HTML page, the agent cannot author free-form HTML in v1.
The default medium is Component Artifacts (structured data drawn by the trusted
Component Vocabulary — nothing to sanitize), and the expressiveness escape hatch is
free-form SVG rendered under Image Isolation (data: URL in <img>), the mechanism
proven in the prior project. Free-form HTML has no equivalent
impossible-by-construction isolation — it would cost a full re-serializing HTML
sanitizer, sandboxed iframe, and CSP — and its demand is unproven: what HTML is
uniquely good at (rich text, tables, dashboards) is exactly what trusted components
render best. Per the "evidence over guessing" doctrine, free-form HTML gets a labeled
architectural slot but is only built if the pilot gallery produces artifacts that
components + SVG could not express.

## The labeled slot, informed (2026-07-15)

Security research for the deferred hatch is complete and validates this ADR's
posture: docs/research/safe-llm-html-rendering.md. Requirements and pre-decisions
for any future build are recorded in
.scratch/visual-chat-v1/issues/15-html-hatch-security-model.md (sandboxed iframe +
header CSP + MessageChannel bridge from a second token-free port; never
sanitize-into-host-DOM; frame network never; data-starved frames).

## Considered Options

- Free-form HTML hatch (sanitizer + sandboxed iframe + CSP) — rejected: hardest
  boundary in the system, built before evidence of need.
- Structured components only — rejected: the prior project consistently hit the ~5%
  free-form need; SVG's isolation is already proven and cheap to port.
