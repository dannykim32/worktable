// Canonical writer (issue 09): the ONLY producer of output bytes. Everything
// is re-emitted from the AST — canonical attribute order, all text
// re-escaped — so no input byte ever passes through to the output.
import type { SvgElement } from "./ast.js";
import { SVG_XMLNS, TEXT_ELEMENTS } from "./allowlist.js";

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** Canonical order: xmlns first, then ascending by code unit. */
function compareAttrNames(a: string, b: string): number {
  if (a === "xmlns") return b === "xmlns" ? 0 : -1;
  if (b === "xmlns") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function writeSvg(root: SvgElement): string {
  return writeElement(root, true);
}

function writeElement(el: SvgElement, isRoot: boolean): string {
  const attrs = new Map<string, string>();
  for (const a of el.attributes) {
    if (!attrs.has(a.name)) attrs.set(a.name, a.value);
  }
  // A data:-URL <img> ignores un-namespaced SVG, so the root always carries
  // the namespace whether or not the input declared it.
  if (isRoot) attrs.set("xmlns", SVG_XMLNS);

  let open = `<${el.name}`;
  for (const name of [...attrs.keys()].sort(compareAttrNames)) {
    open += ` ${name}="${escapeAttr(attrs.get(name)!)}"`;
  }

  const inner = writeChildren(el);
  return inner === "" ? `${open}/>` : `${open}>${inner}</${el.name}>`;
}

function writeChildren(el: SvgElement): string {
  const keepText = TEXT_ELEMENTS.has(el.name);
  let out = "";
  for (const child of el.children) {
    if (child.kind === "text") {
      // Inside text-bearing elements every character matters; elsewhere the
      // validator has already guaranteed the node is whitespace-only, and
      // the canonical form drops that layout-inert whitespace.
      if (keepText) out += escapeText(child.value);
    } else {
      out += writeElement(child, false);
    }
  }
  return out;
}
