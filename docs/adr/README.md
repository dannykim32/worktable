# Architecture Decision Records

Numbered, immutable records of the decisions that shaped Worktable — each with the
context, the choice, and the alternatives that were rejected. A superseded record
gets a status banner at the top and stays put; the decision trail is the point.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-companion-canvas-not-chat-client.md) | The canvas is a companion to the terminal agent, not a chat client | Active |
| [0002](0002-no-freeform-html-in-v1.md) | V1 artifacts are structured components + an SVG hatch; no free-form HTML | Superseded by 0012 |
| [0003](0003-mcp-server-as-the-spine.md) | An MCP server is the spine between agent host and canvas | Active |
| [0004](0004-askback-queue-plus-pull-with-hook.md) | Ask-backs queue; a host hook delivers them on the next terminal turn | Active |
| [0005](0005-capability-url-for-all-canvas-endpoints.md) | Every canvas endpoint is gated by a capability URL | Active |
| [0006](0006-versioned-in-place-artifacts.md) | Artifacts update in place and retain every version | Active |
| [0007](0007-vocabulary-doc-dash-compare-svg-diagrams.md) | The v1 vocabulary is Document + Dashboard + Compare; svg owns diagrams | Superseded by 0012 |
| [0008](0008-mcp-apps-compatibility-aware.md) | Stay compatibility-aware with MCP Apps, without hosting on it | Active |
| [0009](0009-one-clean-register-badged-provenance.md) | One clean aesthetic register; provenance is badged, not styled | Retired by 0012 |
| [0010](0010-askback-is-the-only-door.md) | The ask-back queue is the only browser→agent write channel | Active |
| [0011](0011-gate-mode-human-settable-live.md) | Legibility-gate mode is a live, human-only setting | Retired by 0012 |
| [0012](0012-html-hatch-is-the-surface.md) | The HTML hatch is the surface; the structured vocabulary is retired | Active |
