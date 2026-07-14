# The ask-back queue is the single browser→agent channel

All component interactivity (hover tooltips, collapse/expand, version scrubbing,
table sorting) is client-local and invisible to the agent; the only browser→agent
write channel is the ask-back queue (which also carries Review Moment responses).
This is a standing invariant: any future feature that wants to send anything from
the canvas to the agent must either go through the ask-back queue or explicitly
amend this ADR. Chosen so there is exactly one surface to authenticate, rate-limit,
and reason about (deny-by-default stays meaningful), and so the agent's context
never fills with interaction telemetry. Interaction telemetry and app-like stateful
components were rejected for v1: a second write surface multiplies the security
story, and when the user wants the agent to know something, an anchored ask-back
says it better.
