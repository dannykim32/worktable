# Visual Chat

A framework + plugin that gives a terminal-based LLM agent a local browser surface
for rendering rich, interactive, honest visual artifacts.

## Language

**Canvas**:
The local browser surface where artifacts render. A companion to the terminal agent,
not a chat client — the terminal remains the conversation driver.
_Avoid_: chat page, UI, frontend

**Agent Host**:
The existing terminal agent harness (e.g. Claude Code) that owns the conversation,
model transport, tool loop, and permissions. This project plugs into it.
_Avoid_: chatbot, backend

**Canvas Server**:
The local service (an MCP server) that receives artifacts from the Agent Host,
enforces every boundary, and serves the Canvas to the browser. The single last
boundary before the browser.
_Avoid_: renderer daemon, backend

**Artifact**:
One visual unit the agent publishes to the Canvas (a diagram, dashboard, design doc,
sketch). Artifacts represent real underlying content and must tell a true story.
_Avoid_: widget, page, output

**Component Artifact**:
An artifact the agent composes as structured data, drawn by the trusted component
vocabulary. The default; the agent never authors its markup, so there is nothing
to sanitize.
_Avoid_: template, layout

**Component Vocabulary**:
The fixed set of trusted, project-owned components a Component Artifact may compose.
_Avoid_: component library (implies third-party UI kits)

**Free-form Artifact**:
An artifact whose markup the agent authors directly (SVG only in v1), rendered
exclusively under Image Isolation. The escape hatch for expressiveness the
Component Vocabulary cannot reach.
_Avoid_: raw HTML, custom artifact

**Image Isolation**:
The rendering posture where agent-authored markup is displayed as an inert image,
making script execution impossible by construction rather than by filtering.
_Avoid_: sandboxing (reserved for iframe/CSP mechanisms)

**Ask-back**:
A selection-anchored question the human sends from the Canvas into the agent's
conversation — e.g. select a paragraph or region of an artifact and ask about it.
_Avoid_: comment, feedback, reply

**Anchor**:
The precise reference an Ask-back carries to what the human selected — the artifact,
its version, and the region, element, or text span the question is about.
_Avoid_: context, highlight

**Version**:
One retained revision of an Artifact. Updates replace the visible content but never
discard prior Versions; Anchors bind to a specific Version.
_Avoid_: revision, snapshot

**Legibility Gate**:
The deterministic check a Free-form Artifact must pass before rendering: no text
overlap, no text straddling shape edges, nothing clipped or sub-legible. Judges
readability only — truth stays with Logical Fidelity.
_Avoid_: quality gate (too broad), truth gate

**Repair Round**:
The single bounded retry after a Legibility Gate failure, where the agent receives
the gate's exact coordinate-bearing findings. A second failure becomes Honest
Absence.
_Avoid_: retry loop

**Logical Fidelity**:
The truth doctrine: an artifact may abstract and consolidate, but may never tell an
untrue story about the underlying content.
_Avoid_: accuracy (implies literal completeness)

**Review Moment**:
An agent-opt-in checkpoint where the agent blocks awaiting Canvas feedback on a
specific Artifact; times out into the ordinary Ask-back queue. Used for explicitly
visual judgments, never after every publish.
_Avoid_: approval gate, pause

**Honest Absence**:
The agent declining to render something it cannot render truthfully, stating the
reason instead of fabricating. A first-class outcome, never an error.
_Avoid_: failure, refusal (in the error sense)
