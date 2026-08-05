# 25 — Free-form HTML hatch: BUILD (Tier 1, rich static HTML)

Status: ready-for-agent
Type: feature
Milestone: M7
Fills: the labeled slot in ADR-0002; implements the pre-decisions in issue 15.

## Why now (evidence)

Dogfooding produced two findings: (a) our structured/prose artifacts render long
answers as a wall of text — no bespoke layout, no earned diagrams; (b) a parallel
Opus 5 session, given the same job with full model-authored HTML, produced exactly
the page the owner wanted. That page was **static HTML + CSS + SVG** (its own
process notes: "self-contained — no external JS"); its motion was CSS/SVG. So the
proven need is rich *static* HTML authorship. Live model JS was NOT the thing that
made it good, and it carries a distinct residual (below) — so it is Tier 2, not
this ticket.

## Scope of Tier 1

A new artifact type `html` whose body is a full model-authored HTML document,
served **verbatim** (never sanitized-into-host-DOM — ADR-0002, issue 15) into a
sandboxed, strict-CSP iframe from a **second 127.0.0.1 port**, with the model's
own scripts **neutralized** and a **trusted, nonce'd capture prelude** that gives
the page select-and-ask-back — the thing cloud artifacts can't do.

Explicitly OUT of scope (Tier 2, do not build here): running model-authored
JavaScript. See "Tier 2 residual" at the end.

## Binding security model (from issue 15 pre-decisions — non-negotiable)

1. **Second 127.0.0.1 port, real origin split.** A distinct HTTP listener (the
   "frame origin") serves ONLY html-artifact documents. Same 127.0.0.1 bind +
   Host allowlist / DNS-rebinding defense as the main server (`src/server/http.ts`).
   The main canvas page embeds the frame from this second origin. srcdoc is
   rejected (a `<meta>` CSP cannot deliver `sandbox`/`frame-ancestors`).
2. **Token-free frame routes, gated by an unguessable slug.** The frame routes
   carry NO capability token (a token inside possibly-hostile content is a leak
   vector). Gate each document by a **fresh 128-bit random slug** per artifact
   version — NOT the short display id `a_[0-9a-f]{8}` (32 bits is too guessable
   for a token-free route). Slug → (artifactId, version) lives server-side only.
3. **Header-delivered CSP on the document response** (CSP3 ignores sandbox/
   frame-ancestors/report-uri in `<meta>`):
   `default-src 'none'; script-src 'nonce-<per-response-random>'; style-src
   'unsafe-inline'; img-src data:; font-src data:; connect-src 'none';
   form-action 'none'; base-uri 'none'; frame-ancestors 'self'`.
   - `script-src 'nonce-…'` blocks ALL model scripts (they carry no nonce; strip
     any `nonce=` attribute from model HTML before serving) while allowing OUR
     capture prelude, which is emitted with the matching nonce. Inline event
     handlers (`onclick=`) are blocked (no `'unsafe-inline'` in script-src).
   - `img-src data:` + `connect-src 'none'` + `default-src 'none'` kill CSS/img
     exfil beacons (`background:url(https://evil/…)`, `<img src=https://…>`).
   - Strip `<meta http-equiv="refresh">` in the shell regardless (issue 15 open
     item — spec-ambiguous whether it fires in a sandbox).
4. **Sandboxed iframe, opaque origin.** `sandbox="allow-scripts"` ONLY. NEVER
   `allow-same-origin` (spec-documented total escape — must be structurally
   impossible, asserted in a test). No `allow-forms`, `allow-modals`,
   `allow-popups` in Tier 1.
5. **MessageChannel bridge.** Parent creates a `MessageChannel`, postMessages one
   port to the frame (`targetOrigin "*"` — opaque origin serializes as "null", so
   `event.origin` is useless; identity is `event.source === iframe.contentWindow`).
   Thereafter both sides talk ONLY over the transferred port. Closed, schema-
   validated verb set. The capability token NEVER crosses the bridge.

## The capture prelude (trusted; the differentiator)

A small first-party script (emitted with the CSP nonce, so it runs while model
scripts don't) inside the frame document:
- Renders an "Ask about this" affordance on text selection within the page.
- On submit, sends over the port: `{ v: "askback", quote, question }` (quote =
  the selected text, capped at QUOTE_MAX). NO DOM paths, NO token.
- Parent side: validate against the closed verb schema, build an Anchor for the
  html artifact (artifact_id + version + `block_index: null` + quote), and POST
  it to the existing `/api/askbacks` with the bearer (parent holds the token).
  So html ask-backs flow the SAME authenticated path as component ask-backs
  (ADR-0010 holds — the bridge is agent/parent-mediated, not a new door).

Agent replies to html ask-backs mount on the artifact card (the existing whole-
artifact reply path in `replies.ts` already handles `block_index: null`).

## Server / validation

- `validate.ts`: add `{ type:"html", title, html }` to the publish/update `oneOf`.
  `html` ≤ 256 KB (reject over — honest bound, not silent truncation). `title`
  same rules as other types. No structural parse of `html` (it is opaque bytes to
  us; the browser parses it in the sandbox).
- Store: `html` artifacts version like any other (ADR-0006). On publish/update,
  mint the frame slug for the new version.
- The legibility gate does NOT run on `html` (it is an SVG-geometry gate; html
  layout is the browser's job). `shouldEnforce` already keys on type — confirm
  html is unaffected.

## Canvas

- Gallery renders an `html` artifact as a card containing the sandboxed `<iframe>`
  pointing at the frame origin `/f/<slug>`, sized responsively (width 100%,
  height via a bridge `{ v:"resize", px }` message from the prelude, clamped).
- Reuse the existing reply-thread mounting for answers.

## Acceptance criteria

- [ ] `publish_artifact {type:"html"}` renders a model page in a sandboxed iframe
      from the second port; external network (img/css/fetch/form) is dead — proven
      by a hostile fixture (beacon img, CSS url() beacon, `<form action=https>`,
      `<script>`, `<meta refresh>`, `onclick=`) that reaches the browser inert.
- [ ] `allow-same-origin` is absent — asserted structurally in a test over the
      rendered iframe attributes.
- [ ] Bridge rejects any message whose `event.source !== iframe.contentWindow` and
      any verb outside the closed set; token never appears in any frame-bound
      payload (canary test).
- [ ] Select text in the page → "Ask about this" → the ask-back lands in the queue
      with the correct quote and html artifact anchor; the agent's `answer_askback`
      threads a reply on the card.
- [ ] Frame slug is ≥128-bit random and per-version; the short display id is never
      the route gate.
- [ ] All existing tests stay green; new hostile-fixture + bridge-auth tests added.

## Tier 2 residual (labeled, NOT built here)

Running model JS requires it to execute somewhere. If it shares the capture
prelude's document, model JS can forge ask-backs/selections (inject text into the
agent's queue — bounded: no token, no network, no host-DOM, but still a forged
human channel). Isolating model JS in a nested sandboxed frame reintroduces the
cross-origin selection-read problem. Neither is needed to match the Opus 5 page.
Decision deferred to the owner with this residual documented; build only if Tier 1
proves insufficient (evidence-over-guessing).
