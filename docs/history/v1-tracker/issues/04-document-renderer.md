# 04 — Document component renderer + gallery shell

Status: done
Type: task
Milestone: M1
Blocked by: 03

## Context

The canvas's trusted renderer (CONTEXT.md: Component Vocabulary). Reference rendering:
prototype/canvas-vocabulary/PROTOTYPE-canvas-mock.html (judged 2026-07-14) — match its
gallery layout, card chrome, and light/dark behavior. ADR-0009: one clean register;
provenance is badged. ADR-0010: all interactivity client-local.

## Implementation Details

**Shell** (`src/canvas/main.ts` + modules): header (title, workspace id, connection
dot fed by SSE state), vertical artifact gallery from `GET /api/artifacts`, live
updates via `/api/events`. Each card: title, type badge, version chip with ‹ › scrubber
(loads `/api/artifacts/:id/v/:n`; viewing an old version shows a "viewing v2 of 5"
marker), relative timestamp.

**Component interface** (the library-swap seam, settled 2026-07-14):

```ts
type ComponentRenderer = (content: ArtifactContent, mount: HTMLElement) => void
// registry: Record<ArtifactType, ComponentRenderer>
```

Renderers are pure DOM-building functions — no framework, no state, no innerHTML for
any model-influenced string (textContent / createElement only). This interface is the
contract a future dedicated visual library must fit behind.

**Document renderer**: one function per block kind (heading/paragraph/callout/code/
table/list) matching the prototype's styling. `absence` renderer: distinct card showing
the reason, styled as a first-class outcome, never as an error banner.

**Theme**: CSS custom properties + `prefers-color-scheme`, values lifted from the
prototype.

## Acceptance Criteria

1. Publishing each block kind renders it; a golden-fixture document containing all six
   kinds matches expected DOM structure (test via jsdom or DOM snapshot).
2. A block whose text is `<img src=x onerror=alert(1)>` renders as visible literal text
   (XSS canary — the string must appear via textContent).
3. update_artifact live-updates the open page within 1s without reload; scrubbing back
   shows v1 content and the viewing marker.
4. `absence` artifact renders title + reason with its own badge.
5. Page works with JS-memory token flow from issue 02 (reload via tokened URL works).
6. Light and dark render legibly (manual check, screenshot both).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit (jsdom) | each block renderer, XSS canary, absence card | +8 |
| Integration | SSE-driven live update, version scrub fetch | +2 |

## Effort

~5h: 2h shell + SSE wiring, 2h block renderers + theme, 1h tests.

## Out of Scope

Ask-back UI (05), other artifact types (07/08/10), version diffing UI.

## Comments

Shell (src/canvas/main.ts, gallery.ts, api.ts) + renderers (components/document.ts,
absence.ts) behind the ComponentRenderer registry seam; theme lifted verbatim from the
prototype's custom properties. SSE runs over fetch (EventSource cannot attach the
bearer). Dev-dependency justification: the issue's testing plan calls for jsdom-style
DOM tests; happy-dom (dev-only, never shipped) was used instead of jsdom for bun-test
compatibility — same role, XSS canary is meaningful (it parses innerHTML, and the
canary asserts the hostile string stays literal text with no <img> created).
Criterion 6 verified via headless Chromium screenshots in both schemes (dark forced by
re-applying the stylesheet's @media-dark rules); both legible, matching the prototype.
10 unit + 2 integration tests added.

Review follow-up: the criterion-6 screenshots are now committed as the verification
record — docs/qa/m1-light.png and docs/qa/m1-dark.png (document with all block kinds
+ an absence card, connected header, version chip, card menu).
