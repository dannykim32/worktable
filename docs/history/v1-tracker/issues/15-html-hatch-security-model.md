# 15 — Free-form HTML hatch: security model (research + pre-decisions)

Status: ready-for-human
Type: research
Milestone: future (fills the labeled slot in ADR-0002 — build only if the pilot
gallery proves Component Vocabulary + SVG cannot express something needed)

## What this ticket holds

The security research for the deferred free-form HTML hatch, plus the pre-decisions
made 2026-07-15. The research INFORMS the build-it/don't-build-it decision; it does
not make it. Evidence source (committed alongside this ticket):

- docs/research/safe-llm-html-rendering.md — full cited report
- docs/research/safe-llm-html-rendering.HANDOFF.md — TL;DR + decision-relevant findings

## Bottom line (from the report — validated, not revised)

The current default stands: Component Artifacts + free-form SVG under Image
Isolation are the two safest rungs. If the hatch is ever built:

- Sandboxed iframe: `sandbox="allow-scripts allow-forms allow-modals"` — NEVER
  `allow-same-origin` (spec-documented total escape; must be structurally
  impossible, not linted).
- Header-delivered CSP (`default-src 'none'; connect-src 'none'; form-action
  'none'`) — CSP3 ignores sandbox/frame-ancestors in <meta> delivery, and an
  opaque-origin sandbox WITHOUT this CSP still has full one-way network exfil
  (no-cors fetch, img beacons).
- MessageChannel bridge: identity via `event.source === iframe.contentWindow` +
  transferred port (opaque origin serializes as "null" — event.origin is useless);
  schema-validated closed verb set; capability token never crosses.
- NEVER sanitize-and-inject into the host DOM: DOMPurify's own threat model
  disclaims exfil protection, mXSS bypasses recur yearly, and a bypass would
  execute in the Canvas origin next to the capability token. Prior art (VS Code
  webviews, Observable, Claude artifacts, ChatGPT Apps) converges on the iframe +
  origin-split + CSP shape; Jupyter, which renders into its own DOM, forbids
  scripts entirely.

## Pre-decisions (human, 2026-07-15 — binding on any future hatch build)

1. **Frame network access: never.** CSP stays `default-src 'none'; connect-src
   'none'`. Anything an artifact needs crosses the bridge host-side,
   schema-validated (consistent with ADR-0010). A consented per-artifact
   allowlist was rejected.
2. **Self-navigation exfil residual: accept + data-starve.** The frame receives
   ONLY the artifact's own content over the bridge — never workspace data, never
   the token — so navigation can only leak what the artifact already displays.
   Residual documented in the threat model; wrapper app rejected (ADR-0001).
3. **Serving: second 127.0.0.1 port, token-free routes.** Real origin split +
   header CSP delivery; unguessable artifact IDs gate the routes; no frame-scoped
   token (a token inside a compromised-content frame is a leak vector). srcdoc
   rejected (meta CSP can't deliver sandbox/frame-ancestors).

## Reconciliation with parallel work

The report's "src/sanitizer/ should stay empty" was written against an inferred
sanitize-HTML-into-host-DOM plan. The actual `src/sanitizer/` (issue 09, M3) is
the **SVG** boundary whose output renders exclusively as an inert `<img>` data:
URL (Image Isolation) — the mechanism the report itself endorses. No conflict:
the DOMPurify warning applies to the future HTML hatch only, where this ticket's
pre-decisions already forbid the host-DOM approach.

## Open items (resolve during any hatch build)

- Empirically test whether `<meta http-equiv=refresh>` fires inside a sandboxed
  frame (spec-ambiguous); strip it in the shell either way.
- PROPOSED (not yet ruled): any Component Vocabulary addition or URL-protocol
  allowlist change requires a new ADR — gives the growth ratchet an owner (the
  ADR process). Confirm or replace when it first matters.
