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
  .wt-prose { padding: 24px 28px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }
  .wt-conv { max-width: 880px; margin: 24px auto 40px; padding: 0 20px; }
  .wt-conv h2 { font-size: 16px; }
  .wt-entry { background: #ffffff; border: 1px solid rgba(20,26,34,0.14); border-radius: 8px; padding: 12px 14px; margin-top: 10px; font-size: 13.5px; }
  .wt-quote { font-style: italic; color: #4e5866; margin-bottom: 5px; }
  .wt-q { font-weight: 650; }
  .wt-a { border-top: 1px solid rgba(20,26,34,0.14); margin-top: 7px; padding-top: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .wt-a .wt-who, .wt-unanswered { color: #0b5b55; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .wt-foot { max-width: 880px; margin: 28px auto 40px; padding: 0 20px; font-size: 12px; color: #8a93a1; }
`;

function conversationSection(conversation: Askback[]): string {
  if (conversation.length === 0) return "";
  const entries = conversation
    .map((a) => {
      const answer = a.answer
        ? `<div class="wt-a"><span class="wt-who">agent</span>\n${escapeHtml(a.answer.text)}</div>`
        : `<div class="wt-a"><span class="wt-unanswered">not answered</span></div>`;
      return (
        `<div class="wt-entry">` +
        `<div class="wt-quote">${escapeHtml(a.anchor.quote)}</div>` +
        `<div class="wt-q">${escapeHtml(a.question)}</div>` +
        answer +
        `</div>`
      );
    })
    .join("\n");
  return `<section class="wt-conv"><h2>Conversation</h2>\n${entries}\n</section>`;
}

function artifactBody(content: ArtifactContent): string {
  switch (content.type) {
    case "html":
      // Verbatim by design: the model page is already self-contained, and the
      // shell CSP keeps it script-free. Wrapping div only, no re-serialization.
      return `<div class="wt-body">${content.html ?? ""}</div>`;
    case "prose":
      // v1: the markdown SOURCE, escaped, pre-wrap — honest and readable.
      return `<div class="wt-body"><pre class="wt-prose">${escapeHtml(content.markdown)}</pre></div>`;
    case "absence":
      return `<div class="wt-body"><pre class="wt-prose">Not rendered — ${escapeHtml(content.reason)}</pre></div>`;
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
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${title}</title>\n<style>${SHELL_CSS}</style>\n</head>\n<body>\n` +
    `<header class="wt-chrome"><strong>${title}</strong>` +
    `<span>v${meta.latest} · exported ${escapeHtml(exportedAt)}</span></header>\n` +
    artifactBody(content) +
    "\n" +
    (conversation ? conversationSection(conversation) + "\n" : "") +
    `<footer class="wt-foot">Exported from Worktable — a static copy. ` +
    `Scripts and network access are disabled in this file; the ` +
    `select-and-ask-back loop lives on the local canvas.</footer>\n` +
    `</body>\n</html>\n`
  );
}
