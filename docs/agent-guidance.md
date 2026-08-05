# Agent guidance snippet

Drop the block below into any repo's `AGENTS.md` or `CLAUDE.md` to make the agent
use the worktable canvas proactively. `scripts/register.mjs --guidance` appends
exactly this block; the `<!-- worktable-guidance -->` marker comments let it detect
an existing copy and stay idempotent (do not remove or edit the markers).

Everything between the markers (inclusive) is the copy-paste payload:

<!-- worktable-guidance -->
## Worktable

A companion canvas is available via the worktable MCP tools. The terminal stays
the conversation driver; the canvas renders artifacts.

- Call `check_askbacks` at the START of every turn. It returns questions the human
  anchored to specific artifacts, versions, and text spans — answer them with the
  anchor's context, and prefer updating the same artifact. (On Claude Code with the
  ask-back hook installed, pending questions are auto-appended to your prompt; the
  `check_askbacks` call is still what marks them delivered.)
- After you answer an ask-back in the terminal, you may also call `answer_askback`
  with its `askback_id` and your answer. Your reply then shows inline on the canvas,
  threaded under the selection the human asked about, so the loop closes where they
  asked. It appears live and survives a reload; it does not re-deliver the ask-back.
- Publish an artifact (`publish_artifact`) when structure beats prose: design notes,
  comparisons, tabular data, multi-section explanations. Answer in plain text when a
  sentence or two suffices.
- When a response would be a terminal wall (long, multi-section, a big explanation),
  publish it as `type: "prose"` with your answer as `markdown`, then leave a TERSE
  terminal pointer ("published to the canvas — read it there, ask about any section")
  instead of dumping the full text. The canvas renders the markdown richly (headings,
  lists, code, tables, links) and the human can select any part to ask a follow-up.
- Update artifacts in place (`update_artifact`) rather than republishing: the
  artifact keeps its identity and readers keep version history.
- Honest absence: if you cannot render something truthfully (too large, not enough
  data, would require guessing), publish `type: "absence"` with the reason. Never
  fabricate a visual.
- Bound large inputs: render a truthful subset and say so in the artifact itself
  ("showing 20 of 5,471"), or decline with an absence artifact.
<!-- /worktable-guidance -->
