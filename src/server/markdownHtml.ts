// Server-side markdown → HTML STRING emitter for the standalone export. It walks
// the SAME DOM-free AST the live canvas builds (src/shared/markdown.ts) — one
// parser, two emitters — so the export inherits the canvas's exact link/scheme
// security without re-deriving it.
//
// This is a SECURITY SURFACE: the export opens in a browser with NO sandbox
// around our shell (only a meta CSP). The discipline that keeps it safe:
//  · Every text/code value is HTML-escaped before it reaches the output.
//  · ONLY whitelisted tags are ever emitted (h1-h6, p, strong, em, code, pre,
//    ul, ol, li, blockquote, table/thead/tbody/tr/th/td, hr, a, br). There is
//    no raw-HTML passthrough — raw `<tag>` in the source is a text node in the
//    AST and comes out escaped.
//  · Link hrefs are already validated by the shared parser (allowlisted
//    http/https/mailto → external, or a same-page `#fragment`); external links
//    get target="_blank" rel="noopener noreferrer", fragments navigate in place.
//    The href is additionally attribute-escaped here.
import { escapeHtml } from "./export.js";
import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
  type MdList,
  type MdListItemChild,
} from "../shared/markdown.js";

/** A static in-page marker to inject into a prose artifact's rendered body. The
 *  export numbers each conversation entry and drops one of these at the block
 *  the entry was anchored to, linking back to the entry (Part B). `html` is the
 *  fully-formed, trusted anchor string built by the caller (export.ts). */
export interface MarkerSpec {
  /** Top-level block the entry anchored to (Anchor.block_index). */
  blockIndex: number;
  /** The entry's anchored quote — located within the block to place the marker
   *  right after it; if not found, the marker lands at the block's end. */
  quote: string;
  /** The `<a class="wt-mark" …>` string to insert (already escaped/trusted). */
  html: string;
}

// ── plain-text projection (for locating a marker's quote) ───────────────
// The offset convention must match between locating the quote and threading
// the emit cursor: code spans contribute their literal text, a hard break is
// one newline, everything else is the concatenation of its children.
function plainInline(nodes: MdInline[]): string {
  let s = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        s += node.value;
        break;
      case "code":
        s += node.value;
        break;
      case "hardbreak":
        s += "\n";
        break;
      case "strong":
      case "em":
      case "link":
        s += plainInline(node.children);
        break;
    }
  }
  return s;
}

// ── inline emit (no markers) ────────────────────────────────────────────
function emitInline(nodes: MdInline[]): string {
  let out = "";
  for (const node of nodes) out += emitInlineNode(node);
  return out;
}

function emitInlineNode(node: MdInline): string {
  switch (node.kind) {
    case "text":
      return escapeHtml(node.value);
    case "code":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "strong":
      return `<strong>${emitInline(node.children)}</strong>`;
    case "em":
      return `<em>${emitInline(node.children)}</em>`;
    case "hardbreak":
      return "<br />";
    case "link": {
      const href = escapeHtml(node.href);
      const attrs =
        node.linkKind === "external"
          ? ` target="_blank" rel="noopener noreferrer"`
          : "";
      return `<a href="${href}"${attrs}>${emitInline(node.children)}</a>`;
    }
  }
}

// ── inline emit WITH markers (paragraph/heading precise placement) ──────
// Markers are sorted by their target offset in the block's plain text; a marker
// whose offset falls inside a text node splits that node, so it lands right
// after the quoted words. Atomic inline nodes (code/strong/em/link) are not
// split — a marker due inside one is emitted immediately after it, which is why
// a marker never nests inside an <a>.
interface MarkerCursor {
  markers: { offset: number; html: string }[];
  i: number;
  cursor: number;
}

function flushMarkers(state: MarkerCursor, upto: number): string {
  let out = "";
  while (state.i < state.markers.length && state.markers[state.i]!.offset <= upto) {
    out += state.markers[state.i]!.html;
    state.i++;
  }
  return out;
}

function emitTextWithMarkers(value: string, state: MarkerCursor): string {
  const start = state.cursor;
  const end = start + value.length;
  let out = "";
  let consumed = 0; // chars of `value` already emitted
  while (state.i < state.markers.length && state.markers[state.i]!.offset <= end) {
    const m = state.markers[state.i]!;
    const splitAt = Math.max(0, m.offset - start); // index within `value`
    out += escapeHtml(value.slice(consumed, splitAt));
    out += m.html;
    consumed = splitAt;
    state.i++;
  }
  out += escapeHtml(value.slice(consumed));
  state.cursor = end;
  return out;
}

function emitInlineWithMarkers(nodes: MdInline[], state: MarkerCursor): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += emitTextWithMarkers(node.value, state);
    } else {
      out += flushMarkers(state, state.cursor); // markers due before this node
      const len = plainInline([node]).length;
      out += emitInlineNode(node);
      state.cursor += len;
      out += flushMarkers(state, state.cursor); // markers due within/after it
    }
  }
  return out;
}

// ── list / table emit ───────────────────────────────────────────────────
function emitListItem(children: MdListItemChild[]): string {
  let out = "";
  for (const child of children) {
    if ("type" in child && child.type === "list") out += emitList(child);
    else out += emitInlineNode(child as MdInline);
  }
  return out;
}

function emitList(node: MdList): string {
  const tag = node.ordered ? "ol" : "ul";
  const items = node.items.map((it) => `<li>${emitListItem(it.children)}</li>`).join("");
  return `<${tag}>${items}</${tag}>`;
}

// ── block emit ──────────────────────────────────────────────────────────
/** Emit one block. `markers` are the marker specs anchored to THIS block; they
 *  are placed precisely inside heading/paragraph content, and appended after
 *  the block (as siblings) for container/opaque blocks — the "else at the end
 *  of the block" fallback the spec allows. */
function emitBlock(block: MdBlock, markers: { offset: number; html: string }[]): string {
  const trailing = (): string => markers.map((m) => m.html).join("");

  switch (block.type) {
    case "heading": {
      const tag = `h${block.level}`;
      const state: MarkerCursor = { markers, i: 0, cursor: 0 };
      let inner = emitInlineWithMarkers(block.children, state);
      inner += markers.slice(state.i).map((m) => m.html).join(""); // leftovers → end
      return `<${tag}>${inner}</${tag}>`;
    }
    case "paragraph": {
      const state: MarkerCursor = { markers, i: 0, cursor: 0 };
      let inner = emitInlineWithMarkers(block.children, state);
      inner += markers.slice(state.i).map((m) => m.html).join("");
      return `<p>${inner}</p>`;
    }
    case "code": {
      const langAttr = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : "";
      return `<pre><code${langAttr}>${escapeHtml(block.value)}</code></pre>` + trailing();
    }
    case "blockquote": {
      const inner = block.children.map((b) => emitBlock(b, [])).join("");
      return `<blockquote>${inner}${trailing()}</blockquote>`;
    }
    case "table": {
      const th = block.header.map((c) => `<th>${emitInline(c)}</th>`).join("");
      const body = block.rows
        .map((row) => `<tr>${row.map((c) => `<td>${emitInline(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>` + trailing();
    }
    case "hr":
      return `<hr />` + trailing();
    case "list":
      return emitList(block) + trailing();
  }
}

/** Render markdown to a safe HTML string. Optionally inject in-page conversation
 *  markers (prose-artifact export, Part B); with no markers this is the plain
 *  emitter used for conversation answers. Never throws: on any parse failure it
 *  degrades to the escaped raw markdown. */
export function renderMarkdownToHtml(md: string, markers: MarkerSpec[] = []): string {
  try {
    const blocks = parseMarkdown(md);
    // Group markers by their target block, preserving caller (entry) order.
    const byBlock = new Map<number, MarkerSpec[]>();
    for (const m of markers) {
      const list = byBlock.get(m.blockIndex);
      if (list) list.push(m);
      else byBlock.set(m.blockIndex, [m]);
    }
    return blocks
      .map((block, index) => {
        const specs = byBlock.get(index) ?? [];
        // Resolve each spec's quote to a plain-text offset within the block;
        // stable-sort by offset so multiple markers on one block stay ordered.
        const plain =
          block.type === "heading" || block.type === "paragraph"
            ? plainInline(block.children)
            : "";
        const placed = specs.map((spec, order) => {
          const at = plain.indexOf(spec.quote);
          const offset = at >= 0 && spec.quote !== "" ? at + spec.quote.length : plain.length;
          return { offset, html: spec.html, order };
        });
        placed.sort((a, b) => a.offset - b.offset || a.order - b.order);
        return emitBlock(block, placed);
      })
      .join("\n");
  } catch (err) {
    console.error(`worktable export: markdown render degraded to text: ${String(err)}`);
    return `<p>${escapeHtml(md)}</p>`;
  }
}
