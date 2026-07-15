# 06 — Walking-skeleton E2E + Claude Code registration

Status: done
Type: task
Milestone: M1
Blocked by: 05

## Context

M1's definition of done: the full loop demonstrably works from a real Claude Code
session, and a programmatic E2E test locks it against regression.

## Implementation Details

**Registration:** `docs/setup.md` with the `.mcp.json` snippet:

```json
{ "mcpServers": { "visual-chat": { "command": "node",
    "args": ["<abs path>/dist/server/index.js"] } } }
```

**Agent guidance:** append an `## Visual Chat` section to this repo's AGENTS.md (and
document the same block in docs/setup.md for other projects): when to publish
artifacts vs answer in text, call `check_askbacks` at the start of every turn, honest
absence doctrine (decline with reason via the `absence` type — never fabricate), and
"showing N of M" bounding for large inputs.

**Demo script:** `scripts/demo.ts` — speaks MCP over stdio to a spawned server:
publishes a 6-block document, updates it to v2, prints the canvas URL, then polls
check_askbacks every 2s printing anything that arrives (manual half of the demo).

**E2E test:** spawn server subprocess; over real stdio MCP: publish → assert HTTP GET
shows v1 → update → assert v2 + v1 both readable → POST ask-back with anchor (direct
HTTP, simulating the browser) → check_askbacks returns it → second check empty.
No headless browser in v1 tests (DOM covered by 04's jsdom tests; visual QA manual).

## Acceptance Criteria

1. E2E test green in `bun test` (single test file, <30s, no network beyond loopback).
2. Following docs/setup.md verbatim in a fresh Claude Code session: asking the agent
   to "publish a short design note to the canvas" results in a rendered document at
   the tokened URL (manual walkthrough, recorded as a checklist in the doc).
3. Ask-back typed in the browser reaches the agent after a terminal nudge (manual).
4. `scripts/demo.ts` runs the scripted half unattended and exits 0.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| E2E | the full-loop test above | +1 |

## Effort

~3h: 1h docs + guidance text, 1h demo script, 1h E2E test.

## Out of Scope

Hook installation (13), any new server/canvas features.

## Comments

Criterion 1 (E2E test) and 4 (scripts/demo.ts, verified exit 0 unattended with a
short VISUAL_CHAT_DEMO_TIMEOUT_MS) are implemented and green. Criteria 2 and 3 are
manual walkthroughs an agent cannot perform — docs/setup.md carries the verbatim
checklist; manual verification is PENDING THE HUMAN. Mitigation: the same loop was
exercised programmatically (E2E over real stdio MCP + loopback HTTP) and once in
headless Chromium during issue 05 (real selection → pill → composer →
check_askbacks). AGENTS.md gained the ## Visual Chat guidance section; the demo
script prefers dist/ and falls back to bun + src for unbuilt checkouts.
