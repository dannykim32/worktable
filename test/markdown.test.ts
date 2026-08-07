// Shared markdown AST (src/shared/markdown.ts) + the server HTML-string emitter
// (src/server/markdownHtml.ts). The parser is the SINGLE source of truth behind
// both the live canvas DOM builder and the export; these cases pin the AST shape
// and the emitter's escaping (a security surface — the export opens unsandboxed).
import { describe, expect, test } from "bun:test";
import { parseMarkdown, type MdBlock } from "../src/shared/markdown.js";
import { renderMarkdownToHtml } from "../src/server/markdownHtml.js";

const FENCE = "```";

describe("parseMarkdown — AST shape", () => {
  test("heading carries level + inline text", () => {
    expect(parseMarkdown("## Hello")).toEqual([
      { type: "heading", level: 2, children: [{ kind: "text", value: "Hello" }] },
    ]);
  });

  test("bold and italic become strong/em inline nodes", () => {
    const [p] = parseMarkdown("a **b** and *c*") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.type).toBe("paragraph");
    expect(p.children).toEqual([
      { kind: "text", value: "a " },
      { kind: "strong", children: [{ kind: "text", value: "b" }] },
      { kind: "text", value: " and " },
      { kind: "em", children: [{ kind: "text", value: "c" }] },
    ]);
  });

  test("inline code is an opaque code node", () => {
    const [p] = parseMarkdown("run `npm test` now") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children).toEqual([
      { kind: "text", value: "run " },
      { kind: "code", value: "npm test" },
      { kind: "text", value: " now" },
    ]);
  });

  test("fenced code block keeps body verbatim + lang", () => {
    expect(parseMarkdown(`${FENCE}js\nconst x = 1;\n${FENCE}`)).toEqual([
      { type: "code", value: "const x = 1;", lang: "js" },
    ]);
  });

  test("nested list is a list node with a nested list inside its item", () => {
    const [list] = parseMarkdown("- one\n- two\n  - deep") as [Extract<MdBlock, { type: "list" }>];
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]!.children).toEqual([{ kind: "text", value: "one" }]);
    const nested = list.items[1]!.children.find(
      (c) => "type" in c && c.type === "list",
    );
    expect(nested).toBeDefined();
  });

  test("ordered list flag", () => {
    const [list] = parseMarkdown("1. a\n2. b") as [Extract<MdBlock, { type: "list" }>];
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
  });

  test("GFM table → header + rows of inline cells", () => {
    const [t] = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |") as [Extract<MdBlock, { type: "table" }>];
    expect(t.type).toBe("table");
    expect(t.header).toEqual([
      [{ kind: "text", value: "A" }],
      [{ kind: "text", value: "B" }],
    ]);
    expect(t.rows).toEqual([
      [[{ kind: "text", value: "1" }], [{ kind: "text", value: "2" }]],
    ]);
  });

  test("external link → link node, external kind + safe href", () => {
    const [p] = parseMarkdown("[docs](https://example.com)") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children).toEqual([
      {
        kind: "link",
        href: "https://example.com",
        linkKind: "external",
        children: [{ kind: "text", value: "docs" }],
      },
    ]);
  });

  test("#fragment link → link node, fragment kind", () => {
    const [p] = parseMarkdown("[jump](#details)") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children[0]).toEqual({
      kind: "link",
      href: "#details",
      linkKind: "fragment",
      children: [{ kind: "text", value: "jump" }],
    });
  });

  test("bare URL autolinks to an external link node", () => {
    const [p] = parseMarkdown("see https://a.test/x here") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children[1]).toEqual({
      kind: "link",
      href: "https://a.test/x",
      linkKind: "external",
      children: [{ kind: "text", value: "https://a.test/x" }],
    });
  });

  test("disallowed scheme link degrades to literal text (no link node)", () => {
    const [p] = parseMarkdown("[x](javascript:alert(1))") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children).toEqual([{ kind: "text", value: "[x](javascript:alert(1))" }]);
  });

  test("image collapses to its alt text — no link/image node", () => {
    const [p] = parseMarkdown("![the alt](https://x/y.png)") as [Extract<MdBlock, { type: "paragraph" }>];
    expect(p.children).toEqual([{ kind: "text", value: "the alt" }]);
  });
});

describe("renderMarkdownToHtml — happy path", () => {
  test("headings + lists render as real tags, not raw markdown", () => {
    const out = renderMarkdownToHtml("# Title\n\n- a\n- b");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(out).not.toContain("# Title");
    expect(out).not.toContain("- a");
  });

  test("fenced code renders inside <pre><code>", () => {
    const out = renderMarkdownToHtml(`${FENCE}\nx=1\n${FENCE}`);
    expect(out).toContain("<pre><code>x=1</code></pre>");
  });

  test("table renders thead/tbody", () => {
    const out = renderMarkdownToHtml("| A |\n|---|\n| 1 |");
    expect(out).toContain("<table><thead><tr><th>A</th></tr></thead>");
    expect(out).toContain("<tbody><tr><td>1</td></tr></tbody></table>");
  });

  test("external link gets target/rel; fragment link navigates in place", () => {
    expect(renderMarkdownToHtml("[d](https://e.com)")).toContain(
      `<a href="https://e.com" target="_blank" rel="noopener noreferrer">d</a>`,
    );
    const frag = renderMarkdownToHtml("[j](#sec)");
    expect(frag).toContain(`<a href="#sec">j</a>`);
    expect(frag).not.toContain("target=");
  });
});

describe("renderMarkdownToHtml — XSS matrix (security surface)", () => {
  test("raw <script> becomes escaped text, never a live tag", () => {
    const out = renderMarkdownToHtml("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("raw <img onerror> becomes escaped text", () => {
    const out = renderMarkdownToHtml("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("javascript: link never becomes an <a>", () => {
    const out = renderMarkdownToHtml("[x](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("[x](javascript:alert(1))");
  });

  test("entity/scheme-obfuscated link is inert (rendered as text)", () => {
    // A colon-obfuscated / control-char scheme is rejected by safeHref → text.
    const out = renderMarkdownToHtml("[x](java\tscript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("javascript:alert(1)");
  });

  test("raw <b> in text is escaped, not emitted as a tag", () => {
    const out = renderMarkdownToHtml("this is <b>bold-ish</b>");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;bold-ish&lt;/b&gt;");
  });

  test("a marker link inside strong text is placed AFTER the <strong>, never nested in an <a>", () => {
    // Emphasis is atomic for marker placement, so a marker due inside it lands
    // after the closing tag — and markers are never nested in a link.
    const out = renderMarkdownToHtml("**bold words**", [
      { blockIndex: 0, quote: "bold words", html: "<a class='wt-mark'>[1]</a>" },
    ]);
    expect(out).toContain("<strong>bold words</strong><a class='wt-mark'>[1]</a>");
  });
});
