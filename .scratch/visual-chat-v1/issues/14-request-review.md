# 14 — request_review blocking tool + review banner

Status: done
Type: task
Milestone: M6
Blocked by: 05

## Context

ADR-0004 amendment: agent-opt-in Review Moment (CONTEXT.md) — the agent blocks
awaiting canvas feedback on a specific artifact; timeout degrades into the ordinary
queue; the queue stays the single source of truth (ADR-0010: approvals travel as
ask-backs).

## Implementation Details

**MCP tool** `request_review({ artifact_id, timeout_s?: number })` — timeout clamped
to [30, 600], default 180. Long-polls the queue for any ask-back anchored to that
artifact (any version). Resolution:
- Feedback arrives → returns it (same shape as check_askbacks items) AND marks it
  delivered. Approval arrives → `{ approved: true }`.
- Timeout → `{ timed_out: true, hint: "feedback will arrive via check_askbacks" }` —
  a normal result, not an error.

**Canvas:** SSE event `review_requested {artifact_id}` → banner on that card: "agent
is waiting for your review" + [Looks good — continue] button. Approve POSTs an
ask-back `{ anchor: {artifact_id, version, block_index: null}, question: "",
kind: "approval" }` (kind field added to the ask-back schema; default "question").
Banner clears on SSE `review_resolved` (sent on resolution OR timeout).

**Terminal ergonomics:** tool description tells the agent to say "review on the
canvas — waiting there" in its text before calling, and that Esc interrupts safely
(interrupted call = queue keeps the feedback for the next check_askbacks).

## Acceptance Criteria

1. Approve click resolves a blocked request_review in <1s with `{approved: true}`.
2. Anchored question resolves it with the question + anchor; item marked delivered.
3. Timeout returns `{timed_out: true}`; feedback submitted after timeout appears in
   the next check_askbacks (nothing lost).
4. Banner appears on request and clears on resolution and on timeout.
5. Ask-backs on OTHER artifacts do not resolve the wait (but stay queued).
6. Two concurrent request_review calls on different artifacts resolve independently.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Integration | resolve-by-approval, resolve-by-question, timeout, cross-artifact, concurrency | +6 |

## Effort

~4h.

## Out of Scope

Making blocking the default after publish (rejected in ADR-0004), multi-artifact
review sessions.

## Comments

Done. `request_review({artifact_id, timeout_s?})` clamps the timeout to
[30,600] (default 180) and long-polls the queue via a new in-memory
`ReviewCoordinator` (src/server/reviews.ts): a blocked call registers one waiter
for the artifact; the POST /api/askbacks handler calls `reviews.onAskback` after
every append, waking exactly one matching waiter. No busy-spin — a single waiter
+ a single unref'd timer, both torn down on whichever fires first. On entry it
also checks already-queued feedback so a pre-existing ask-back resolves
immediately.

Resolution: an anchored question returns `{askback: <check_askbacks item>}` and
is marked delivered synchronously inside the POST stack (so a concurrent
check_askbacks can't also drain it); an approval returns `{approved:true}`; a
timeout returns `{timed_out:true, hint}` (a normal result, not an error) and
leaves the queue untouched so the feedback still arrives via check_askbacks.

The queue stays the single browser->agent channel (ADR-0010): approvals travel
as ask-backs with the new `kind:"approval"` field (added to the schema, default
"question"; approvals carry an empty question). No new endpoint. Canvas: SSE
`review_requested{artifact_id}` shows a banner ("agent is waiting for your
review" + "Looks good — continue"); approve POSTs the approval ask-back; the
banner clears on SSE `review_resolved` (sent on both resolution and timeout).

A test seam (`VISUAL_CHAT_REVIEW_MIN_S`) lowers the floor so the timeout path
runs in ~1s. Tests (+6, all green): resolve-by-approval (<1s), resolve-by-
question (+ delivered), timeout (+ later feedback reaches check_askbacks),
cross-artifact isolation (other-artifact ask-back doesn't resolve but stays
queued), two concurrent reviews resolve independently, banner lifecycle. Full
suite: 235 pass. AC1–6 satisfied. Committed as feat(14).
