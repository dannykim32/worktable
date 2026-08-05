# 08 — Compare component

Status: done
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

## Comments

2026-07-14 — done. Schema added verbatim to the publish/update tool union
(src/server/validate.ts: exactly 2 panes via minItems/maxItems, ≤500
lines/pane, mark enum "add"|"del"|null, additionalProperties:false on
pane and line), mirrored in the hand validator with JSON-path rejections
at the tool boundary (1/3/0 panes → /panes; 501 lines → /panes/1/lines;
bad mark → .../mark). Renderer (src/canvas/components/compare.ts) is a
pure DOM function behind the registry seam: pane header + monospace <pre>
of block-level line spans, all text via textContent; add/del background
tints come from the prototype theme, added to styles.css as --add-bg /
--del-bg in both schemes. Grid is 1fr 1fr with a max-width:699px media
query, so panes are side-by-side at ≥700px and stacked below. Lines carry
data-line-index for future pane/line anchors.
Tests: +8 in test/compare-renderer.test.ts (boundary rejections incl.
pane count and line cap, golden before/after fixture, empty pane,
all-marked pane, XSS canary); suite 79 pass.
AC4 + light/dark verified by headless-Chromium captures of the real
renderer+stylesheet: docs/qa/m2-compare-light.png and
docs/qa/m2-compare-dark.png (960px, side-by-side); a 520px capture was
inspected during QA and shows the panes stacked.

2026-07-14 — m2-compare screenshots re-captured after the user-directed
brand palette update (vanilla page + burnt orange accent); add/del tints
unchanged and still distinct on the new vanilla-tinted surfaces.

2026-07-14 — committed light-only identity (user direction): dark mode
removed. Compare's add/del tints (--add-bg/--del-bg) are unchanged and
still read clearly on the warm surfaces; pane heads pick up the vanilla
inset. AC4/legibility now a single-theme check — only
docs/qa/m2-compare-light.png remains (dark PNG deleted).
