# Ask-backs are queued and pulled, with an optional host hook for seamless delivery

MCP servers cannot inject user messages into a host's conversation, so ask-backs
cannot be pushed. The Canvas Server queues anchored ask-backs; the portable core is
a check_askbacks tool the agent is instructed to call at the start of every turn
(the user nudges the terminal to trigger delivery), and on Claude Code an optional
UserPromptSubmit hook auto-appends pending ask-backs to the user's next message,
removing the ritual. A blocking wait_for_askback long-poll was rejected as the
primary mechanism because it holds the agent's turn open, burns idle context, and
fights host turn models; clipboard hand-off was rejected because it abandons the
structured anchor that makes ask-backs worth having.

## Amendment (2026-07-14): a third, agent-opt-in blocking mode

Landscape research (mcp-feedback-enhanced, 3.8k★) showed the blocking-tool pattern
is well-accepted in practice, and the original "holds the turn hostage" objection
dissolves when blocking is a deliberate review checkpoint rather than the default.
Added: request_review(artifact_id, timeout) — the agent calls it only when feedback
on a visual is the explicit next step. Terminal shows "waiting on canvas review"
(Esc interrupts); the canvas shows a review banner with anchored-comment and
approve controls; timeout degrades gracefully into the normal queue. The queue
remains the single source of truth — blocking is a live subscription to it, and
making it the primary mode after every publish remains rejected (forces
browser-watching, fights the companion-canvas flow).
