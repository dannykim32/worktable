# 08 — Compare component

Status: ready-for-agent
Type: task
Milestone: M2
Blocked by: 04

## Context

ADR-0007 vocabulary. Reference: prototype's "Ask-back delivery: before / after" card —
two labeled panes of monospace lines with add/del highlighting.

## Implementation Details

Schema:

```jsonc
{ "type": "compare", "title": "string",
  "panes": [ // exactly 2
    { "label": "string",
      "lines": [ { "text": "string", "mark": "add"|"del"|null } ] } ] } // ≤500 lines/pane
```

Renderer: side-by-side ≥700px, stacked below; pane header, monospace body,
add/del background tints from the prototype theme. Line text via textContent.

## Acceptance Criteria

1. Golden fixture renders two panes with correct add/del tinting.
2. Panes ≠ 2 or >500 lines → schema rejection at the tool boundary.
3. XSS canary line renders literally.
4. Narrow viewport stacks panes (manual check).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit (jsdom) | renderer + fixtures incl. empty pane, all-marked pane | +4 |

## Effort

~2h.

## Out of Scope

Computed diffs (the agent supplies marks), syntax highlighting, >2 panes.
