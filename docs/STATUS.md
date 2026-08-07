# Worktable — Status & Milestone History

The running project log. This is the cold-start / resume document: a fresh session
(agent or human) can read this file plus `CONTEXT.md` and the map in `README.md` and
pick up work without any prior conversation context.

**Standing rule: whoever merges to `main` updates the Status section below in the same
change.** The public front door is `README.md`; this file is where the always-current
state lives.

## Status (updated 2026-08-07) — v0.7.0: installable as a Claude Code plugin

- **Two-line install** via a self-hosted GitHub marketplace:
  `/plugin marketplace add dannykim32/worktable` then
  `/plugin install worktable@worktable`. The plugin bundles the MCP server + the
  ask-back hook (paths via `${CLAUDE_PLUGIN_ROOT}`), and ships the guidance as a
  model-invoked skill (`skills/worktable/SKILL.md`) since a plugin's CLAUDE.md
  isn't auto-loaded.
- A committed **`bundle/`** (runnable subset of `dist/`) makes the plugin work the
  moment Claude Code clones the repo — no build. Server paths are name-agnostic
  (`../canvas`, `../hooks/…`) so one built layout serves as `dist/` (tarball) and
  `bundle/` (plugin). `package:release` refreshes both so they ship identical bytes.
- The tarball / `install.sh` path is unchanged as the firewalled fallback. `claude
  plugin validate` passes. 267 tests.
- **QA to confirm on real use (dogfood):** the guidance is now a model-invoked skill
  instead of always-on CLAUDE.md — verify the agent still reaches for the canvas by
  default on a "walk me through this" prompt with only the plugin installed.

## Status (updated 2026-08-07) — v0.6.1: export renders markdown + anchor links

- The standalone export now **renders markdown** (prose artifacts AND conversation
  answers) instead of showing raw source — headings, lists, code, tables, links.
- Markdown parsing was extracted to a shared DOM-free AST (`src/shared/markdown.ts`):
  **one parser, two emitters** — the canvas builds DOM (`prose.ts`, behavior
  unchanged, prose-renderer tests byte-identical), the export builds an escaped HTML
  string (`src/server/markdownHtml.ts`, whitelisted tags only, XSS-tested). They can't
  drift.
- The exported **conversation links back to the content**: entries are numbered with
  bidirectional static `#fragment` anchors to a `[N]` marker at the anchored block
  (prose artifacts; html entries show the quote but get no in-content marker — a
  static file can't safely splice into verbatim model HTML). Browser-verified: renders
  formatted, marker click jumps to the entry. 253 tests.
- **Now installable as a Claude Code plugin** via a self-hosted marketplace
  (`.claude-plugin/{plugin,marketplace}.json`) that ships a committed `bundle/` +
  the guidance as `skills/worktable/SKILL.md`. Server paths are name-agnostic
  (sibling-relative), so `dist/` (tarball) and `bundle/` (plugin) run the same file.
  The tarball/`install.sh` path is unchanged as the firewalled fallback. (coordinator
  to finalize this section for the release.)

## Previous status (2026-08-06) — v0.6.0: paste images into ask-backs

- **Paste a screenshot into the composer** and it rides the ask-back to the
  agent: uploaded (`POST /api/askbacks/image`, magic-byte sniffed — png/jpeg/
  gif/webp only, 5MB cap, 128-bit id, 0600 at rest), previewed as a drawer
  thumbnail, and delivered to the terminal agent via `check_askbacks` as an MCP
  **image content block** (`_mcpContent` passthrough) so the model actually
  sees it (renders as an inline image in Claude Code). The token never enters
  an `<img src>` — thumbnails fetch with a bearer and render from a same-origin
  `blob:` URL.
- Browser-verified end to end (chip + entry thumbnails render, image block
  reaches a real MCP client). Found + fixed a CSP gap the 227 unit tests
  missed: the canvas `img-src` lacked `blob:`, so real-browser thumbnails were
  blocked though happy-dom passed — added `blob:` and a canvas-CSP regression
  test.

## Previous status (2026-08-06) — v0.5.10: export + no scroll-jump

- **Asking a question no longer yanks the page.** Submitting confirmed the
  in-frame marker with a scroll+highlight (meant for explicit locate clicks),
  which pulled the page toward the top. Submit now DRAWS the marker only
  (`focusMarker` gained a `scroll` flag, default true; submit passes false);
  `highlightEntry` scrolls the drawer LIST, not the page. Explicit
  entry-click locate still scrolls. Browser-verified: scrollY held at 89 across
  select→ask→submit; the locate click still moved it.
- **Standalone HTML export** (card ⋯ menu): "Export HTML" and "Export HTML +
  conversation" download a single self-contained file — the artifact plus,
  optionally, the Q&A appendix — that opens in any browser with no server and
  no agent. Static by construction: a `default-src 'none'` meta CSP inertizes
  scripts exactly like the live frame, every text field is HTML-escaped
  (7 XSS cases tested), and the token never enters a shareable link (blob
  download). Browser-verified opening the file from disk.

## Previous status (2026-08-06) — v0.5.9: canvas-aware listener exits

- **Closing the canvas tab stops nothing** (by design — the tab is a view; the
  server rides the agent session, and killing the listener per tab-close would
  waste an agent wake on every refresh). Instead the listener's exit is now
  INFORMED: every await timeout carries `canvas_open` (a live tab holds an SSE
  stream), and the CLI's budget-expiry message states the fact — page open →
  re-arm; page closed → rest. No more guessing whether the human walked away.
- Found + fixed a runtime-parity bug while testing it: bun's http server never
  fires `res.on("close")` on client disconnect (node does), so the bun-run
  test server kept counting closed SSE clients. Both the SSE hub and the await
  route's unpark now hook response AND socket close, idempotently. The test
  helper's SSE client also moved to fetch+AbortController (bun's node:http
  client shim never closes the TCP connection on destroy).

## Previous status (2026-08-06) — v0.5.8: bare install is the whole install

- **`./install.sh` (no arguments) now installs everything user-wide**: MCP
  registration, the guidance block into `~/.claude/CLAUDE.md`, and the ask-back
  hook into `~/.claude/settings.json` (`register.mjs --user`). Every repo gets
  canvas behavior with zero per-repo ceremony; the hook is silent in repos with
  no canvas workspace. Re-running upgrades the guidance in place. The repo
  argument remains for repo-local copies (teammates) and stale-block migration.

## Previous status (2026-08-06) — v0.5.7: write plainly + guidance upgrades propagate

- **Anti-slop writing rules for generated pages** (owner call, after a
  dogfooded artifact opened with manufactured stakes): working documentation,
  not a thriller — no fabricated stakes, dramatic fragments, colon reveals, or
  importance puffery; open on the substance. Added to the guidance snippet
  (both copies), the publish_artifact description, and the design doctrine's
  "lead with the claim" (which had been read as "write a tagline").
- **`register.mjs --guidance` now UPGRADES an existing block in place** —
  previously a marker hit was a no-op, stranding every registered repo on the
  guidance from its first install; updates never propagated. Re-running
  install.sh on a repo now refreshes its guidance.

## Previous status (2026-08-05) — v0.5.6: conversation polish

- **Answers can no longer widen past the pane.** `.drawer-entry-a` is a flex
  row, and the answer column's default `min-width:auto` let a wide code line
  push the entry beyond the drawer. Now `min-width:0` + `overflow-wrap:
  anywhere` on the answer column, `overflow-x:hidden` on the list, and
  `overflow:hidden` on the panel — wide code scrolls INSIDE its own block.
  Browser-verified against a hostile-width answer.

## Previous status (2026-08-05) — v0.5.5: conversation polish

- **Composer grows downward**: a textarea (Enter sends, shift+Enter newlines,
  auto-sized to a 160px cap) replaces the horizontally-scrolling one-line input.
- **Follow up** button under every answered drawer entry: reopens the composer
  with that entry's exact anchor, so the next question threads to the same
  selection; a fresh "Ask about this" from the artifact replaces the composer
  context wholesale (tested — no stale drafts or mixed anchors).
- Browser-verified: composer 35px → 108px on a four-line question; follow-up
  opens with the right quote. 196 tests green.

## Previous status (2026-08-05) — v0.5.4: dogfood round two (M11)

Same-day fixes from live dogfooding, all end-to-end verified in a real browser:

- **The drawer actually hides now.** `.drawer { display:flex }` (an author rule)
  was overriding the UA's `[hidden]` — the panel had been visible since page load
  and the × was a no-op. A global `[hidden] { display:none !important }` reset
  restores the contract for all 22 `.hidden` call sites. The toggle is a fixed
  **edge tab** (collapsible from anywhere, rides the drawer edge, Escape works),
  and cards size against their container (94%, not vw) so the open drawer
  narrows the column instead of covering it.
- **Drag-resizable drawer** — a grip writes `--drawer-w`, so panel + tab + body
  reflow follow together; width clamps [280, min(720, 92vw)] and persists.
- **Answers render as markdown** via the trusted prose pipeline (compact
  bullets/code/links) instead of one textContent blob.
- **One listener arming now listens ~45 min** (inner 240s polls loop under a
  budget; ListenerPark debounces the indicator across poll gaps). Dogfood had
  shown the agent giving up after three quiet 4-minute windows exactly while an
  artifact awaited the human's decisions; exit copy now biases re-arming.
- **Clickable external references**: anchor clicks inside the sandboxed frame
  are intercepted by the trusted prelude and routed over the bridge as the
  closed `openlink` verb; the parent independently validates (bounded, strictly
  http/https) and opens a new tab with `noopener,noreferrer` — the frame never
  navigates itself. Prose renders markdown links/autolinks/#fragments.
- **One topic, one artifact.** The workspace persists across sessions, and a
  fresh session couldn't see what was already published — so it republished
  topics and the human got near-duplicate cards. New read-only `list_artifacts`
  tool + publish/update bias: revise the matching artifact, publish new only
  for a new topic or on explicit request. (Canvas-side artifact deletion /
  curation is backlog.)
- Guidance: Terms section near the TOP; markdown-formatted `answer_askback`;
  link your references; listener re-arm bias. 193 tests green.

## Previous status (2026-08-05) — v0.5.0: the poll-wake listener (M10)

**The keystroke constraint is dissolved.** The terminal agent can now arm a
**listener** — `node dist/hooks/await-askback.js` run as a backgrounded Bash job.
The server parks the long-poll (`GET /api/askbacks/await`, token-gated, strictly
read-only over the queue, 8-waiter cap) and resolves it the instant a canvas
question arrives; the exiting job makes the Agent Host re-invoke the agent, which
answers with full conversation context — no keystroke. The canvas shows an honest
delivery state: while a listener is parked, the drawer banner says the agent is
listening; otherwise it still asks for a terminal nudge. The `UserPromptSubmit`
hook remains as the fallback path. (Mechanism proven in the owner's earlier
git-reviewer project; one brain, no spawned answerers.)

Alongside it (same release): the canonical guidance snippet was rebuilt — it had
drifted to pre-pivot content — and now leads with canvas-by-default publish
heuristics, the listener arm/re-arm protocol, and the **less-is-more glossary
convention** (a compact "Terms" section for coined/never-agreed terms only);
`register.mjs` substitutes the install path into the listener command; tool
results nudge arming/re-arming with a ready-to-run command. 166 tests green.

## Previous status (2026-08-04) — open-source prep

The product is at its core value: **the model's native artifact-design quality,
rendered on a local page you can select-and-ask-back on.** The artifact surface is
exactly three types — **`html`** (primary: a self-contained, sandboxed, model-authored
HTML/CSS/SVG page), **`prose`** (a long markdown answer), and **`absence`** (Honest
Absence). The agent authors html artifacts with the artifact-design skill's process
but publishes them here (for the ask-back loop), not to the host's native artifact
tool.

The full loop works: agent publishes versioned artifacts to a capability-gated local
canvas; the human sends selection-anchored ask-backs home — including from *inside* a
model-authored HTML page; Claude Code gets an ask-back auto-inject hook plus an
agent-opt-in `request_review` Review Moment. 154 tests green on `main`.

**Open-source release prep: MERGED to `main` (2026-08-04).** Renamed `visual-chat` →
**Worktable** ("Purview" was tried and dropped — Microsoft Purview collision); MIT
LICENSE; dependency advisories cleared (`bun audit` clean); README rewritten as a
public front door; git history rewritten to drop the AI-attribution trailer (the old
v0.1.0 release/tag, which preserved pre-rewrite history, was deleted). Remaining
before the repo flips public: rename the GitHub repo to `worktable`, cut a fresh
release tarball, and capture a README screenshot.

Deferred by design: HTML hatch **Tier 2** (live model JavaScript — Tier 1 static HTML
is built), Slate dark mode, native MCP Apps hosting.

**Retired 2026-08-04 (ADR-0012):** the structured Component Vocabulary (document /
dashboard / compare), the free-form `svg` type, and everything that existed only for
svg — the SVG sanitizer, the legibility gate, calibration, the repair round, and the
gate-mode config/panel (~9,250 LOC). Superseded by the iframe-isolated hatch. This
retired **M3–M5** and **ADR-0009 / ADR-0011**, which remain for historical record.

## Milestone history

- **M1 — walking skeleton: DONE, merged, human-verified.** MCP server (stdio) +
  capability-URL canvas on 127.0.0.1; versioned artifact store + SSE; Document +
  absence renderers; ask-back queue with anchors; demo + E2E.
- **M2 — Dashboard + Compare: DONE, merged, both review axes passed.** Single-axis
  bar/line + stat tiles; two-pane compare. Points capped at 200/series. *(Retired in
  M8.)*
- **Visual identity: "Slate", light-only** — cool near-white ground, deep teal as the
  lead/brand color, slate ink, a distinct green/red semantic pair (redundantly encoded
  by +/- glyph + labels). No dark mode yet (a labeled later increment). Theme lives in
  `src/canvas/styles.css`.
- **M3 — SVG sanitizer + image-isolated SVG type: DONE, merged, security review
  passed.** Zero-dep reject-not-drop sanitizer (16 hostile fixtures + 10k fuzz), SVG
  rendered only as inert `<img>` data: URL. *(Retired in M8.)*
- **Security drill (2026-07-15): passed.** An owner-run cookie-exfil injection into the
  sanitizer worktree was contained at every layer, nothing merged. See
  `docs/security/red-team-drills.md`.
- **M4 — legibility gate (report-only) + calibration gallery: DONE, merged.** Four
  geometry checks over the sanitizer AST; report-only was structural (fail-open).
  *(Retired in M8.)*
- **Calibration rounds 1–2 (2026-07-15): PASSED — owner sign-off.** All four checks
  trustworthy; 9px on-screen floor confirmed. Evidence under `docs/history/qa/`.
- **M5 — gate enforcement + bounded repair round: DONE, merged.** Human-only
  enforcement, fail-open, fail → one repair round → honest absence. Also fixed a latent
  `listTools()` failure (bare-oneOf inputSchema) that blocked spec-compliant MCP hosts.
  *(Retired in M8.)*
- **M6 — Claude Code hook + `request_review`: DONE, merged.** `UserPromptSubmit` hook
  auto-injects pending ask-backs via a read-only peek route that never drains the
  queue; `request_review` is an agent-opt-in blocking Review Moment.
- **M7 — HTML hatch Tier 1 + reply-loop/doctrine + Slate: DONE, merged, adversarially
  reviewed (issue 25).** Free-form model-authored *static* HTML served verbatim from a
  second 127.0.0.1 origin into a `sandbox="allow-scripts"` iframe (no
  `allow-same-origin`) under a header CSP (nonce'd prelude so model scripts are inert),
  with a MessageChannel bridge and select-and-ask-back from *inside* the page. A
  zero-dep, hostile-fixture `frameGuard` **reject-not-drops** no-click egress at ingest
  (found→fixed→re-verified clean across 84 adversarial cases). Tier 2 (live model JS)
  deferred, labeled.
- **M8 — retire the structured vocabulary; the HTML hatch is the surface: DONE, merged
  (issue 26, ADR-0012).** Deleted document / dashboard / compare / `svg` + the entire
  svg-only apparatus (~9,250 LOC). Surface is now `{html, prose, absence}`; the exposed
  schema is flat (a `type` enum, which tool-use fills reliably — a prior top-level
  `oneOf` made the model emit the wrong type).
- **M9 — ask-back side drawer + in-content anchor markers: DONE, merged (issue 27).** A
  right-side **drawer** (composer + a quote-tagged conversation); the artifact column
  reflows so nothing is hidden. Each question drops an **anchor marker** with
  **click-to-locate both ways** — parent-drawn for prose, drawn by the frame prelude
  and synced over the bridge for html. Bridge stays a closed, schema-validated verb set
  (token never crosses — canary retained). 154 tests green.

## Known follow-ups (non-blocking)

- Prose relative / in-page-anchor links render as literal text (allowing safe
  `#fragment` links is a clean win); prose deep-blockquote depth cap (hardening).
- The html hatch's inert/CSP-blocks and cross-frame MessageChannel invariants are
  proven structurally (served bytes + CSP header + direct handler calls); one
  real-browser confirmation is worth doing before heavy real-world use.
- **Deferred, labeled:** HTML hatch **Tier 2** (live model JavaScript — needs deeper
  isolation; carries a forged-ask-back residual documented in issue 25); Slate dark
  mode; native MCP Apps hosting.
- A current screenshot/GIF of an `html` artifact + ask-back for the README (the only
  captured images are of the retired renderers, now under `docs/history/qa/`).

## Backlog

Future product ideas live outside the tracker; ask the owner. (The glossary
convention, the listener, and the guidance-level nudging all shipped in v0.5.0;
deeper nudging — packaging Worktable as a Claude Code plugin/skill so intent
matching pulls the canvas in proactively — remains open.)
