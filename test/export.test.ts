// Standalone HTML export (src/server/export.ts): trusted shell + CSP around
// verbatim model html; EVERY text-origin field escaped. The escaping cases are
// the point — an export opens in a browser with no sandbox around our shell.
import { describe, expect, test } from "bun:test";
import {
  buildExportHtml,
  escapeHtml,
  exportFilename,
} from "../src/server/export.js";
import type { ArtifactMeta, Askback } from "../src/shared/artifacts.js";

const meta = (over: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: "a_0000abcd",
  type: "html",
  title: "Plain title",
  latest: 2,
  created_at: "2026-08-06T00:00:00.000Z",
  updated_at: "2026-08-06T00:00:00.000Z",
  ...over,
});

const ask = (over: Partial<Askback> = {}): Askback =>
  ({
    id: "ab_1",
    anchor: { artifact_id: "a_0000abcd", version: 1, block_index: 0, quote: "a quote" },
    question: "a question?",
    state: "delivered",
    created_at: "t",
    ...over,
  }) as Askback;

describe("export builder", () => {
  test("shell: CSP meta (no scripts, no network), title, version, footer", () => {
    const out = buildExportHtml({
      meta: meta(),
      content: { type: "html", title: "Plain title", html: "<p>hi</p>" },
      conversation: null,
      exportedAt: "2026-08-06",
    });
    expect(out).toContain(
      `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`,
    );
    expect(out).toContain("<title>Plain title</title>");
    expect(out).toContain("v2 · exported 2026-08-06");
    expect(out).toContain("static copy");
    // Model html embedded VERBATIM.
    expect(out).toContain("<p>hi</p>");
    // No conversation section without the flag (the CSS class definition is
    // always in the shell; the SECTION must not be).
    expect(out).not.toContain('<section class="wt-conv">');
  });

  test("XSS: a hostile TITLE is escaped, never markup", () => {
    const out = buildExportHtml({
      meta: meta({ title: `<script>window.x=1</script>"'` }),
      content: { type: "html", title: "t", html: "" },
      conversation: null,
      exportedAt: "d",
    });
    expect(out).not.toContain("<script>window.x=1");
    expect(out).toContain("&lt;script&gt;");
  });

  test("XSS: prose markdown cannot break out of its pre (</pre><script>)", () => {
    const payload = "</pre><script>window.x=1</script>";
    const out = buildExportHtml({
      meta: meta({ type: "prose" }),
      content: { type: "prose", title: "t", markdown: payload },
      conversation: null,
      exportedAt: "d",
    });
    expect(out).not.toContain("</pre><script>");
    expect(out).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  test("XSS: conversation quote/question/answer are all escaped; unanswered is honest", () => {
    const evil = `<img src=x onerror="window.x=1">`;
    const out = buildExportHtml({
      meta: meta(),
      content: { type: "html", title: "t", html: "" },
      conversation: [
        ask({
          anchor: { artifact_id: "a", version: 1, block_index: null, quote: evil },
          question: evil,
          answer: { text: evil, answered_at: "t" },
        }),
        ask({ id: "ab_2", question: "still waiting?" }),
      ],
      exportedAt: "d",
    });
    expect(out).not.toContain("<img src=x");
    expect((out.match(/&lt;img src=x/g) ?? []).length).toBe(3);
    expect(out).toContain("not answered");
    expect(out).toContain("still waiting?");
  });

  test("absence exports its reason, escaped", () => {
    const out = buildExportHtml({
      meta: meta({ type: "absence" }),
      content: { type: "absence", title: "t", reason: "too <big>" },
      conversation: null,
      exportedAt: "d",
    });
    expect(out).toContain("Not rendered — too &lt;big&gt;");
  });

  test("filenames slug the title and fall back to the id", () => {
    expect(exportFilename("Weekly Status Update!", "a_1")).toBe(
      "weekly-status-update.html",
    );
    expect(exportFilename("///", "a_1")).toBe("a_1.html");
  });

  test("escapeHtml covers all five metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("export builder — rendered markdown (Part A)", () => {
  test("a prose artifact exports as rendered HTML, not raw markdown in a <pre>", () => {
    const out = buildExportHtml({
      meta: meta({ type: "prose" }),
      content: { type: "prose", title: "t", markdown: "# Heading\n\n- one\n- two" },
      conversation: null,
      exportedAt: "d",
    });
    expect(out).toContain(`<div class="wt-body wt-prose">`);
    expect(out).toContain("<h1>Heading</h1>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    // The raw markdown source is gone (no leading `# ` / `- `, no escaped pre).
    expect(out).not.toContain("<pre class=\"wt-prose\">");
    expect(out).not.toContain("# Heading");
    expect(out).not.toContain("- one");
  });

  test("a conversation answer with markdown renders formatted", () => {
    const out = buildExportHtml({
      meta: meta(),
      content: { type: "html", title: "t", html: "" },
      conversation: [
        ask({
          answer: { text: "Two causes:\n\n- stale `port`\n- rotated token", answered_at: "t" },
        }),
      ],
      exportedAt: "d",
    });
    expect(out).toContain("<li>stale <code>port</code></li>");
    expect(out).toContain("<li>rotated token</li>");
  });
});

describe("export builder — static anchor links (Part B)", () => {
  test("prose: entry N and its in-content marker cross-link via #fragments", () => {
    const out = buildExportHtml({
      meta: meta({ type: "prose" }),
      content: {
        type: "prose",
        title: "t",
        markdown: "The opening paragraph here.\n\nA second paragraph.",
      },
      conversation: [
        ask({
          anchor: { artifact_id: "a", version: 1, block_index: 0, quote: "opening paragraph" },
          question: "which section?",
          answer: { text: "the first one.", answered_at: "t" },
        }),
      ],
      exportedAt: "d",
    });
    // The entry is numbered + id'd, and its number links to the marker.
    expect(out).toContain(`<div class="wt-entry" id="wt-entry-1">`);
    expect(out).toContain(`href="#wt-mark-1"`);
    // The in-content marker sits after the quote and links back to the entry.
    expect(out).toContain(`id="wt-mark-1"`);
    expect(out).toContain(`href="#wt-entry-1"`);
    // Marker lands right after the quoted words, inside the first paragraph.
    expect(out).toContain(
      `The opening paragraph<a class="wt-mark" id="wt-mark-1" href="#wt-entry-1">[1]</a> here.`,
    );
  });

  test("html: entries are numbered with quotes but get NO in-content marker", () => {
    const out = buildExportHtml({
      meta: meta({ type: "html" }),
      content: { type: "html", title: "t", html: "<p>verbatim</p>" },
      conversation: [
        ask({
          anchor: { artifact_id: "a", version: 1, block_index: 0, quote: "verbatim" },
          question: "why?",
        }),
      ],
      exportedAt: "d",
    });
    expect(out).toContain(`id="wt-entry-1"`);
    expect(out).toContain("verbatim"); // quote still shown
    // No marker injected into the model's exact page, and no backlink from the
    // entry number ("wt-mark" appears once, only in the always-present CSS rule).
    expect(out).not.toContain(`class="wt-mark"`);
    expect(out).not.toContain(`id="wt-mark-1"`);
    expect(out).not.toContain(`href="#wt-mark-1"`);
    // The entry number is plain text, not a link.
    expect(out).toContain(`<span class="wt-entry-n">1</span>`);
  });
});
