# 27 — Ask-back side drawer with in-content anchor markers

Status: ready-for-agent
Type: feature (canvas UX)
Milestone: M9

## Why

Today's ask-back composer is a popover that COVERS the very text you're asking
about, and answers thread inline as collapsible markers — no persistent, natural
conversation view. Owner-chosen fix (2026-08-04): a **right-side drawer** holding
the composer + the whole conversation, with the canvas reflowing narrower so
nothing is hidden, and **in-content anchor markers** with click-to-locate both
ways (the Google-Docs-comments model). This answers the multi-part worry: many
questions read as a quote-tagged threaded list, each locatable in the page.

## The model

- A toggleable **drawer** on the right of the canvas. When open, the artifact
  column reflows (gets right margin / flex shrink) so it is never occluded.
- The drawer holds: a **composer** (appears when the human starts a question,
  pre-filled with the selected quote) and a scrollable **conversation list**.
  Each entry = the selected quote (what it's about) + the question + the agent's
  answer (or a pending state: "replies on the agent's next terminal turn").
- **Markers + locate.** Each asked question places a marker at its anchored
  location. Click a drawer entry → the page scrolls to and highlights that marker;
  click a marker → its drawer entry highlights/scrolls into view. Bidirectional.
- This **consolidates** three things that exist today into the drawer: the
  parent composer popover (`askback.ts`), the in-frame composer box (the prelude
  in `frameShell.ts`), and the inline reply threads (`replies.ts`). The "Ask
  about this" pill stays as the trigger; the composer + conversation move to the
  drawer.

## Two rendering paths (the key wrinkle)

- **prose / absence artifacts** render in the PARENT DOM. Markers + highlight are
  drawn directly by the parent; selection is read directly. No bridge.
- **html artifacts** render in a CROSS-ORIGIN sandboxed iframe. The parent cannot
  touch the frame DOM, so the **frame prelude** (trusted, nonce'd) renders the
  in-frame markers, reads selection, and scrolls/highlights on request; it talks
  to the parent drawer over the existing MessageChannel bridge.

## Bridge protocol additions (keep it a CLOSED, schema-validated verb set)

Frame → parent (over the port, in addition to existing `resize`/`askback`):
- `{ v:"askstart", quote, markerId }` — the human clicked "Ask about this"; the
  parent opens the drawer composer pre-filled with `quote`, tracking `markerId`.
Parent → frame (in addition to the one-time `port` transfer):
- `{ v:"focusMarker", markerId }` — scroll to + highlight that marker in the frame.
Rules unchanged: identity via `event.source === iframe.contentWindow`; the
capability token NEVER crosses; validate every inbound verb; drop anything else.
The prelude assigns `markerId`s (e.g. a counter) and keeps a map markerId→Range so
it can re-highlight; a marker persists once a question is asked for that range.

## Flow

1. Human selects text (prose: in the page; html: in the frame) → "Ask about
   this" pill appears (as today).
2. Click the pill → (prose) the parent opens the drawer composer with the quote;
   (html) the prelude sends `askstart{quote,markerId}` and the parent opens the
   drawer composer. The composer is in the DRAWER — it never covers the content.
3. Human types the question in the drawer, hits send → POST `/api/askbacks`
   (unchanged; ADR-0010, the one write channel). A marker is placed at the anchor
   (prose: parent draws it; html: the prelude draws it, confirmed over the bridge)
   and a drawer entry appears in the "pending" state.
4. Agent answers via `answer_askback` → SSE `askback_answered` → the parent fills
   the drawer entry's answer in place (replacing the pending state).
5. Locate: drawer-entry click → (prose) parent scrolls/highlights; (html) parent
   sends `focusMarker{markerId}`. Marker click → parent highlights the drawer entry.

## Keep / constraints

- Ask-backs still flow only through `/api/askbacks`; answers via `answer_askback`
  → SSE. No new browser→agent channel (ADR-0010 holds).
- The pending-state copy stays honest: an idle terminal agent replies on its next
  terminal turn (issue: the human must submit a terminal turn; the hook delivers).
- Model-authored strings reach the parent DOM via `textContent` only.
- The prelude stays trusted + nonce'd; the frame CSP/sandbox is unchanged.
- Works with multiple artifacts on the canvas and multiple questions per artifact.
- Respects `prefers-reduced-motion` for the reflow/scroll/highlight animations.

## Acceptance criteria

- [ ] Asking a question never covers the selected content; the composer is in the
      drawer and the artifact column reflows when the drawer is open.
- [ ] The drawer lists every Q&A for the canvas, each showing its quote; answers
      fill in live via SSE; pending entries show the honest terminal-turn copy.
- [ ] In-content markers appear at each asked location; click-to-locate works both
      directions for BOTH prose (parent-drawn) and html (frame-prelude-drawn over
      the bridge).
- [ ] Bridge stays a closed verb set: `askstart`/`focusMarker` are schema-checked;
      unknown verbs and wrong-source messages are dropped; token never crosses
      (canary test).
- [ ] `bun run build` + `build:standalone` succeed; `bun test` green (update/replace
      the askback/replies tests for the drawer; keep the bridge-auth + canary tests).
- [ ] The old inline reply-thread and the two separate composers are removed/folded
      into the drawer (no dead UI left).

## Out of scope

- Live-JS interactivity in the frame (Tier 2). Dark mode. Reordering/threading
  beyond the quote-tagged flat list.
