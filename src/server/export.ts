// Standalone HTML export: one file a colleague can open in any browser, no
// server, no agent.
//
// CONTRACT. The export carries NO MODEL scripts and NO network access, exactly
// like the live canvas frame — but it is NOT script-free. An html artifact is a
// full, self-contained page (it styles `html`/`body`/`:root` and may be
// dark-first or use `@media (prefers-color-scheme)`); embedding it in a plain
// `<div>` flattens the cascade — the model background never paints and its
// light-on-dark text lands on the shell's white, unreadable. So an html
// artifact is embedded the SAME way the canvas does it: as its OWN document
// inside a sandboxed `<iframe srcdoc>` (issue: html-export-isolation). Two small
// TRUSTED, nonce'd scripts survive — a resize reporter inside the frame and a
// resize listener in the shell — so the framed page flows at its natural height
// instead of an inner scrollbar. Everything else stays static.
//
// Trust boundaries in the assembled document:
//  · The SHELL (chrome, styles, CSP, footer, resize listener) is trusted code
//    from this module; its one inline `<script>` carries the response nonce.
//  · An html artifact's body is model-authored and embedded VERBATIM inside the
//    sandboxed frame's srcdoc — it already passed frameGuard at ingest (no
//    no-click egress); the frame's own `script-src 'nonce-…'` CSP inertizes the
//    model's `<script>`/`onclick` exactly as the live frame does (they carry no
//    nonce), and `sandbox="allow-scripts"` WITHOUT allow-same-origin keeps the
//    frame at an opaque origin. The whole srcdoc is attribute-escaped, so a
//    model `</script>` cannot even break the shell's parser.
//  · EVERYTHING else that originated as text (titles, markdown, questions,
//    answers, quotes, reasons) is HTML-ESCAPED — never interpolated raw.
// Zero runtime dependencies, pure string assembly, fully unit-testable — the
// per-response nonce is threaded IN so the builder stays deterministic.
import type {
  ArtifactContent,
  ArtifactMeta,
  Askback,
} from "../shared/artifacts.js";
import { renderMarkdownToHtml, type MarkerSpec } from "./markdownHtml.js";
import { sanitizeModelHtmlMarkup } from "./frameShell.js";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A safe download filename from the artifact title (ASCII slug + .html). */
export function exportFilename(title: string, artifactId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || artifactId}.html`;
}

/** Outer-shell CSP. No network (`default-src 'none'`), images-as-data only,
 *  inline styles for the self-contained shell. `frame-src 'self'` lets the
 *  sandboxed `srcdoc` frame load (a srcdoc document matches 'self'); scripts run
 *  ONLY via the fresh response nonce — the shell's resize listener — so nothing
 *  in this file executes on an attacker's terms. */
function exportCsp(nonce: string): string {
  return (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
    `frame-src 'self'; script-src 'nonce-${nonce}'`
  );
}

/** The framed html artifact's OWN CSP, delivered by a `<meta>` in its srcdoc.
 *  Same posture as the live frame origin: no network, images-as-data, inline
 *  styles, and scripts ONLY via the nonce (the trusted resize reporter). The
 *  model's own scripts carry no nonce and never run. */
function frameSrcdocCsp(nonce: string): string {
  return (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
    `script-src 'nonce-${nonce}'`
  );
}

const SHELL_CSS = `
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, sans-serif; color: #141a22; background: #eaeef3; }
  .wt-chrome { max-width: 880px; margin: 0 auto; padding: 14px 20px; font-size: 13px; color: #4e5866; display: flex; gap: 10px; align-items: baseline; border-bottom: 2px solid #0f766e; }
  .wt-chrome strong { font-size: 16px; color: #141a22; }
  .wt-body { background: #ffffff; max-width: 1200px; margin: 20px auto; border: 1px solid rgba(20,26,34,0.14); border-radius: 10px; overflow: hidden; }
  .wt-frame-wrap { max-width: 1200px; margin: 20px auto; border: 1px solid rgba(20,26,34,0.14); border-radius: 10px; overflow: hidden; }
  /* Start at the iframe's default 150px (as the live canvas does) and grow to
     content via the resize shim — so short pages fit tight and tall pages fill
     out. With JS off (rare for a local file) a tall page keeps this height and
     scrolls internally; the footer notes the copy is static. */
  .wt-frame { display: block; width: 100%; height: 150px; border: 0; }
  .wt-prose { padding: 24px 28px; overflow-wrap: anywhere; }
  .wt-prose > :first-child { margin-top: 0; }
  .wt-prose > :last-child { margin-bottom: 0; }
  .wt-prose h1, .wt-prose h2, .wt-prose h3, .wt-prose h4, .wt-prose h5, .wt-prose h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  .wt-prose p { margin: 0 0 0.8em; }
  .wt-prose ul, .wt-prose ol { margin: 0 0 0.8em; padding-left: 1.5em; }
  .wt-prose li { margin: 0.2em 0; }
  .wt-prose blockquote { margin: 0 0 0.8em; padding-left: 12px; border-left: 3px solid #0f766e; color: #4e5866; }
  .wt-prose code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: rgba(20,26,34,0.06); padding: 0.1em 0.35em; border-radius: 4px; }
  .wt-prose pre { background: #0f1720; color: #e6edf3; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  .wt-prose pre code { background: none; padding: 0; color: inherit; }
  .wt-prose table { border-collapse: collapse; margin: 0 0 0.8em; display: block; overflow-x: auto; }
  .wt-prose th, .wt-prose td { border: 1px solid rgba(20,26,34,0.18); padding: 5px 10px; text-align: left; }
  .wt-prose a { color: #0b5b55; }
  .wt-mark { font-size: 0.7em; vertical-align: super; color: #0b5b55; text-decoration: none; font-weight: 700; padding: 0 1px; }
  .wt-conv { max-width: 880px; margin: 24px auto 40px; padding: 0 20px; }
  .wt-conv h2 { font-size: 16px; }
  .wt-entry { background: #ffffff; border: 1px solid rgba(20,26,34,0.14); border-radius: 8px; padding: 12px 14px; margin-top: 10px; font-size: 13.5px; }
  .wt-entry-n { display: inline-block; font-weight: 700; color: #0b5b55; text-decoration: none; margin-right: 6px; }
  .wt-quote { font-style: italic; color: #4e5866; margin-bottom: 5px; }
  .wt-q { font-weight: 650; }
  .wt-a { border-top: 1px solid rgba(20,26,34,0.14); margin-top: 7px; padding-top: 7px; overflow-wrap: anywhere; }
  .wt-a > :first-child { margin-top: 0; }
  .wt-a p { margin: 0.4em 0; }
  .wt-a ul, .wt-a ol { margin: 0.4em 0; padding-left: 1.4em; }
  .wt-a code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: rgba(20,26,34,0.06); padding: 0.1em 0.3em; border-radius: 4px; }
  .wt-a pre { background: #0f1720; color: #e6edf3; padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  .wt-a pre code { background: none; padding: 0; color: inherit; }
  .wt-a .wt-who, .wt-unanswered { display: block; color: #0b5b55; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .wt-foot { max-width: 880px; margin: 28px auto 40px; padding: 0 20px; font-size: 12px; color: #8a93a1; }
`;

/** The trusted resize reporter that rides INSIDE the frame's srcdoc. It measures
 *  the model page's content height and posts it to the shell so the iframe can
 *  grow to fit (no inner scrollbar). Plain string (no template literal) so it can
 *  never carry a stray `${…}` or `</script>`; carries the response nonce so it
 *  runs under the frame's `script-src 'nonce-…'` while the model's scripts don't.
 *  postMessage targetOrigin is "*" because the sandboxed frame is opaque-origin;
 *  the shell listener re-checks `event.source` before trusting the number. */
function frameResizeReporter(): string {
  return [
    "(function () {",
    "  'use strict';",
    "  function report() {",
    "    var px = Math.max(",
    "      document.documentElement ? document.documentElement.scrollHeight : 0,",
    "      document.body ? document.body.scrollHeight : 0",
    "    );",
    "    px = Math.max(0, Math.min(20000, px | 0));",
    "    try { parent.postMessage({ v: 'wt-export-resize', px: px }, '*'); } catch (e) {}",
    "  }",
    "  window.addEventListener('load', report);",
    "  window.addEventListener('resize', report);",
    "  [50, 250, 800, 2000].forEach(function (ms) { setTimeout(report, ms); });",
    "  if (typeof ResizeObserver !== 'undefined') {",
    "    try { var ro = new ResizeObserver(report); if (document.body) ro.observe(document.body); } catch (e) {}",
    "  }",
    "  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {",
    "    document.fonts.ready.then(report).catch(function () {});",
    "  }",
    "  report();",
    "})();",
  ].join("\n");
}

/** The trusted shell-side listener: size the one export iframe to the height it
 *  reports, but ONLY from that iframe's own content window and only a finite,
 *  clamped number. Nothing else in the shell reacts to messages. */
function shellResizeListener(): string {
  return [
    "(function () {",
    "  'use strict';",
    "  var f = document.getElementById('wt-frame');",
    "  if (!f) return;",
    "  window.addEventListener('message', function (e) {",
    "    if (e.source !== f.contentWindow) return;",
    "    var d = e && e.data;",
    "    if (!d || d.v !== 'wt-export-resize' || typeof d.px !== 'number' || !isFinite(d.px)) return;",
    "    f.style.height = Math.max(80, Math.min(20000, d.px | 0)) + 'px';",
    "  });",
    "})();",
  ].join("\n");
}

/** Build the frame's srcdoc: a minimal trusted document (charset, viewport, its
 *  own nonce CSP) wrapping the model's VERBATIM (markup-stripped) page, plus the
 *  nonce'd resize reporter. No shell CSS here — the model page owns its styling
 *  end to end, so a dark-first ground renders exactly as it does on the canvas.
 *  The returned string is attribute-escaped by the caller. */
function frameSrcdoc(modelHtml: string, nonce: string): string {
  const body = sanitizeModelHtmlMarkup(modelHtml);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<meta http-equiv="Content-Security-Policy" content="${frameSrcdocCsp(nonce)}" />` +
    `</head><body>${body}\n` +
    `<script nonce="${nonce}">${frameResizeReporter()}</script>` +
    `</body></html>`
  );
}

/** Each entry is numbered 1..N and carries `id="wt-entry-N"`. When the entry has
 *  an in-content marker (prose artifacts only), its number links to that marker
 *  (`#wt-mark-N`) and the marker links back here; `hasMarker[i]` says which. The
 *  answer is rendered markdown (formatted), not an escaped blob. */
function conversationSection(
  conversation: Askback[],
  hasMarker: boolean[],
): string {
  if (conversation.length === 0) return "";
  const entries = conversation
    .map((a, idx) => {
      const n = idx + 1;
      const num = hasMarker[idx]
        ? `<a class="wt-entry-n" href="#wt-mark-${n}">${n}</a>`
        : `<span class="wt-entry-n">${n}</span>`;
      const answer = a.answer
        ? `<div class="wt-a"><span class="wt-who">agent</span>${renderMarkdownToHtml(a.answer.text)}</div>`
        : `<div class="wt-a"><span class="wt-unanswered">not answered</span></div>`;
      return (
        `<div class="wt-entry" id="wt-entry-${n}">` +
        num +
        `<div class="wt-quote">${escapeHtml(a.anchor.quote)}</div>` +
        `<div class="wt-q">${escapeHtml(a.question)}</div>` +
        answer +
        `</div>`
      );
    })
    .join("\n");
  return `<section class="wt-conv"><h2>Conversation</h2>\n${entries}\n</section>`;
}

/** `markers` are only ever non-empty for a PROSE artifact: the rendered markdown
 *  body gets static `#fragment` markers threaded in at the anchored blocks.
 *
 *  html/prose asymmetry (Part B): an html artifact's body is the model's exact,
 *  self-contained page, embedded VERBATIM. We do NOT inject markers into it —
 *  splicing anchors into arbitrary model markup can't be done safely without
 *  fully parsing that HTML, and a mis-splice would corrupt the page. So html
 *  entries are still numbered in the conversation, but carry no in-content
 *  marker or backlink. Only prose (which we render ourselves from a trusted AST)
 *  gets in-content markers. */
function artifactBody(
  content: ArtifactContent,
  markers: MarkerSpec[],
  nonce: string,
  title: string,
): string {
  switch (content.type) {
    case "html":
      // Isolated document, exactly like the live canvas: the model's full,
      // self-contained page becomes the srcdoc of a sandboxed iframe, so its
      // own `html`/`body`/`:root` styles (and dark-first grounds) paint the
      // frame instead of leaking onto the shell. The srcdoc is attribute-escaped
      // as a whole — a model `</script>` cannot break the shell parser — and the
      // frame's nonce CSP + `allow-scripts`-without-same-origin sandbox keep the
      // model's own scripts inert at an opaque origin.
      return (
        `<div class="wt-frame-wrap"><iframe class="wt-frame" id="wt-frame" ` +
        `title="${title}" sandbox="allow-scripts" ` +
        `srcdoc="${escapeHtml(frameSrcdoc(content.html ?? "", nonce))}"` +
        `></iframe></div>`
      );
    case "prose":
      // Rendered markdown (headings, lists, code, tables, links) + in-content
      // conversation markers, via the shared-AST HTML emitter.
      return `<div class="wt-body wt-prose">${renderMarkdownToHtml(content.markdown, markers)}</div>`;
    case "absence":
      return `<div class="wt-body wt-prose"><p>Not rendered — ${escapeHtml(content.reason)}</p></div>`;
  }
}

export function buildExportHtml(opts: {
  meta: ArtifactMeta;
  content: ArtifactContent;
  /** null = export without the conversation appendix. */
  conversation: Askback[] | null;
  exportedAt: string;
  /** Fresh per-response nonce (generated by the route, threaded IN so the
   *  builder stays deterministic). Authorizes the shell resize listener and the
   *  in-frame resize reporter; the model's own scripts never carry it. */
  nonce: string;
}): string {
  const { meta, content, conversation, exportedAt, nonce } = opts;
  const title = escapeHtml(meta.title);

  // Number entries 1..N and, for a PROSE artifact, build one static in-content
  // marker per entry anchored to a specific block (block_index != null). A
  // whole-artifact ask (block_index null) and every html entry get no marker.
  const conv = conversation ?? [];
  const isProse = content.type === "prose";
  const markers: MarkerSpec[] = [];
  const hasMarker: boolean[] = conv.map((a, idx) => {
    const n = idx + 1;
    const wants = isProse && a.anchor.block_index !== null;
    if (wants) {
      markers.push({
        blockIndex: a.anchor.block_index!,
        quote: a.anchor.quote,
        html: `<a class="wt-mark" id="wt-mark-${n}" href="#wt-entry-${n}">[${n}]</a>`,
      });
    }
    return wants;
  });

  // Only an html artifact needs the framed-isolation + resize plumbing; prose
  // and absence are plain trusted markup, so their exports carry no script.
  const isHtml = content.type === "html";

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta http-equiv="Content-Security-Policy" content="${exportCsp(nonce)}" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${title}</title>\n<style>${SHELL_CSS}</style>\n</head>\n<body>\n` +
    `<header class="wt-chrome"><strong>${title}</strong>` +
    `<span>v${meta.latest} · exported ${escapeHtml(exportedAt)}</span></header>\n` +
    artifactBody(content, markers, nonce, title) +
    "\n" +
    (conversation ? conversationSection(conv, hasMarker) + "\n" : "") +
    `<footer class="wt-foot">Exported from Worktable — a static copy. ` +
    `Network access is disabled and the model's own scripts are inert; the ` +
    `select-and-ask-back loop lives on the local canvas.</footer>\n` +
    (isHtml
      ? `<script nonce="${nonce}">${shellResizeListener()}</script>\n`
      : "") +
    `</body>\n</html>\n`
  );
}
