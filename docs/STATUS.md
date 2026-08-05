# Worktable — Status & Milestone History

The running project log. This is the cold-start / resume document: a fresh session
(agent or human) can read this file plus `CONTEXT.md` and the map in `README.md` and
pick up work without any prior conversation context.

**Standing rule: whoever merges to `main` updates the Status section below in the same
change.** The public front door is `README.md`; this file is where the always-current
state lives.

## Status (updated 2026-08-04) — open-source prep

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

Future product ideas live outside the tracker; ask the owner. The nearest one on deck:
a **self-surfacing glossary** section inside an html artifact — the model lists the
terms/phrases it introduced with a one-line plain meaning, so the reader can grasp and
audit its vocabulary without a back-and-forth (same thesis as the canvas, applied to
language).
