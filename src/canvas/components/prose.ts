// Prose/markdown renderer (issue 24, ADR-0002 TRUSTED lane): the live-canvas
// DOM emitter over the shared, DOM-FREE AST (src/shared/markdown.ts). Parsing —
// including the link scheme allowlist and control-char rejection — lives in that
// shared module and is the SINGLE source of truth; the export's HTML-string
// emitter walks the very same AST. This file only BUILDS DOM. It is NOT the
// free-form HTML hatch; it opens no HTML hole.
//
// Security spine (mirrors the SVG sanitizer's spirit): every element is made
// with createElement and every string lands via textContent / createTextNode.
// There is NO innerHTML / insertAdjacentHTML / template-into-DOM anywhere, so
// raw HTML in the markdown (`<script>`, `<img onerror>`, any `<tag>`) is never
// parsed as HTML — it becomes literal, escaped text for free. Do NOT introduce
// a markdown library: they emit HTML strings that would need innerHTML.
//
// Link rendering (destinations already validated by the shared parser):
//  · external (allowlisted http/https/mailto) → a new tab with
//    rel="noopener noreferrer"; a same-page `#fragment` navigates in place.
//  · Markdown images `![alt](url)` collapse to their alt text (no <img>, v1).
//  · Malformed markdown degrades to text and never throws out of the renderer.
import type { ArtifactContent } from "../../shared/artifacts.js";
import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
  type MdList,
  type MdListItemChild,
} from "../../shared/markdown.js";

// ── DOM builders (createElement / textContent ONLY) ─────────────────────

/** Append an inline node array as DOM children of `parent`. */
function buildInline(doc: Document, nodes: MdInline[], parent: Node): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        parent.appendChild(doc.createTextNode(node.value));
        break;
      case "strong": {
        const el = doc.createElement("strong");
        buildInline(doc, node.children, el);
        parent.appendChild(el);
        break;
      }
      case "em": {
        const el = doc.createElement("em");
        buildInline(doc, node.children, el);
        parent.appendChild(el);
        break;
      }
      case "code": {
        const el = doc.createElement("code");
        el.textContent = node.value;
        parent.appendChild(el);
        break;
      }
      case "link": {
        const a = doc.createElement("a");
        a.setAttribute("href", node.href);
        // External links open in a new tab with rel="noopener noreferrer";
        // same-page fragment links navigate in place.
        if (node.linkKind === "external") {
          a.setAttribute("rel", "noopener noreferrer");
          a.setAttribute("target", "_blank");
        }
        buildInline(doc, node.children, a);
        parent.appendChild(a);
        break;
      }
      case "hardbreak":
        parent.appendChild(doc.createElement("br"));
        break;
    }
  }
}

/** Build a list item's mixed content: inline runs and any nested list. */
function buildListItem(
  doc: Document,
  children: MdListItemChild[],
  li: HTMLElement,
): void {
  for (const child of children) {
    if ("type" in child && child.type === "list") {
      li.appendChild(buildList(doc, child));
    } else {
      buildInline(doc, [child as MdInline], li);
    }
  }
}

function buildList(doc: Document, node: MdList): HTMLElement {
  const list = doc.createElement(node.ordered ? "ol" : "ul");
  for (const item of node.items) {
    const li = doc.createElement("li");
    buildListItem(doc, item.children, li);
    list.appendChild(li);
  }
  return list;
}

/** Build one top-level block into a DOM element. */
function buildBlock(doc: Document, block: MdBlock): HTMLElement {
  switch (block.type) {
    case "heading": {
      const h = doc.createElement(`h${block.level}`);
      buildInline(doc, block.children, h);
      return h;
    }
    case "paragraph": {
      const p = doc.createElement("p");
      buildInline(doc, block.children, p);
      return p;
    }
    case "code": {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.value;
      if (block.lang) code.dataset.lang = block.lang;
      pre.appendChild(code);
      return pre;
    }
    case "blockquote": {
      const quote = doc.createElement("blockquote");
      for (const child of block.children) quote.appendChild(buildBlock(doc, child));
      return quote;
    }
    case "table": {
      const table = doc.createElement("table");
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of block.header) {
        const th = doc.createElement("th");
        buildInline(doc, cell, th);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        for (const cell of row) {
          const td = doc.createElement("td");
          buildInline(doc, cell, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }
    case "hr":
      return doc.createElement("hr");
    case "list":
      return buildList(doc, block);
  }
}

/** Parse `markdown` and build its top-level block elements. */
function buildBlocks(doc: Document, markdown: string): HTMLElement[] {
  return parseMarkdown(markdown).map((block) => buildBlock(doc, block));
}

/** Render agent-authored markdown into `mount` (e.g. a drawer answer): the
 *  same trusted pipeline as prose artifacts — DOM built via textContent /
 *  createElement only — minus the block-index anchors. Never throws: any parse
 *  failure degrades to the raw markdown as literal text. */
export function renderMarkdownInto(markdown: string, mount: HTMLElement): void {
  const doc = mount.ownerDocument;
  try {
    mount.replaceChildren(...buildBlocks(doc, markdown));
  } catch (err) {
    console.error(`worktable: markdown render degraded to text: ${String(err)}`);
    mount.textContent = markdown;
  }
}

/** Render a prose artifact. Each TOP-LEVEL block carries a data-block-index so
 *  ask-back (which walks up to the nearest indexed element) can anchor a
 *  selection to a section. Never throws: any parse failure degrades to the raw
 *  markdown shown as literal text. */
export function renderProse(content: ArtifactContent, mount: HTMLElement): void {
  if (content.type !== "prose") return;
  const doc = mount.ownerDocument;
  mount.classList.add("prose");
  try {
    const blocks = buildBlocks(doc, content.markdown);
    blocks.forEach((node, index) => {
      node.dataset.blockIndex = String(index);
      mount.appendChild(node);
    });
  } catch (err) {
    // The renderer must never throw out to the gallery — degrade to text.
    console.error(`worktable: prose render degraded to text: ${String(err)}`);
    const fallback = doc.createElement("p");
    fallback.className = "prose-fallback";
    fallback.textContent = content.markdown;
    fallback.dataset.blockIndex = "0";
    mount.replaceChildren(fallback);
  }
}
