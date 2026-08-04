// The trusted shell served by the frame-origin server (issue 25). It wraps the
// model's VERBATIM HTML in a minimal document plus ONE nonce'd "capture prelude"
// script. The document's CSP is delivered as an HTTP HEADER by frameHttp.ts (a
// <meta> CSP cannot deliver sandbox/frame-ancestors — issue 15); this module
// only builds the body + prelude and strips the two markup vectors the header
// CSP does not itself cover.
//
// What neutralizes the model's own code is the header CSP `script-src
// 'nonce-<random>'`: the model's <script>/onclick have no nonce, so they never
// execute. The stripping here is defense-in-depth for the one gap CSP leaves:
//  · <meta http-equiv=refresh> — spec-ambiguous whether it fires in a sandboxed
//    frame, and CSP does not govern it; strip it (issue 15 open item).
//  · nonce= attributes on model tags — the nonce is fresh per response and never
//    shown to the model, so it cannot be guessed; strip anyway so no model tag
//    can carry a literal `nonce=` that a browser quirk might honor.
import { QUESTION_MAX, QUOTE_MAX } from "../shared/constraints.js";

/** Remove `<meta http-equiv=refresh …>` tags (any attribute order/quoting). */
export function stripMetaRefresh(html: string): string {
  return html.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*("\s*refresh\s*"|'\s*refresh\s*'|refresh)[^>]*>/gi,
    "",
  );
}

/** Remove any `nonce="…"` / `nonce='…'` / `nonce=bare` attribute. */
export function stripNonceAttributes(html: string): string {
  return html.replace(/\snonce\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** The two model-markup strips applied before the body is embedded. */
export function sanitizeModelHtmlMarkup(html: string): string {
  return stripNonceAttributes(stripMetaRefresh(html));
}

/** The capture prelude, parameterized by the per-response nonce. Trusted code:
 *  it sets up the frame→parent MessageChannel bridge (receives the transferred
 *  port from the parent), reports its content height for auto-resize, and offers
 *  an "Ask about this" affordance on text selection that sends a closed
 *  `{v:"askback"}` verb over the port. It NEVER sends anything else, and no
 *  capability token exists in this origin to leak. */
function capturePrelude(): string {
  // Plain string (no backtick template) so the served <script> can never
  // contain a stray `${…}` or an accidental `</script>`.
  return [
    "(function () {",
    "  'use strict';",
    "  var QUOTE_MAX = " + QUOTE_MAX + ";",
    "  var QUESTION_MAX = " + QUESTION_MAX + ";",
    "  var port = null;",
    "  function send(msg) { if (port) { try { port.postMessage(msg); } catch (e) {} } }",
    "  // Receive the transferred MessageChannel port from the parent. Accept it",
    "  // ONLY from our own parent window; ignore any other source.",
    "  function onInit(e) {",
    "    if (e.source !== window.parent) return;",
    "    if (!e.data || e.data.v !== 'port' || !e.ports || !e.ports[0]) return;",
    "    port = e.ports[0];",
    "    window.removeEventListener('message', onInit);",
    "    reportHeight();",
    "  }",
    "  window.addEventListener('message', onInit);",
    "  // Announce readiness to the parent so it can identity-check us",
    "  // (event.source === our iframe) and transfer the bridge port.",
    "  function announce() { try { window.parent.postMessage({ v: 'ready' }, '*'); } catch (e) {} }",
    "  if (document.readyState === 'complete') announce();",
    "  window.addEventListener('load', announce);",
    "  // Auto-resize: report content height so the parent can size the iframe.",
    "  var lastPx = -1;",
    "  function reportHeight() {",
    "    var px = Math.max(",
    "      document.documentElement ? document.documentElement.scrollHeight : 0,",
    "      document.body ? document.body.scrollHeight : 0",
    "    );",
    "    px = Math.max(0, Math.min(20000, px | 0));",
    "    if (px !== lastPx) { lastPx = px; send({ v: 'resize', px: px }); }",
    "  }",
    "  if (typeof ResizeObserver !== 'undefined') {",
    "    try { new ResizeObserver(reportHeight).observe(document.documentElement); } catch (e) {}",
    "  }",
    "  window.addEventListener('load', reportHeight);",
    "  window.addEventListener('resize', reportHeight);",
    "  // Ask-about-this affordance on text selection.",
    "  var host = document.createElement('div');",
    "  host.setAttribute('style', 'position:fixed;z-index:2147483647;top:0;left:0;');",
    "  var pill = document.createElement('button');",
    "  pill.type = 'button';",
    "  pill.textContent = 'Ask about this';",
    "  pill.setAttribute('style', 'position:fixed;display:none;font:13px/1.4 system-ui,sans-serif;padding:4px 10px;border-radius:14px;border:1px solid #8883;background:#1f6feb;color:#fff;cursor:pointer;box-shadow:0 2px 8px #0004;');",
    "  var box = document.createElement('div');",
    "  box.setAttribute('style', 'position:fixed;display:none;font:13px/1.4 system-ui,sans-serif;background:#fff;color:#111;border:1px solid #0002;border-radius:8px;padding:8px;box-shadow:0 4px 16px #0003;max-width:320px;');",
    "  var input = document.createElement('input');",
    "  input.type = 'text';",
    "  input.setAttribute('aria-label', 'ask the agent about this selection');",
    "  input.placeholder = 'Ask the agent about this selection…';",
    "  input.setAttribute('style', 'width:260px;padding:4px 6px;border:1px solid #0003;border-radius:5px;font:inherit;');",
    "  var sendBtn = document.createElement('button');",
    "  sendBtn.type = 'button';",
    "  sendBtn.textContent = 'Send';",
    "  sendBtn.setAttribute('style', 'margin-left:6px;padding:4px 10px;border-radius:5px;border:0;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;');",
    "  box.appendChild(input); box.appendChild(sendBtn);",
    "  host.appendChild(pill); host.appendChild(box);",
    "  var currentQuote = '';",
    "  function hideAll() { pill.style.display = 'none'; box.style.display = 'none'; }",
    "  function place(el, x, y) { el.style.left = Math.max(4, x) + 'px'; el.style.top = Math.max(4, y) + 'px'; }",
    "  document.addEventListener('mouseup', function (ev) {",
    "    if (host.contains(ev.target)) return;",
    "    var sel = window.getSelection && window.getSelection();",
    "    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideAll(); return; }",
    "    var text = String(sel.toString()).trim();",
    "    if (text === '') { hideAll(); return; }",
    "    currentQuote = text.slice(0, QUOTE_MAX);",
    "    var rect = sel.getRangeAt(0).getBoundingClientRect();",
    "    box.style.display = 'none';",
    "    place(pill, rect.left, Math.max(4, rect.top - 34));",
    "    pill.style.display = 'inline-block';",
    "  });",
    "  pill.addEventListener('click', function () {",
    "    pill.style.display = 'none';",
    "    place(box, parseFloat(pill.style.left) || 8, (parseFloat(pill.style.top) || 8) + 30);",
    "    box.style.display = 'block';",
    "    input.value = '';",
    "    input.focus();",
    "  });",
    "  function submitAsk() {",
    "    var q = String(input.value).trim().slice(0, QUESTION_MAX);",
    "    if (q === '' || currentQuote === '') return;",
    "    send({ v: 'askback', quote: currentQuote, question: q });",
    "    hideAll();",
    "  }",
    "  sendBtn.addEventListener('click', submitAsk);",
    "  input.addEventListener('keydown', function (e) {",
    "    if (e.key === 'Enter') submitAsk();",
    "    if (e.key === 'Escape') hideAll();",
    "  });",
    "  function attachHost() { if (document.body) document.body.appendChild(host); }",
    "  if (document.body) attachHost();",
    "  else window.addEventListener('DOMContentLoaded', attachHost);",
    "})();",
  ].join("\n");
}

/** Build the served frame document: trusted shell + nonce'd prelude + the
 *  model's VERBATIM (markup-stripped) HTML. The CSP is delivered as a header by
 *  frameHttp.ts, not here. */
export function buildFrameDocument(modelHtml: string, nonce: string): string {
  const body = sanitizeModelHtmlMarkup(modelHtml);
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    "</head>\n" +
    "<body>\n" +
    body +
    "\n" +
    '<script nonce="' +
    nonce +
    '">' +
    capturePrelude() +
    "</script>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
