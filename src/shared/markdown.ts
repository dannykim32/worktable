// Zero-dependency, DOM-FREE markdown parser (issue 24 lineage). It produces a
// typed AST for a practical subset — the SINGLE source of parsing truth shared
// by two emitters:
//   · the live canvas DOM builder (src/canvas/components/prose.ts), which walks
//     this AST with createElement/textContent ONLY, and
//   · the standalone-export HTML-string emitter (src/server/markdownHtml.ts),
//     which walks the SAME AST escaping every text node.
// Neither emitter re-parses; both inherit identical link/scheme security.
//
// Security spine lives HERE, at the parse boundary: link hrefs are validated
// against a scheme ALLOWLIST (http/https/mailto) with control-char rejection,
// or resolved as a same-page `#fragment`; anything else degrades to literal
// text and never becomes a link node. Raw HTML in the source (`<script>`,
// `<img onerror>`, any `<tag>`) is NEVER special-cased — it lands in text
// nodes, so each emitter escapes it for free. Do NOT add raw-HTML passthrough.
//
// Covered subset: ATX headings, paragraphs (with soft/hard breaks), bold,
// italic, inline code, fenced code blocks, ordered/unordered nested lists,
// GFM tables, blockquotes, horizontal rules, allowlisted + fragment links,
// bare-URL autolinks, and `![alt](url)` images rendered as their alt text.

// ── AST ──────────────────────────────────────────────────────────────────

/** A link destination is either an allowlisted external URL (opens a new tab)
 *  or a same-page `#fragment` (navigates in place). */
export type LinkKind = "external" | "fragment";

export type MdInline =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; linkKind: LinkKind; children: MdInline[] }
  /** A hard line break inside a paragraph (`  `/`\` at line end) → <br>. */
  | { kind: "hardbreak" };

/** A list item's content: inline runs plus any nested list (the only block a
 *  list item ever nests in this grammar). */
export type MdListItemChild = MdInline | MdList;

export interface MdListItem {
  children: MdListItemChild[];
}

export interface MdList {
  type: "list";
  ordered: boolean;
  items: MdListItem[];
}

export type MdBlock =
  | { type: "heading"; level: number; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; value: string; lang: string }
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "table"; header: MdInline[][]; rows: MdInline[][][] }
  | { type: "hr" }
  | MdList;

// ── Link protocol allowlist ─────────────────────────────────────────────
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Return a safe href if the URL's scheme is on the allowlist, else null.
 *  A URL without an explicit scheme (relative/anchor) is NOT on the allowlist,
 *  so it renders as plain text — the strictest reading of the spec, and it
 *  closes colon-obfuscation tricks by construction. */
export function safeHref(raw: string): string | null {
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
export function fragmentHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length < 2 || url[0] !== "#") return null;
  if (/[\u0000-\u0020]/.test(url)) return null;
  return url;
}

/** Match a bare absolute http(s) URL at the start of `text`. Trailing prose
 *  punctuation is not part of the URL, and a trailing `)` counts only when a
 *  matching `(` is inside the URL (Wikipedia-style paths). */
const AUTOLINK = /^https?:\/\/[^\s<>]+/;

export function matchAutolink(text: string): string | null {
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
export function matchLink(text: string, start: number): LinkMatch | null {
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
export function findClose(text: string, from: number, marker: string): number {
  const len = marker.length;
  for (let i = from; i <= text.length - len; i++) {
    if (!text.startsWith(marker, i)) continue;
    if (len === 1 && (text[i - 1] === marker || text[i + 1] === marker)) continue;
    return i;
  }
  return -1;
}

/** Parse inline markdown in `text` into an inline-node array. `inAnchor`
 *  suppresses autolinking while parsing a link's label (no <a> inside <a>). */
export function parseInline(text: string, inAnchor = false): MdInline[] {
  const out: MdInline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") {
      out.push({ kind: "text", value: buffer });
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
        out.push({ kind: "code", value: code });
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

    // Link `[text](url)` → a link node for an allowlisted scheme or a same-page
    // `#fragment` destination.
    if (c === "[") {
      const m = matchLink(text, i);
      if (m) {
        const external = safeHref(m.url);
        const fragment = external ? null : fragmentHref(m.url);
        if (external || fragment) {
          flush();
          out.push({
            kind: "link",
            href: (external ?? fragment)!,
            linkKind: external ? "external" : "fragment",
            children: parseInline(m.text, true),
          });
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
        out.push({
          kind: "link",
          href: url,
          linkKind: "external",
          children: [{ kind: "text", value: url }],
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
        out.push({
          kind: "strong",
          children: parseInline(text.slice(i + 2, close), inAnchor),
        });
        i = close + 2;
        continue;
      }
    }

    // Emphasis `*` / `_`.
    if (c === "*" || c === "_") {
      const close = findClose(text, i + 1, c);
      if (close !== -1) {
        flush();
        out.push({
          kind: "em",
          children: parseInline(text.slice(i + 1, close), inAnchor),
        });
        i = close + 1;
        continue;
      }
    }

    buffer += c;
    i++;
  }
  flush();
  return out;
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
 *  which is a list item. Returns the list node and the next line index. */
function parseList(
  lines: string[],
  start: number,
): { node: MdList; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const list: MdList = { type: "list", ordered, items: [] };
  let currentItem: MdListItem | null = null;
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
      if (currentItem && /^\s+\S/.test(line)) {
        currentItem.children.push({ kind: "text", value: " " });
        currentItem.children.push(...parseInline(line.trim()));
        i++;
        continue;
      }
      break;
    }
    const indent = m[1]!.length;
    if (indent < baseIndent) break; // dedent → this list ends
    if (indent > baseIndent && currentItem) {
      const nested = parseList(lines, i);
      currentItem.children.push(nested.node);
      i = nested.next;
      continue;
    }
    currentItem = { children: parseInline(m[3]!) };
    list.items.push(currentItem);
    i++;
  }
  return { node: list, next: i };
}

/** Parse `markdown` into an array of top-level blocks. */
export function parseMarkdown(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
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
      const closeRe = new RegExp(
        `^\\s*${marker === "`" ? "`" : "~"}{${minLen},}\\s*$`,
      );
      for (; j < lines.length; j++) {
        if (closeRe.test(lines[j]!)) {
          closed = true;
          break;
        }
        body.push(lines[j]!);
      }
      blocks.push({ type: "code", value: body.join("\n"), lang });
      i = closed ? j + 1 : j; // unclosed fence: consume to EOF, never throw
      continue;
    }

    // ATX heading.
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      i++;
      continue;
    }

    // Horizontal rule (checked before lists: `---` has no item content).
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
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
      blocks.push({ type: "blockquote", children: parseMarkdown(inner.join("\n")) });
      i = j;
      continue;
    }

    // GFM table: a pipe row followed by a delimiter row.
    if (line.includes("|") && lines[i + 1] && TABLE_DELIM.test(lines[i + 1]!)) {
      const header = splitTableRow(line).map((cell) => parseInline(cell));
      const rows: MdInline[][][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const rowLine = lines[j]!;
        if (rowLine.trim() === "" || !rowLine.includes("|")) break;
        rows.push(splitTableRow(rowLine).map((cell) => parseInline(cell)));
      }
      blocks.push({ type: "table", header, rows });
      i = j;
      continue;
    }

    // List (unordered or ordered, with nesting).
    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, i);
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
        (l.includes("|") &&
          lines[j + 1] !== undefined &&
          TABLE_DELIM.test(lines[j + 1]!))
      ) {
        break;
      }
      para.push(l);
    }
    const children: MdInline[] = [];
    para.forEach((raw, idx) => {
      // Hard break: a line ending in 2+ spaces or a backslash → <br>.
      const hardBreak = /( {2,}|\\)$/.test(raw);
      children.push(...parseInline(raw.replace(/(?: {2,}|\\)$/, "").trimStart()));
      if (idx < para.length - 1) {
        children.push(hardBreak ? { kind: "hardbreak" } : { kind: "text", value: " " });
      }
    });
    blocks.push({ type: "paragraph", children });
    i = j;
  }

  return blocks;
}
