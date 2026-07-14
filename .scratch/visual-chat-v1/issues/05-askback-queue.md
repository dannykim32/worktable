# 05 — Ask-back queue, anchors, composer, check_askbacks

Status: ready-for-agent
Type: task
Milestone: M1
Blocked by: 04

## Context

The core README motivation. ADR-0004: queue + pull is the portable fabric. ADR-0010:
this queue is the ONLY browser→agent channel. CONTEXT.md: an Anchor is artifact +
version + region/span.

## Implementation Details

**Anchor model:**

```jsonc
{ "artifact_id": "a_…", "version": 3,
  "block_index": 4,            // document blocks; null for whole-artifact
  "char_start": 12, "char_end": 96,   // optional, within the block's text
  "quote": "string ≤300 chars" }      // always present — survives content drift
```

**Canvas UI:** text selection inside a document block → floating "Ask about this"
pill (prototype pattern) → composer popover showing the quote + a text input.
Submit → `POST /api/askbacks` (bearer) with `{ anchor, question }` → optimistic
"sent — reaches the agent next turn ✓" state. A whole-artifact ask affordance (card
⋯ menu → "Ask about this artifact") covers non-text anchors until SVG region anchors
(post-v1).

**Server:** append to `<dir>/askbacks.jsonl` as
`{ id, anchor, question, state: "pending", created_at }`. States: pending → delivered.
Reject questions >2000 chars or missing anchor (400).

**MCP tool `check_askbacks`:** returns all pending (anchor + question + quote +
artifact title), marks them delivered atomically (rewrite jsonl via tmp+rename). Empty
queue → `{ askbacks: [] }` with a hint string the agent can relay ("no pending
questions from the canvas").

## Acceptance Criteria

1. Select text in a v3 document → ask → check_askbacks returns anchor with version 3,
   correct block_index/char range, and exact quote.
2. After update_artifact to v4, an ask-back submitted while viewing v3 (via scrubber)
   carries version 3, not 4 (ADR-0006 anchor pinning).
3. check_askbacks twice: second call returns empty (delivered marking persisted).
4. Queue survives server restart (jsonl reread; pending items still pending).
5. POST without bearer → 401; oversized question → 400 with reason.
6. Composer is keyboard-usable (Enter submits, Esc closes).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | anchor capture from a Range (jsdom), jsonl state transitions | +5 |
| Integration | full POST→check_askbacks→redelivery-empty cycle; restart persistence | +3 |

## Effort

~5h: 2h canvas selection/composer, 1.5h server+tool, 1.5h tests.

## Out of Scope

Claude Code hook (13), request_review (14), SVG region anchors (post-v1).
