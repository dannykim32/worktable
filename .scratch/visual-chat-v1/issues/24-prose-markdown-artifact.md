# 24 — Prose/markdown artifact: render long responses as a rich, ask-able webpage

Status: done
Type: task
Milestone: post-v1 (the "render my response" use case)
Blocked by: 04

## Context

The pain: long agent responses (Opus-5-class) become an unreadable terminal wall,
hard to scan and hard to ask about a specific part. The fix: the agent publishes its
response as MARKDOWN and the canvas renders it richly (headings, lists, code, emphasis,
links, tables) — a navigable webpage you can select-and-ask-back on (issue 22 already
gives inline answers). Agents already write markdown, so this makes "render my whole
answer" nearly frictionless.

CRITICAL: this is a TRUSTED-renderer Component Artifact, NOT the free-form HTML hatch
(ADR-0002). The markdown is untrusted model text, but it is rendered by our OWN
markdown→DOM renderer using createElement/textContent ONLY — never innerHTML, never
raw-HTML passthrough, no scripts. It opens no HTML hole. Do NOT add a markdown library
(marked/markdown-it emit HTML strings → innerHTML → XSS; against our zero-dep-security
+ textContent invariants). Build a small own parser, in the spirit of the SVG sanitizer.

## Implementation

**Artifact type (server):** add `prose` to the publish/update schema union in
`src/server/validate.ts` — `{ type: "prose", title, markdown: string }`, markdown ≤ a
bounded max (e.g. 100KB). Keep the top-level inputSchema `{type:"object", oneOf:[...]}`
MCP-spec-compliant (the M5 fix). The legibility gate does NOT apply (svg-only). Store /
version like other artifacts.

**Safe markdown renderer (canvas — `src/canvas/components/prose.ts`):** an own-built,
ZERO-DEP parser + DOM builder for a practical markdown subset. Supported: ATX headings
(#..######), paragraphs, bold (**/__), italic (*/_), inline code (`), fenced code
blocks (``` with optional lang label), unordered + ordered lists (with nesting),
blockquotes (>), links [text](url), GFM tables, horizontal rules (---), hard line
breaks. Rendering rules (the security spine):
- Every text node via textContent; every element via createElement. NO innerHTML /
  insertAdjacentHTML / template-into-DOM anywhere.
- Links: validate the href against a protocol ALLOWLIST (http, https, mailto only).
  Anything else (javascript:, data:, vbscript:, relative-with-colon tricks) → render
  as plain text, NOT an <a>. Add rel="noopener noreferrer" and target as appropriate.
- Raw HTML in the markdown (`<script>`, `<img onerror>`, any `<tag>`) is NOT parsed as
  HTML — it renders as literal escaped text.
- Markdown images `![](url)` — SKIP for v1 (render the alt text as plain text; visuals
  go through the svg artifact). Keeps the surface small.
- Unclosed/malformed markdown degrades gracefully (render as text), never throws out
  of the renderer.
Plug into the component registry like the other renderers; match the warm theme
(issue 23 vars) — code blocks use --code-bg, links use a warm accent, etc.

**Ask-back on prose:** selecting text in a rendered prose artifact must produce an
ask-back (the whole point — "ask about this section"). Anchor with the quote (and a
rendered-element index or null block_index — the quote is the durable anchor). Confirm
the existing composer + inline-answer (issue 22) work on prose artifacts.

**Guidance (docs/agent-guidance.md + this repo's AGENTS.md):** add that when a
response is long or structured (multiple sections, a comparison, would be a terminal
wall of text), the agent should publish it to the canvas as a `prose` artifact (send
the markdown) and give a TERSE terminal pointer ("published to the canvas — read it
there, ask about any section"), rather than dumping the full text in the terminal.
Keep the existing "structure beats prose → publish" guidance.

## Acceptance Criteria

1. `publish_artifact { type:"prose", title, markdown }` validates + stores; the
   inputSchema stays MCP-spec-compliant (listTools still works, tools still 7).
2. The renderer handles the full supported subset (a golden fixture with headings,
   bold/italic/code, a fenced block, nested lists, a blockquote, a table, a link, an
   hr) → correct DOM structure (jsdom/happy-dom test).
3. **XSS canaries (blocking):** markdown containing `<script>alert(1)</script>`, raw
   `<img src=x onerror=alert(1)>`, `[x](javascript:alert(1))`, `[y](data:text/html,...)`
   → NO script/img/element created, the javascript:/data: link renders as plain text
   (not an <a>), everything appears as literal text. Assert `querySelectorAll("script,img")`
   empty and no `<a href^="javascript">`.
4. Link protocol allowlist: http/https/mailto → real <a>; everything else → plain text.
5. Malformed markdown (unclosed code fence, dangling `[`, etc.) renders without throwing.
6. Ask-back works on a prose artifact: select text → composer → check_askbacks returns
   the anchored quote; an inline answer (issue 22) renders on it.
7. Guidance updated in docs/agent-guidance.md + AGENTS.md.
8. Zero new deps; warm theme respected; `bun test` green.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Server | prose schema validate/reject; store/version; MCP inputSchema still valid | +4 |
| Canvas (jsdom) | golden subset render; XSS canaries (script/img/js-link/data-link/raw-html); link allowlist; malformed graceful; ask-back on prose | +8 |

## Out of Scope

Animations / interactive scripted content (that's the deferred HTML hatch, issue 15 —
a separate decision). Markdown images (v1 renders alt text only). A full CommonMark
implementation (a practical subset is the contract). GitHub-flavored task lists,
footnotes, math — add later if needed.

## Comments

Done. Shipped the `prose` artifact type end to end.

**Server (`src/server/validate.ts`, `src/shared/artifacts.ts`):** added a `prose`
branch to the schema `oneOf` and the hand validator — `{ type, title, markdown }`,
markdown bounded at 100KB (`MARKDOWN_MAX`), unknown fields rejected with a JSON path,
title 1..200. `publishArtifactSchema` stays `{ type:"object", oneOf:[...] }`, so
listTools is unchanged (still 7 tools) and MCP-spec-compliant. The legibility gate is
untouched (svg-only): `prepareContent` special-cases only `svg`, so prose stores and
versions like any other artifact.

**Renderer (`src/canvas/components/prose.ts`):** own-built, zero-dep markdown→DOM
builder. Block parser (fenced code w/ lang, ATX headings h1–h6, hr, blockquote w/
recursion, GFM tables, nested ordered+unordered lists, paragraphs w/ hard breaks) +
an inline scanner (code spans opaque, then image→alt-only, link, strong, emphasis).
Security spine: `createElement` + `textContent`/`createTextNode` ONLY — no innerHTML
anywhere, so raw HTML in the markdown is literal text for free. Links pass through a
`safeHref` protocol allowlist (http/https/mailto absolute only; control chars and
schemeless/relative URLs rejected → literal text). Every top-level block gets a
`data-block-index` so ask-back's `closestBlock` anchors a selection to a section.
`renderProse` never throws — a parse failure degrades to the raw markdown as text.

**Ask-back:** confirmed `anchorFromRange` produces a quoted anchor from a selection in
a rendered prose block, and issue-22 `ReplyThreads` mounts an inline answer under it.

**Docs:** `docs/agent-guidance.md` + `AGENTS.md` now tell the agent to publish long /
multi-section responses as `prose` with a terse terminal pointer.

**Tests:** +5 server (`test/artifact-validation.test.ts`) and +8 canvas
(`test/prose-renderer.test.ts`, including all XSS canaries). Full suite green: 315
pass / 0 fail across 28 files. Both tsconfigs typecheck clean. Zero new deps.

**Judgment calls:**
- Headings render as real `h1`–`h6` (the document component down-shifts to h3/h5;
  prose is a full "webpage", so the natural mapping fits better, sized down in CSS).
- The link allowlist is strict: only absolute http/https/mailto become `<a>`.
  Schemeless/relative URLs (`/path`, `#anchor`, protocol-relative) render as literal
  text — the safest reading of "allowlist http/https/mailto only", and it closes
  colon-obfuscation tricks structurally. Revisit if relative links are wanted later.
- A bare `---` after a paragraph renders as a thematic break (hr), not a setext H2
  (setext headings are out of the supported subset).
- Disallowed-scheme links render the WHOLE literal `[text](url)` construct (not just
  the label) so nothing is silently hidden — matches "everything appears as literal
  text".

## Known minor / follow-ups (from review 2026-08-03, non-blocking)
- **Relative + in-page anchor links render as literal text.** The href allowlist is
  http/https/mailto only, so `[jump](#section)` and site-relative links show as ugly
  literal `[text](url)`. Common in long structured answers (TOCs). In-page `#fragment`
  links are safe (same-page jumps) — allowing those specifically is a clean UX win.
- **Deep-blockquote stack overflow degrades via try/catch.** A pathological single-line
  blockquote of ~100k `>` recurses parseBlocks and hits RangeError; it's CAUGHT and
  degrades to literal text (~1s, nothing escapes, spec-compliant). Add a defensive
  blockquote-depth cap so it degrades cleanly instead of relying on catching a stack
  overflow — hardening, not a vulnerability.
