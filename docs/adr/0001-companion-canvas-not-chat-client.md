# The browser surface is a companion canvas, not the chat client

The README's original vision described the HTML page as "the interface for the user
to interact with the LLM," but we decided the terminal agent host (e.g. Claude Code)
remains the conversation driver and the browser is a companion artifact canvas with a
selection-anchored ask-back channel. Rebuilding a chat client (streaming, interrupts,
permission prompts, session lifecycle) is a large project orthogonal to this one's
actual value — the rendering boundary and artifact quality — and the core motivation
("ask about a specific paragraph") needs only the ask-back channel, not a
browser-resident chat.

## Consequences

- The framework owns exactly two flows: agent → canvas rendering, and canvas → agent
  ask-backs.
- The ask-back channel is a write path into the LLM conversation, so the prior
  project's "browser endpoints may be unauthenticated" rule must be re-examined
  before it is adopted here.
