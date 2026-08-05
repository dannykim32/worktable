# Worktable — Domain Glossary

The shared language of the project. Use these exact terms in code, tests, and prose;
avoid the listed synonyms. This file is a glossary and nothing else — no
implementation details, no status. For architecture decisions see `docs/adr/`.

The artifact surface is exactly three types: **`html`**, **`prose`**, and
**`absence`**. Terms for the retired structured-component system are collected in
**Retired terms** at the bottom, for reading old commits and ADRs only — none of
them describe the current product.

## Core

**Canvas**
The local browser surface where artifacts render. A companion to the terminal agent,
not a chat client — the terminal remains the conversation driver.
_Avoid_: chat page, UI, frontend

**Agent Host**
The existing terminal agent harness (e.g. Claude Code) that owns the conversation,
model transport, tool loop, and permissions. Worktable plugs into it.
_Avoid_: chatbot, backend

**Canvas Server**
The local service (an MCP server) that receives artifacts from the Agent Host,
enforces every boundary, and serves the Canvas to the browser. The single last
boundary before the browser.
_Avoid_: renderer daemon, backend

**Artifact**
One visual unit the agent publishes to the Canvas. Every artifact represents real
underlying content and must tell a true story (see Logical Fidelity).
_Avoid_: widget, page, output

**HTML Artifact** (`html`)
The primary artifact type: a self-contained, model-authored HTML/CSS/SVG page. The
agent authors it with the artifact-design skill's process and publishes it here for
the ask-back loop, rather than to the host's native artifact tool. Rendered under
Frame Isolation — never trusted into the Canvas DOM.
_Avoid_: raw HTML (undersells the isolation), custom artifact

**Prose Artifact** (`prose`)
A long markdown answer, rendered by the project's own zero-dependency markdown→DOM
renderer. For substance that reads better as text than as a picture.
_Avoid_: message, text blob

**Frame Isolation**
The rendering posture for an HTML Artifact: the model's markup is served verbatim
from a second `127.0.0.1` origin (the **Frame Origin**) into a
`sandbox="allow-scripts"` iframe — never `allow-same-origin` — under a
header-delivered CSP whose `script-src` is a per-response nonce the model never
sees. Script execution and network egress are impossible by construction, not by
filtering. The capability token lives only in the parent origin and never enters
the frame.
_Avoid_: sandboxing (too vague), sanitizing (this is isolation, not scrubbing)

**Egress Boundary** (`frameGuard`)
The zero-dependency, reject-not-drop check an HTML Artifact must pass at ingest: any
no-click network-egress construct (`<meta http-equiv>`, hint/external `<link>`)
rejects the whole artifact rather than being silently stripped — a stripped artifact
could tell a different story than the one that was reviewed.
_Avoid_: sanitizer, filter

**Ask-back**
A selection-anchored question the human sends from the Canvas into the agent's
conversation — select a span or region of an artifact and ask about it, including
from inside an HTML Artifact.
_Avoid_: comment, feedback, reply

**Anchor**
The precise reference an Ask-back carries to what the human selected — the artifact,
its Version, and the region or text span the question is about.
_Avoid_: context, highlight

**Version**
One retained revision of an Artifact. Updates replace the visible content but never
discard prior Versions; an Anchor binds to a specific Version.
_Avoid_: revision, snapshot

**Review Moment**
An agent-opt-in checkpoint where the agent blocks awaiting Canvas feedback on a
specific Artifact, timing out into the ordinary Ask-back queue. For explicitly
visual judgments, never after every publish.
_Avoid_: approval gate, pause

## Doctrine

**Logical Fidelity**
The truth doctrine: an artifact may abstract and consolidate, but may never tell an
untrue story about the underlying content.
_Avoid_: accuracy (implies literal completeness)

**Honest Absence** (`absence`)
The agent declining to render something it cannot render truthfully, stating the
reason instead of fabricating. A first-class outcome, never an error.
_Avoid_: failure, refusal (in the error sense)

## Retired terms (historical — not part of the current product)

These named the structured-component system removed in ADR-0012 (2026-08-04). They
survive only so old commits and superseded ADRs remain readable. Do not use them in
new code, tests, or docs.

- **Component Artifact / Component Vocabulary** — the trusted `document` /
  `dashboard` / `compare` components the agent composed as structured data. Replaced
  by the HTML Artifact.
- **Free-form Artifact / Image Isolation** — the `svg`-only escape hatch rendered as
  an inert `<img>` data URL. Replaced by Frame Isolation for HTML.
- **Legibility Gate / Repair Round** — the deterministic text-geometry check and its
  single bounded retry that a Free-form Artifact had to pass. Removed with the `svg`
  type.
