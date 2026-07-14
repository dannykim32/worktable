# 10 — SVG artifact type via image isolation

Status: ready-for-agent
Type: task
Milestone: M3
Blocked by: 09

## Context

ADR-0002 (SVG is the escape hatch), CONTEXT.md Image Isolation (render only as an
inert image — impossible-by-construction, not filtered), ADR-0009 (provenance badge +
standing caption instead of sketch styling).

## Implementation Details

Schema addition: `{ "type": "svg", "title": "string", "svg": "string ≤256KB" }`.

Publish path: `sanitizeSvg()` → on `ok: false`, the tool returns the violations
verbatim (agent can fix or decline; nothing stored). On ok, store the SANITIZED
string only — the original input is discarded, never persisted.

Render path: `data:image/svg+xml` URL (encodeURIComponent) in an `<img>` — never
inline SVG, never an iframe. Card chrome: badge `svg · free-form` (visually distinct
from component badges) + standing caption below the image: "Depicts the idea, not the
exact code — drawn by the model, shown as an inert image."

CSP from issue 02 already allows `img-src data:`; no CSP change needed.

## Acceptance Criteria

1. Valid SVG publishes, renders as `<img src="data:image/svg+xml,…">` (asserted in
   jsdom: element IS an img, no inline `<svg>` in the document).
2. Hostile SVG → tool error listing violations; `GET /api/artifacts` shows nothing.
3. Stored `v<N>.json` contains the re-serialized form, byte-different from a
   deliberately messy-but-benign input (proves re-serialization happened).
4. Badge + caption present on every svg card.
5. XSS end-check: publish a benign SVG containing `<text>alert probe</text>`, assert
   no dialog/script execution possible (img isolation asserted structurally).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit (jsdom) | render-as-img assertion, badge/caption | +3 |
| Integration | publish valid + hostile over MCP | +2 |

## Effort

~2.5h.

## Out of Scope

Legibility gate (11), region-anchored ask-backs on SVG (post-v1).
