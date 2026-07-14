// Document component renderer: one pure DOM-building function per block
// kind, styling matched to the judged prototype. All text lands via
// textContent — never innerHTML of model-influenced strings.
import type {
  ArtifactContent,
  DocumentBlock,
} from "../../shared/artifacts.js";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderBlock(block: DocumentBlock, mount: HTMLElement): HTMLElement {
  const doc = mount.ownerDocument;
  switch (block.kind) {
    case "heading": {
      const tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      const node = el(doc, tag, "doc-heading", block.text);
      mount.appendChild(node);
      return node;
    }
    case "paragraph": {
      const node = el(doc, "p", undefined, block.text);
      mount.appendChild(node);
      return node;
    }
    case "callout": {
      const node = el(doc, "div", `callout tone-${block.tone}`, block.text);
      mount.appendChild(node);
      return node;
    }
    case "code": {
      const pre = el(doc, "pre");
      const code = el(doc, "code", undefined, block.text);
      if (block.lang !== undefined) code.dataset.lang = block.lang;
      pre.appendChild(code);
      mount.appendChild(pre);
      return pre;
    }
    case "table": {
      const table = el(doc, "table");
      const thead = el(doc, "thead");
      const headRow = el(doc, "tr");
      for (const cell of block.header) {
        headRow.appendChild(el(doc, "th", undefined, cell));
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el(doc, "tbody");
      for (const row of block.rows) {
        const tr = el(doc, "tr");
        for (const cell of row) tr.appendChild(el(doc, "td", undefined, cell));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      mount.appendChild(table);
      return table;
    }
    case "list": {
      const list = el(doc, block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        list.appendChild(el(doc, "li", undefined, item));
      }
      mount.appendChild(list);
      return list;
    }
  }
}

export function renderDocument(content: ArtifactContent, mount: HTMLElement): void {
  if (content.type !== "document") return;
  mount.classList.add("doc");
  content.blocks.forEach((block, index) => {
    const node = renderBlock(block, mount);
    // Anchors (issue 05) reference blocks by index within the viewed Version.
    node.dataset.blockIndex = String(index);
  });
}
