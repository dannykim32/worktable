# 12 — Gate enforcement + bounded repair round

Status: ready-for-agent
Type: task
Milestone: M5
Blocked by: 11

## Context

ADR-0007 failure path: ONE bounded repair round with the gate's exact findings;
second failure = honest absence. Enforcement is gated behind calibration sign-off —
a human decision, never automatic.

## Implementation Details

**Activation:** `<dir>/config.json` gains `"gate": "report" | "enforce"` (default
`report`). Flipped manually by the human (documented in docs/setup.md: review
/calibration precision first). A `set_gate_mode` MCP tool is NOT provided — the agent
must not be able to grant itself or remove enforcement (one-way trust decision).

**Enforce path on svg publish/update:**
1. Findings present → tool returns `{ gate: "failed", findings: […verbatim…],
   repair_hint }` and nothing is stored. The response instructs: fix ONLY the listed
   geometry; one repair attempt remains.
2. Server tracks attempts keyed by (artifact_id or provisional publish token): a
   second failing submission within the same repair context → server converts the
   submission to an `absence` artifact: title preserved, reason = "Failed the
   legibility gate twice" + findings summary. Tool response says exactly that.
3. A passing submission clears the repair context.

## Acceptance Criteria

1. In `report` mode behavior is identical to issue 11 (regression suite).
2. In `enforce`: failing SVG → findings returned verbatim, nothing stored.
3. Resubmission that fixes findings → publishes normally; context cleared.
4. Second failing resubmission → absence artifact exists with findings summary; tool
   response labels it honest absence, not an error.
5. Repair context survives server restart (persisted), expires after 1h.
6. No MCP tool can change gate mode (attempted tool call list asserted in test).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Integration | the 4-step enforce flow, restart persistence, expiry | +6 |

## Effort

~4h.

## Out of Scope

Auto-flip based on precision thresholds (human decides), gate changes to components.
