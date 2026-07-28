# 22 — Inline canvas answers: close the ask-back loop in the browser

Status: ready-for-agent
Type: task
Milestone: post-v1 (UX)
Blocked by: 05

## Context

Today an ask-back travels browser→agent (POST /api/askbacks → queue →
check_askbacks), and the agent answers in the TERMINAL. But the human asked in the
BROWSER, so the loop doesn't close where they are. This adds an agent→browser answer
that renders inline near the anchored selection.

Direction note: this does NOT violate ADR-0010 (the ask-back queue stays the only
browser→AGENT write channel). Answers flow agent→browser via SSE, the same direction
artifact pushes already use. This DOES add one MCP tool (answer_askback) — that is
fine (it is not the gate-mode surface issue 12 forbids); the exact-tool-count test
moves from 6 to 7 and the no-gate/config/mode-tool assertion STAYS.

## Implementation

**Store:** an ask-back gains an optional `answer` ({ text, answered_at }). Persist it
alongside the queue entry (askbacks.jsonl). The answer does not change the ask-back's
delivered state.

**MCP tool `answer_askback({ askback_id, answer })`:** the agent calls it to answer a
specific ask-back it received from check_askbacks. Validates the id exists; stores the
answer; emits an SSE `askback_answered` event `{ askback_id, artifact_id, version }`.
Returns the stored record. (The agent still answers in the terminal too — this tool is
the extra step to also surface it in the canvas.)

**SSE:** new `askback_answered` event on the existing /api/events stream.

**Canvas:**
- The canvas must now TRACK the ask-backs the human submitted (it currently fires and
  forgets with an optimistic "sent"). On submit, keep the returned ask-back id + its
  anchor locally.
- A read path so answers survive reload: `GET /api/askbacks/answered` (bearer,
  read-only) returning answered ask-backs for this workspace (id, anchor, question,
  answer). The canvas loads these on boot and renders them.
- Render: a small reply thread anchored to the artifact the question was about — under
  the selected block for a block-anchored ask-back, or on the artifact card for a
  whole-artifact one. Shows the question (the human's) + the answer (the agent's),
  visually distinct (e.g. the answer indented/marked as the agent's reply). All text
  via textContent/createElement — NO innerHTML (the answer is agent-authored text,
  treat as untrusted display text).
- On live SSE `askback_answered`, the reply appears without reload.
- Keep it unobtrusive: a subtle "1 reply" affordance that expands, not a wall of text.

**Docs:** update docs/agent-guidance.md — after answering an ask-back in the terminal,
the agent may also call answer_askback so the reply shows in the canvas.

## Acceptance Criteria

1. answer_askback stores the answer, emits SSE, returns the record; unknown id → tool
   error, nothing stored.
2. listTools() returns exactly 7 tools now (the 6 + answer_askback); the no-self-grant
   assertion (no tool matches gate|config|mode|enforce|setting) still passes.
3. A block-anchored ask-back's answer renders under that block/artifact; a
   whole-artifact one renders on the card. textContent-only (XSS canary: an answer of
   `<img src=x onerror=...>` renders as literal text).
4. Live: with the canvas open, answer_askback → the reply appears via SSE, no reload.
5. Reload persistence: GET /api/askbacks/answered returns answered items; the canvas
   re-renders them on boot.
6. GET /api/askbacks/answered is bearer-gated (401 without token).
7. The existing ask-back submit + check_askbacks + hook flows are unchanged
   (regression); the pending peek route still doesn't mark delivered.
8. `bun test` green; zero new deps.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit/integration | answer_askback store+SSE+unknown-id; answered read route + 401; listTools=7 + no-gate-tool | +6 |
| Canvas (jsdom) | reply renders under anchor; live SSE append; XSS canary; boot re-render | +4 |

## Out of Scope

Threaded multi-turn conversation on an anchor (one question → one answer for v1).
Editing/deleting answers. Notifying the terminal FROM the browser (that's the existing
ask-back direction, unchanged).
