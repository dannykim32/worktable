# The plugin is an MCP server that owns the local canvas service

The agent host integrates via a single MCP server (stdio) that both exposes the
artifact tools and runs the 127.0.0.1 canvas server the browser connects to.
Component Artifacts are the JSON arguments of typed tools, so the structured-intent
boundary is enforced by JSON Schema validation at the MCP layer before project code
runs. Chosen over a host-specific plugin (hooks), a CLI, or a bare HTTP API for
portability across MCP hosts and for the free schema enforcement; the accepted cost
is that MCP cannot push into the conversation, so ask-back delivery needs its own
design (see ADR on ask-back delivery).

## Considered Options

- Claude Code-specific plugin (hooks + skills) — richest ask-back injection, but
  ties the framework to one host. Kept as an optional enhancement layer, not the spine.
- CLI invoked via Bash / bare HTTP API — host-agnostic but loses typed-tool schema
  enforcement, the mechanism that makes the safe default self-validating.
