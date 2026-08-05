// Prose/markdown renderer (issue 24, ADR-0002 TRUSTED lane): an own-built,
// ZERO-DEP markdown→DOM builder for a practical subset. This is NOT the
// free-form HTML hatch — it opens no HTML hole.
//
// Security spine (mirrors the SVG sanitizer's spirit): every element is made
// with createElement and every string lands via textContent / createTextNode.
// There is NO innerHTML / insertAdjacentHTML / template-into-DOM anywhere, so
// raw HTML in the markdown (`<script>`, `<img onerror>`, any `<tag>`) is never
// parsed as HTML — it becomes literal, escaped text for free. Do NOT introduce
// a markdown library: they emit HTML strings that would need innerHTML.
//
// Additional rules:
//  · Links: the href is validated against a protocol ALLOWLIST (http, https,
//    mailto only). A pure in-page `#fragment` href renders as a same-page
//    anchor (no new tab). Bare absolute http(s) URLs in plain text autolink.
//    Anything else — javascript:, data:, vbscript:, relative or colon tricks —
//    renders as literal text, never an <a>. Relative hrefs are literal on
//    purpose: the canvas has no base to honestly resolve them against.
//  · Markdown images `![alt](url)` render the alt text only; no <img> (v1).
//  · Malformed markdown degrades to text and never throws out of the renderer.
import type { ArtifactContent } from "../../shared/artifacts.js";

// ── Link protocol allowlist ─────────────────────────────────────────────
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Return a safe href if the URL's scheme is on the allowlist, else null.
 *  A URL without an explicit scheme (relative/anchor) is NOT on the allowlist,
 *  so it renders as plain text — the strictest reading of the spec, and it
 *  closes colon-obfuscation tricks by construction. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  // Any space or C0 control char (incl. embedded newline/tab) disqualifies
  // the URL: these are the classic ways to smuggle `java\nscript:` past a
  // naive scheme check. \u0000-\u0020 covers space + all control chars.
  if (/[\u0000-\u0020]/.test(url)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!scheme) return null; // no scheme → not on the allowlist → plain text
  return ALLOWED_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? url : null;
}

/** Return a same-page fragment href (`#section`) or null. Subject to the same
 *  control-char discipline as safeHref; a bare `#` is not a destination. */
function fragmentHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length < 2 || url[0] !== "#") return null;
  if (/[\u0000-\u0020]/.test(url)) return null;
  return url;
}

/** Append an <a> for an already-validated destination. External (allowlisted
 *  scheme) links open in a new tab with rel="noopener noreferrer"; same-page
 *  fragment links navigate in place. */
function appendAnchor(
  doc: Document,
  parent: Node,
  href: string,
  fill: (a: HTMLElement) => void,
): void {
  const a = doc.createElement("a");
  a.setAttribute("href", href);
  if (!href.startsWith("#")) {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("target", "_blank");
  }
  fill(a);
  parent.appendChild(a);
}

/** Match a bare absolute http(s) URL at the start of `text`. Trailing prose
 *  punctuation is not part of the URL, and a trailing `)` counts only when a
 *  matching `(` is inside the URL (Wikipedia-style paths). */
const AUTOLINK = /^https?:\/\/[^\s<>]+/;

function matchAutolink(text: string): string | null {
  const m = AUTOLINK.exec(text);
  if (!m) return null;
  let url = m[0]!;
  for (;;) {
    const last = url[url.length - 1]!;
    if (".,;:!?'\"".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  // Require something after the scheme's `//` (e.g. reject a bare `https://`).
  return /^https?:\/\/./.test(url) ? url : null;
}

// ── Inline parsing ──────────────────────────────────────────────────────
// Order of precedence: code span (opaque) > image > link > strong > emphasis.

interface LinkMatch {
  text: string;
  url: string;
  end: number;
}

/** Match `[label](url)` (or the label span of `![alt](url)`) starting at a
 *  `[`. Balances nested brackets in the label; strips a `(url "title")` title.
 *  Returns null when it is not a well-formed link (→ handled as literal text). */
function matchLink(text: string, start: number): LinkMatch | null {
  let depth = 0;
  let close = -1;
  for (let j = start + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) {
        close = j;
        break;
      }
      depth--;
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null;
  const paren = text.indexOf(")", close + 2);
  if (paren === -1) return null;
  let url = text.slice(close + 2, paren).trim();
  const space = url.search(/\s/); // drop an optional `"title"` after the url
  if (space !== -1) url = url.slice(0, space);
  return { text: text.slice(start + 1, close), url, end: paren + 1 };
}

/** Find the closing index of a single/double emphasis marker from `from`.
 *  For a single-char marker, skips positions that are part of a doubled run so
 *  `*a **b** c*` still closes on the lone `*`. Returns -1 when unclosed. */
function findClose(text: string, from: number, marker: string): number {
  const len = marker.length;
  for (let i = from; i <= text.length - len; i++) {
    if (!text.startsWith(marker, i)) continue;
    if (len === 1 && (text[i - 1] === marker || text[i + 1] === marker)) continue;
    return i;
  }
  return -1;
}

/** Parse inline markdown in `text`, appending Text/Element nodes to `parent`.
 *  Every element is createElement; every string is a text node. `inAnchor`
 *  suppresses autolinking while filling a link's label (no <a> inside <a>). */
function parseInline(
  doc: Document,
  text: string,
  parent: Node,
  inAnchor = false,
): void {
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") {
      parent.appendChild(doc.createTextNode(buffer));
      buffer = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;

    // Inline code — opaque: the content is literal, no nested parsing.
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close !== -1) {
        flush();
        let code = text.slice(i + run, close);
        // CommonMark: strip one space on each side when the span is padded.
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ")) {
          code = code.slice(1, -1);
        }
        const el = doc.createElement("code");
        el.textContent = code;
        parent.appendChild(el);
        i = close + run;
        continue;
      }
    }

    // Image `![alt](url)` → alt text only (no <img> in v1).
    if (c === "!" && text[i + 1] === "[") {
      const m = matchLink(text, i + 1);
      if (m) {
        buffer += m.text;
        i = m.end;
        continue;
      }
    }

    // Link `[text](url)` → <a> for an allowlisted scheme or a same-page
    // `#fragment` destination.
    if (c === "[") {
      const m = matchLink(text, i);
      if (m) {
        const href = safeHref(m.url) ?? fragmentHref(m.url);
        if (href) {
          flush();
          appendAnchor(doc, parent, href, (a) =>
            parseInline(doc, m.text, a, true),
          );
        } else {
          // Disallowed scheme / relative path → the construct is literal text.
          buffer += text.slice(i, m.end);
        }
        i = m.end;
        continue;
      }
    }

    // Bare absolute http(s) URL in plain text → autolink (suppressed inside a
    // link label — no <a> inside <a>).
    if (
      c === "h" &&
      !inAnchor &&
      (text.startsWith("http://", i) || text.startsWith("https://", i))
    ) {
      const url = matchAutolink(text.slice(i));
      if (url) {
        flush();
        appendAnchor(doc, parent, url, (a) => {
          a.textContent = url;
        });
        i += url.length;
        continue;
      }
    }

    // Strong `**` / `__`.
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const marker = c + c;
      const close = findClose(text, i + 2, marker);
      if (close !== -1) {
        flush();
        const strong = doc.createElement("strong");
        parseInline(doc, text.slice(i + 2, close), strong, inAnchor);
        parent.appendChild(strong);
        i = close + 2;
        continue;
      }
    }

    // Emphasis `*` / `_`.
    if (c === "*" || c === "_") {
      const close = findClose(text, i + 1, c);
      if (close !== -1) {
        flush();
        const em = doc.createElement("em");
        parseInline(doc, text.slice(i + 1, close), em, inAnchor);
        parent.appendChild(em);
        i = close + 1;
        continue;
      }
    }

    buffer += c;
    i++;
  }
  flush();
}

// ── Block parsing ───────────────────────────────────────────────────────
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

/** Split a GFM table row on unescaped pipes, trimming the outer borders. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

/** Parse a bullet/ordered list (with nesting) starting at `lines[start]`,
 *  which is a list item. Returns the list element and the next line index. */
function parseList(
  doc: Document,
  lines: string[],
  start: number,
): { node: HTMLElement; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const list = doc.createElement(ordered ? "ol" : "ul");
  let currentLi: HTMLElement | null = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // A blank line continues the list only if another item follows directly.
      if (lines[i + 1] && LIST_ITEM.test(lines[i + 1]!)) {
        i++;
        continue;
      }
      break;
    }
    const m = LIST_ITEM.exec(line);
    if (!m) {
      // Indented continuation text under the current item.
      if (currentLi && /^\s+\S/.test(line)) {
        currentLi.appendChild(doc.createTextNode(" "));
        parseInline(doc, line.trim(), currentLi);
        i++;
        continue;
      }
      break;
    }
    const indent = m[1]!.length;
    if (indent < baseIndent) break; // dedent → this list ends
    if (indent > baseIndent && currentLi) {
      const nested = parseList(doc, lines, i);
      currentLi.appendChild(nested.node);
      i = nested.next;
      continue;
    }
    currentLi = doc.createElement("li");
    parseInline(doc, m[3]!, currentLi);
    list.appendChild(currentLi);
    i++;
  }
  return { node: list, next: i };
}

/** Parse `markdown` into an array of top-level block elements. */
function parseBlocks(doc: Document, markdown: string): HTMLElement[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: HTMLElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]![0]!; // ` or ~
      const minLen = fence[2]!.length;
      const lang = fence[3] ?? "";
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      const closeRe = new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${minLen},}\\s*$`);
      for (; j < lines.length; j++) {
        if (closeRe.test(lines[j]!)) {
          closed = true;
          break;
        }
        body.push(lines[j]!);
      }
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = body.join("\n");
      if (lang) code.dataset.lang = lang;
      pre.appendChild(code);
      blocks.push(pre);
      i = closed ? j + 1 : j; // unclosed fence: consume to EOF, never throw
      continue;
    }

    // ATX heading.
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const h = doc.createElement(`h${level}`);
      parseInline(doc, heading[2]!, h);
      blocks.push(h);
      i++;
      continue;
    }

    // Horizontal rule (checked before lists: `---` has no item content).
    if (HR.test(line)) {
      blocks.push(doc.createElement("hr"));
      i++;
      continue;
    }

    // Blockquote — collect consecutive `>` lines, recurse on the inner text.
    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      let j = i;
      for (; j < lines.length && BLOCKQUOTE.test(lines[j]!); j++) {
        inner.push(lines[j]!.replace(BLOCKQUOTE, ""));
      }
      const quote = doc.createElement("blockquote");
      for (const child of parseBlocks(doc, inner.join("\n"))) {
        quote.appendChild(child);
      }
      blocks.push(quote);
      i = j;
      continue;
    }

    // GFM table: a pipe row followed by a delimiter row.
    if (line.includes("|") && lines[i + 1] && TABLE_DELIM.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const table = doc.createElement("table");
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of header) {
        const th = doc.createElement("th");
        parseInline(doc, cell, th);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      let j = i + 2;
      for (; j < lines.length; j++) {
        const rowLine = lines[j]!;
        if (rowLine.trim() === "" || !rowLine.includes("|")) break;
        const tr = doc.createElement("tr");
        for (const cell of splitTableRow(rowLine)) {
          const td = doc.createElement("td");
          parseInline(doc, cell, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      blocks.push(table);
      i = j;
      continue;
    }

    // List (unordered or ordered, with nesting).
    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(doc, lines, i);
      blocks.push(node);
      i = next;
      continue;
    }

    // Paragraph: consecutive non-blank lines that begin no other block.
    const para: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (
        l.trim() === "" ||
        HEADING.test(l) ||
        FENCE.test(l) ||
        HR.test(l) ||
        BLOCKQUOTE.test(l) ||
        LIST_ITEM.test(l) ||
        (l.includes("|") && lines[j + 1] !== undefined && TABLE_DELIM.test(lines[j + 1]!))
      ) {
        break;
      }
      para.push(l);
    }
    const p = doc.createElement("p");
    para.forEach((raw, idx) => {
      // Hard break: a line ending in 2+ spaces or a backslash → <br>.
      const hardBreak = /( {2,}|\\)$/.test(raw);
      parseInline(doc, raw.replace(/(?: {2,}|\\)$/, "").trimStart(), p);
      if (idx < para.length - 1) {
        p.appendChild(
          hardBreak ? doc.createElement("br") : doc.createTextNode(" "),
        );
      }
    });
    blocks.push(p);
    i = j;
  }

  return blocks;
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
    const blocks = parseBlocks(doc, content.markdown);
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
