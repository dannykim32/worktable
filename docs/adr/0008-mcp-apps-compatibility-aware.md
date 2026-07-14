# V1 is MCP Apps (SEP-1865) compatibility-aware, not native

Landscape research (docs/research/local-canvas-landscape.md) found MCP Apps stable
in the MCP spec since 2026-01-26 — it standardizes server-published UI resources,
sandboxed host rendering, and a UI→host channel — but no terminal host renders it.
V1 keeps its own typed tools and component schema, with the artifact envelope and
ask-back channel deliberately shaped to map 1:1 onto MCP Apps resources (stable
artifact URI, content/template separation, message-channel-shaped ask-backs); the
mapping is documented so native adoption is a later milestone, not a rewrite.
Native adoption now was rejected because it means implementing both sides of a spec
no host speaks and front-loading iframe/postMessage plumbing; ignoring the spec was
rejected because a proprietary format is the weakest position if the ecosystem
standardizes (open-design or Anthropic are one shipped feature away from this
niche). Note MCP Apps does not conflict with ADR-0002: Apps templates are
server-authored (trusted component code); the model still emits only structured data.
