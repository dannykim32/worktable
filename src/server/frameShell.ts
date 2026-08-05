// The trusted shell served by the frame-origin server. It wraps the model's
// VERBATIM HTML in a minimal document plus ONE nonce'd "capture prelude" script.
// The document's CSP is delivered as an HTTP HEADER by frameHttp.ts (a <meta> CSP
// cannot deliver sandbox/frame-ancestors); this module only builds the body +
// prelude, plus the small belt-and-suspenders markup pass described below.
//
// What neutralizes the model's own code is the header CSP `script-src
// 'nonce-<random>'`: the model's <script>/onclick have no nonce, so they never
// execute. Network egress is refused at INGEST by frameGuard.ts — the authoritative
// boundary, which REJECTS the whole artifact (never silently strips) on any no-click
// egress construct, <meta http-equiv=refresh> included. By the time HTML reaches
// this module it has already passed that guard, so these passes are pure
// defense-in-depth, not the boundary:
//  · <meta http-equiv=refresh> — already rejected at ingest; stripped again here
//    only so any future caller that skips the guard still can't self-navigate.
//  · nonce= attributes on model tags — the nonce is fresh per response and never
//    shown to the model, so it cannot be guessed; strip anyway so no model tag
//    can carry a literal `nonce=` that a browser quirk might honor.
import { HREF_MAX, QUOTE_MAX } from "../shared/constraints.js";

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
 *  it sets up the frame↔parent MessageChannel bridge (receives the transferred
 *  port from the parent), reports its content height for auto-resize, and offers
 *  an "Ask about this" affordance on text selection.
 *
 *  Issue 27: the in-frame composer BOX is gone — the composer + the whole
 *  conversation now live in the PARENT drawer. On pill click the prelude assigns
 *  a `markerId` (its own counter), stashes the selection Range under it, and
 *  sends the closed `{v:"askstart",quote,markerId}` verb. It draws the persistent
 *  in-content marker only when the parent later confirms the asked question with
 *  `{v:"focusMarker",markerId}` (which also scrolls + highlights it). Clicking a
 *  drawn marker sends `{v:"focusEntry",markerId}` so the parent can highlight the
 *  matching drawer entry.
 *
 *  Clickable external references: clicks on any `<a href>` are intercepted (with
 *  a parent-chain lookup — clicks often land on a child span). The sandboxed
 *  frame must NEVER navigate itself, so every non-fragment anchor click is
 *  preventDefault'ed; an absolute http(s) href ≤ HREF_MAX becomes the closed
 *  verb `{v:"openlink",href}` for the PARENT to open in a new tab. Pure in-page
 *  `#fragment` links keep their default same-document scroll (harmless).
 *  Everything else (javascript:, data:, relative, mailto, oversized) is dropped
 *  silently. These checks are convenience only — the parent bridge re-validates
 *  independently; ITS checks are the boundary.
 *
 *  The prelude sends nothing else, and no capability token exists in this
 *  origin to leak. */
function capturePrelude(): string {
  // Plain string (no backtick template) so the served <script> can never
  // contain a stray `${…}` or an accidental `</script>`.
  return [
    "(function () {",
    "  'use strict';",
    "  var QUOTE_MAX = " + QUOTE_MAX + ";",
    "  var HREF_MAX = " + HREF_MAX + ";",
    "  var port = null;",
    "  function send(msg) { if (port) { try { port.postMessage(msg); } catch (e) {} } }",
    "  // markerId -> { range: Range, el: HTMLElement|null }. The counter is the",
    "  // prelude's own; a marker is DRAWN only once its question is confirmed",
    "  // (parent -> focusMarker), so a cancelled composer leaves nothing behind.",
    "  var markers = Object.create(null);",
    "  var markerSeq = 0;",
    "  var reduceMotion = false;",
    "  try { reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}",
    "  // Receive the transferred MessageChannel port from the parent. Accept it",
    "  // ONLY from our own parent window; ignore any other source.",
    "  function onInit(e) {",
    "    if (e.source !== window.parent) return;",
    "    if (!e.data || e.data.v !== 'port' || !e.ports || !e.ports[0]) return;",
    "    port = e.ports[0];",
    "    port.onmessage = onPortMessage;",
    "    window.removeEventListener('message', onInit);",
    "    reportHeight();",
    "  }",
    "  window.addEventListener('message', onInit);",
    "  // Parent -> frame verbs over the private port. CLOSED set: focusMarker.",
    "  // Anything else is dropped.",
    "  function onPortMessage(e) {",
    "    var d = e && e.data;",
    "    if (!d || typeof d !== 'object') return;",
    "    if (d.v === 'focusMarker') {",
    "      if (typeof d.markerId !== 'string') return;",
    "      focusMarker(d.markerId);",
    "      return;",
    "    }",
    "    // Unknown verb -> dropped.",
    "  }",
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
    "    try {",
    "      var ro = new ResizeObserver(reportHeight);",
    "      // Observe the BODY: its box grows with content. documentElement's box",
    "      // is pinned to the iframe height we set, so it would never re-fire.",
    "      if (document.body) ro.observe(document.body);",
    "    } catch (e) {}",
    "  }",
    "  window.addEventListener('load', reportHeight);",
    "  window.addEventListener('resize', reportHeight);",
    "  // Late layout (fonts, images, reflow) can grow the page after load — and",
    "  // fonts.ready may resolve later still. Re-measure a few times to catch it.",
    "  [50, 250, 800, 2000].forEach(function (ms) { setTimeout(reportHeight, ms); });",
    "  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {",
    "    document.fonts.ready.then(reportHeight).catch(function () {});",
    "  }",
    "  // Draw the persistent in-content marker for markerId from its stashed",
    "  // Range: try to wrap the selection; fall back to a caret glyph at its",
    "  // start. Clicking it asks the parent to highlight the drawer entry.",
    "  function drawMarker(id) {",
    "    var m = markers[id];",
    "    if (!m || m.el) return m ? m.el : null;",
    "    var el = document.createElement('span');",
    "    el.setAttribute('data-wt-marker', id);",
    "    el.setAttribute('role', 'button');",
    "    el.setAttribute('tabindex', '0');",
    "    el.setAttribute('aria-label', 'asked about this — show in the conversation');",
    "    el.setAttribute('style', 'background:#fde68a;outline:1px solid #f59e0b;border-radius:2px;cursor:pointer;');",
    "    try {",
    "      m.range.surroundContents(el);",
    "    } catch (e) {",
    "      try {",
    "        var r2 = m.range.cloneRange();",
    "        r2.collapse(true);",
    "        el.textContent = '\\u25C6';",
    "        el.setAttribute('style', 'color:#b45309;cursor:pointer;font-size:0.8em;vertical-align:super;');",
    "        r2.insertNode(el);",
    "      } catch (e2) { return null; }",
    "    }",
    "    el.addEventListener('click', function () { send({ v: 'focusEntry', markerId: id }); });",
    "    m.el = el;",
    "    return el;",
    "  }",
    "  function focusMarker(id) {",
    "    var el = drawMarker(id);",
    "    if (!el) return;",
    "    try { el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }",
    "    el.setAttribute('data-wt-flash', '1');",
    "    setTimeout(function () { if (el) el.removeAttribute('data-wt-flash'); }, 1600);",
    "  }",
    "  // Clickable external references: the sandboxed frame must NEVER navigate",
    "  // itself, so intercept clicks on any <a href> (walking up from the click",
    "  // target — clicks often land on a child span). Absolute http(s) hrefs",
    "  // within HREF_MAX become the closed {v:'openlink',href} verb for the",
    "  // parent to open; pure in-page #fragment links keep their default",
    "  // same-document scroll; everything else (javascript:, data:, relative,",
    "  // mailto, oversized) is preventDefault'ed and dropped silently. These",
    "  // checks are convenience — the parent re-validates at the boundary.",
    "  document.addEventListener('click', function (ev) {",
    "    var node = ev.target;",
    "    var a = null;",
    "    while (node && node !== document) {",
    "      if (node.nodeType === 1 && node.tagName === 'A' && node.getAttribute('href') !== null) { a = node; break; }",
    "      node = node.parentNode;",
    "    }",
    "    if (!a) return;",
    "    var raw = String(a.getAttribute('href'));",
    "    if (raw.charAt(0) === '#') return; // in-page fragment: default scroll is harmless",
    "    ev.preventDefault(); // no self-navigation, ever",
    "    var url = null;",
    "    try { url = new URL(raw); } catch (e) { return; } // relative/garbage -> drop",
    "    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;",
    "    var href = url.href;",
    "    if (href.length > HREF_MAX) return;",
    "    send({ v: 'openlink', href: href });",
    "  }, true);",
    "  // Ask-about-this affordance on text selection (pill only — the composer",
    "  // lives in the parent drawer now).",
    "  var host = document.createElement('div');",
    "  host.setAttribute('style', 'position:fixed;z-index:2147483647;top:0;left:0;');",
    "  var pill = document.createElement('button');",
    "  pill.type = 'button';",
    "  pill.textContent = 'Ask about this';",
    "  pill.setAttribute('style', 'position:fixed;display:none;font:13px/1.4 system-ui,sans-serif;padding:4px 10px;border-radius:14px;border:1px solid #8883;background:#0f766e;color:#fff;cursor:pointer;box-shadow:0 2px 8px #0004;');",
    "  host.appendChild(pill);",
    "  var currentQuote = '';",
    "  var currentRange = null;",
    "  function hideAll() { pill.style.display = 'none'; }",
    "  function place(el, x, y) { el.style.left = Math.max(4, x) + 'px'; el.style.top = Math.max(4, y) + 'px'; }",
    "  document.addEventListener('mouseup', function (ev) {",
    "    if (host.contains(ev.target)) return;",
    "    var sel = window.getSelection && window.getSelection();",
    "    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideAll(); return; }",
    "    var text = String(sel.toString()).trim();",
    "    if (text === '') { hideAll(); return; }",
    "    currentQuote = text.slice(0, QUOTE_MAX);",
    "    currentRange = sel.getRangeAt(0).cloneRange();",
    "    var rect = sel.getRangeAt(0).getBoundingClientRect();",
    "    place(pill, rect.left, Math.max(4, rect.top - 34));",
    "    pill.style.display = 'inline-block';",
    "  });",
    "  pill.addEventListener('click', function () {",
    "    if (currentQuote === '' || !currentRange) { hideAll(); return; }",
    "    markerSeq++;",
    "    var markerId = 'm' + markerSeq;",
    "    // Stash the Range so a later focusMarker can draw the persistent marker.",
    "    markers[markerId] = { range: currentRange, el: null };",
    "    send({ v: 'askstart', quote: currentQuote, markerId: markerId });",
    "    hideAll();",
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
