// Standalone HTML export: one file a colleague can open in any browser, no
// server, no agent. STATIC by construction — the shell carries a meta CSP with
// the same posture as the frame origin (no scripts, no network), so a model
// `<script>` that our live canvas neutralizes stays neutralized in the export.
//
// Trust boundaries in the assembled document:
//  · The SHELL (chrome, styles, CSP, footer) is trusted code from this module.
//  · An html artifact's body is model-authored and embedded VERBATIM — it
//    already passed frameGuard at ingest (no no-click egress), and the CSP
//    inertizes scripts exactly as the live frame does.
//  · EVERYTHING else that originated as text (titles, markdown, questions,
//    answers, quotes, reasons) is HTML-ESCAPED — never interpolated raw.
// Zero dependencies, pure string assembly, fully unit-testable.
import type {
  ArtifactContent,
  ArtifactMeta,
  Askback,
} from "../shared/artifacts.js";
import { renderMarkdownToHtml, type MarkerSpec } from "./markdownHtml.js";

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

/** Same guarantees as the live frame: no scripts, no network. `img-src data:`
 *  keeps embedded images; inline styles are how self-contained pages style. */
const EXPORT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const SHELL_CSS = `
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, sans-serif; color: #141a22; background: #eaeef3; }
  .wt-chrome { max-width: 880px; margin: 0 auto; padding: 14px 20px; font-size: 13px; color: #4e5866; display: flex; gap: 10px; align-items: baseline; border-bottom: 2px solid #0f766e; }
  .wt-chrome strong { font-size: 16px; color: #141a22; }
  .wt-body { background: #ffffff; max-width: 1200px; margin: 20px auto; border: 1px solid rgba(20,26,34,0.14); border-radius: 10px; overflow: hidden; }
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
function artifactBody(content: ArtifactContent, markers: MarkerSpec[]): string {
  switch (content.type) {
    case "html":
      // Verbatim by design: the model page is already self-contained, and the
      // shell CSP keeps it script-free. Wrapping div only, no re-serialization.
      return `<div class="wt-body">${content.html ?? ""}</div>`;
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
}): string {
  const { meta, content, conversation, exportedAt } = opts;
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

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${title}</title>\n<style>${SHELL_CSS}</style>\n</head>\n<body>\n` +
    `<header class="wt-chrome"><strong>${title}</strong>` +
    `<span>v${meta.latest} · exported ${escapeHtml(exportedAt)}</span></header>\n` +
    artifactBody(content, markers) +
    "\n" +
    (conversation ? conversationSection(conv, hasMarker) + "\n" : "") +
    `<footer class="wt-foot">Exported from Worktable — a static copy. ` +
    `Scripts and network access are disabled in this file; the ` +
    `select-and-ask-back loop lives on the local canvas.</footer>\n` +
    `</body>\n</html>\n`
  );
}
