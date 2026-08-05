// Issue 24 canvas unit layer: the own-built markdown→DOM renderer. Covers the
// golden supported subset, the BLOCKING XSS canaries (script / raw img /
// javascript: / data: / raw HTML all inert & literal), the link protocol
// allowlist, graceful degradation of malformed markdown, and ask-back on a
// rendered prose artifact (anchor + inline reply, issue 22).
import { describe, expect, test } from "bun:test";
import type { ProseContent } from "../src/shared/artifacts.js";
import type { AnsweredAskback, CanvasApi } from "../src/canvas/api.js";
import { renderProse } from "../src/canvas/components/prose.js";
import { rendererRegistry } from "../src/canvas/components/registry.js";
import { anchorFromRange } from "../src/canvas/askback.js";
import { Drawer } from "../src/canvas/drawer.js";
import type { Anchor } from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";

function prose(markdown: string): ProseContent {
  return { type: "prose", title: "t", markdown };
}

// Backticks are awkward inside a template literal, so the golden fixture is
// assembled from lines.
const FENCE = "```";
const GOLDEN = [
  "# Title",
  "",
  "Some **bold** and *italic* and `code`.",
  "",
  `${FENCE}js`,
  "const x = 1;",
  FENCE,
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "> a quote",
  "",
  "| A | B |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "[docs](https://example.com)",
  "",
  "---",
].join("\n");

describe("prose renderer — golden supported subset", () => {
  test("headings, emphasis, code, fenced block, nested lists, quote, table, link, hr", () => {
    const { mount } = makeDom();
    rendererRegistry.prose(prose(GOLDEN), mount);
    expect(mount.classList.contains("prose")).toBe(true);

    // ATX heading.
    const h1 = mount.querySelector("h1")!;
    expect(h1.textContent).toBe("Title");

    // Inline emphasis + code inside the paragraph.
    const p = mount.querySelector("p")!;
    expect(p.querySelector("strong")!.textContent).toBe("bold");
    expect(p.querySelector("em")!.textContent).toBe("italic");
    expect(p.querySelector("code")!.textContent).toBe("code");

    // Fenced code block with lang label, verbatim body.
    const pre = mount.querySelector("pre")!;
    const preCode = pre.querySelector("code")!;
    expect(preCode.textContent).toBe("const x = 1;");
    expect(preCode.dataset.lang).toBe("js");

    // Nested unordered list: two items, the second holds a sub-list.
    const topList = mount.querySelector("ul")!;
    const topItems = [...topList.children].filter((c) => c.tagName === "LI");
    expect(topItems).toHaveLength(2);
    expect(topItems[0]!.textContent).toBe("one");
    const nested = topItems[1]!.querySelector("ul")!;
    expect(nested.querySelector("li")!.textContent).toBe("nested");

    // Blockquote wraps a paragraph.
    expect(mount.querySelector("blockquote p")!.textContent).toBe("a quote");

    // GFM table.
    const table = mount.querySelector("table")!;
    expect([...table.querySelectorAll("thead th")].map((n) => n.textContent)).toEqual([
      "A",
      "B",
    ]);
    expect([...table.querySelectorAll("tbody td")].map((n) => n.textContent)).toEqual([
      "1",
      "2",
    ]);

    // Allowlisted link → a real <a> with safe rel/target.
    const a = mount.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.textContent).toBe("docs");

    // Horizontal rule.
    expect(mount.querySelector("hr")).not.toBeNull();

    // Every top-level block carries its anchor index in DOM order.
    const indices = [...mount.children].map(
      (c) => (c as HTMLElement).dataset.blockIndex,
    );
    expect(indices).toEqual(indices.map((_, i) => String(i)));
  });
});

describe("prose renderer — XSS canaries (blocking)", () => {
  test("raw <script> and <img onerror> render as literal text, never as nodes", () => {
    const { mount } = makeDom();
    const payload = "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>";
    renderProse(prose(payload), mount);
    // Nothing was parsed into an executable/loading element.
    expect(mount.querySelectorAll("script, img")).toHaveLength(0);
    // The hostile markup survives as visible literal text.
    expect(mount.textContent).toContain("<script>alert(1)</script>");
    expect(mount.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("javascript: and data: links render as plain text, not <a>", () => {
    const { mount } = makeDom();
    renderProse(
      prose("[x](javascript:alert(1)) and [y](data:text/html,<script>1</script>)"),
      mount,
    );
    // No anchor at all for a disallowed scheme…
    expect(mount.querySelectorAll("a")).toHaveLength(0);
    expect(mount.querySelector('a[href^="javascript"]')).toBeNull();
    expect(mount.querySelector('a[href^="data"]')).toBeNull();
    // …and still no script/img smuggled through the data: payload.
    expect(mount.querySelectorAll("script, img")).toHaveLength(0);
    // The whole construct appears as literal text.
    expect(mount.textContent).toContain("[x](javascript:alert(1))");
  });

  test("markdown image renders alt text only — no <img>", () => {
    const { mount } = makeDom();
    renderProse(prose("![the alt text](https://example.com/x.png)"), mount);
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.textContent).toContain("the alt text");
    expect(mount.textContent).not.toContain("example.com");
  });
});

describe("prose renderer — link protocol allowlist", () => {
  test("http / https / mailto become anchors; everything else is plain text", () => {
    for (const url of ["http://a.test", "https://a.test", "mailto:a@b.test"]) {
      const { mount } = makeDom();
      renderProse(prose(`[link](${url})`), mount);
      const a = mount.querySelector("a");
      expect(a).not.toBeNull();
      expect(a!.getAttribute("href")).toBe(url);
    }
    for (const url of [
      "vbscript:msgbox(1)",
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative/path",
      "#anchor",
      "ftp://a.test",
    ]) {
      const { mount } = makeDom();
      renderProse(prose(`[link](${url})`), mount);
      expect(mount.querySelector("a")).toBeNull();
      expect(mount.textContent).toContain(`[link](${url})`);
    }
  });
});

describe("prose renderer — malformed markdown degrades, never throws", () => {
  test("unclosed fence, dangling bracket, and unbalanced emphasis all survive", () => {
    const cases = [
      "```js\nconst x = 1;\nno closing fence here",
      "a dangling [ bracket and [x](no-close",
      "**unclosed bold and *lonely italic",
      "| broken | table\nwith no delimiter row",
      "",
    ];
    for (const md of cases) {
      const { mount } = makeDom();
      expect(() => renderProse(prose(md), mount)).not.toThrow();
    }
    // The unclosed fence still yields a <pre> with the collected body.
    const { mount } = makeDom();
    renderProse(prose("```\nkept as code\n"), mount);
    expect(mount.querySelector("pre code")!.textContent).toContain("kept as code");
  });
});

// ── Ask-back on a rendered prose artifact (AC 6) ────────────────────────
const ARTIFACT = "a_0000abcd";

function makeProseCard(markdown: string) {
  const { document, mount } = makeDom();
  const card = document.createElement("section");
  card.className = "artifact";
  card.dataset.artifactId = ARTIFACT;
  const body = document.createElement("div");
  body.className = "body";
  renderProse(prose(markdown), body);
  card.appendChild(body);
  mount.appendChild(card);
  return { document, galleryRoot: mount, card, body };
}

function stubApi(answered: AnsweredAskback[]): CanvasApi {
  return { getAnsweredAskbacks: async () => answered } as unknown as CanvasApi;
}

describe("prose renderer — ask-back + inline answers (issue 22) work on prose", () => {
  test("a selection inside a rendered block yields an anchor with the quote", () => {
    const { document, body } = makeProseCard(
      "This is the first paragraph.\n\nSecond one.",
    );
    const block = body.querySelector('[data-block-index="0"]') as HTMLElement;
    expect(block.tagName).toBe("P");
    const textNode = block.firstChild!; // "This is the first paragraph."
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4); // "This"

    const anchor = anchorFromRange(range, block, ARTIFACT, 1);
    expect(anchor.artifact_id).toBe(ARTIFACT);
    expect(anchor.block_index).toBe(0);
    expect(anchor.quote).toBe("This");
    expect(anchor.char_start).toBe(0);
    expect(anchor.char_end).toBe(4);
  });

  test("a drawer answer + marker land on the anchored prose block (issue 27)", async () => {
    const { document, galleryRoot, body } = makeProseCard(
      "This is the first paragraph.\n\nSecond one.",
    );
    const block = body.querySelector('[data-block-index="0"]') as HTMLElement;
    const anchor: Anchor = {
      artifact_id: ARTIFACT,
      version: 1,
      block_index: 0,
      quote: "This",
    };
    const item: AnsweredAskback = {
      id: "ab_11112222",
      anchor,
      question: "what section is this?",
      answer: { text: "the opening paragraph.", answered_at: "2026-08-03T00:00:00.000Z" },
    };
    const drawer = new Drawer(document, {
      api: stubApi([item]),
      galleryRoot,
      artifactType: () => "prose",
    });
    await drawer.loadAnswered();

    // The answer shows in the drawer conversation.
    expect(drawer.panel.querySelector(".drawer-entry-text")!.textContent).toBe(
      "the opening paragraph.",
    );
    // An in-content marker is placed as the anchored block's next sibling.
    const marker = galleryRoot.querySelector(".anchor-marker") as HTMLElement;
    expect(marker).not.toBeNull();
    expect(block.nextSibling).toBe(marker);
  });
});
