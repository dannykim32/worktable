// Issue 04 unit layer: each block renderer, the XSS canary, the absence
// card, and the golden all-six-kinds fixture.
import { describe, expect, test } from "bun:test";
import type { DocumentContent } from "../src/shared/artifacts.js";
import { renderAbsence } from "../src/canvas/components/absence.js";
import { renderBlock, renderDocument } from "../src/canvas/components/document.js";
import { componentRegistry } from "../src/canvas/components/registry.js";
import { relativeTime } from "../src/canvas/gallery.js";
import { makeDom } from "./dom.js";

const XSS = "<img src=x onerror=alert(1)>";

describe("document block renderers", () => {
  test("heading maps levels 1/2/3 to h3/h4/h5 with the exact text", () => {
    const { mount } = makeDom();
    const h1 = renderBlock({ kind: "heading", level: 1, text: "Top" }, mount);
    const h2 = renderBlock({ kind: "heading", level: 2, text: "Mid" }, mount);
    const h3 = renderBlock({ kind: "heading", level: 3, text: "Low" }, mount);
    expect([h1.tagName, h2.tagName, h3.tagName]).toEqual(["H3", "H4", "H5"]);
    expect(h1.textContent).toBe("Top");
    expect(h1.className).toBe("doc-heading");
  });

  test("paragraph renders a <p> with plain text", () => {
    const { mount } = makeDom();
    const p = renderBlock({ kind: "paragraph", text: "Plain words." }, mount);
    expect(p.tagName).toBe("P");
    expect(p.textContent).toBe("Plain words.");
  });

  test("callout renders tone classes for info and warn", () => {
    const { mount } = makeDom();
    const info = renderBlock(
      { kind: "callout", tone: "info", text: "FYI" },
      mount,
    );
    const warn = renderBlock(
      { kind: "callout", tone: "warn", text: "Careful" },
      mount,
    );
    expect(info.className).toBe("callout tone-info");
    expect(warn.className).toBe("callout tone-warn");
    expect(warn.textContent).toBe("Careful");
  });

  test("code renders pre > code, preserving text and recording lang", () => {
    const { mount } = makeDom();
    const pre = renderBlock(
      { kind: "code", lang: "ts", text: "const a = '<b>&amp;</b>';" },
      mount,
    );
    expect(pre.tagName).toBe("PRE");
    const code = pre.querySelector("code")!;
    expect(code.textContent).toBe("const a = '<b>&amp;</b>';");
    expect(code.dataset.lang).toBe("ts");
  });

  test("table renders header cells and body rows", () => {
    const { mount } = makeDom();
    const table = renderBlock(
      {
        kind: "table",
        header: ["Component", "Job"],
        rows: [
          ["document", "design docs"],
          ["absence", "honest refusal"],
        ],
      },
      mount,
    );
    const ths = [...table.querySelectorAll("thead th")].map((n) => n.textContent);
    expect(ths).toEqual(["Component", "Job"]);
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.querySelectorAll("td")[1]!.textContent).toBe(
      "honest refusal",
    );
  });

  test("list renders ol when ordered, ul otherwise, with items in order", () => {
    const { mount } = makeDom();
    const ol = renderBlock(
      { kind: "list", ordered: true, items: ["one", "two"] },
      mount,
    );
    const ul = renderBlock(
      { kind: "list", ordered: false, items: ["alpha"] },
      mount,
    );
    expect(ol.tagName).toBe("OL");
    expect(ul.tagName).toBe("UL");
    expect([...ol.querySelectorAll("li")].map((n) => n.textContent)).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("XSS canary", () => {
  test("hostile block text renders as visible literal text, never markup", () => {
    const { mount } = makeDom();
    renderDocument(
      {
        type: "document",
        title: "canary",
        blocks: [
          { kind: "paragraph", text: XSS },
          { kind: "heading", level: 1, text: XSS },
          { kind: "callout", tone: "info", text: XSS },
          { kind: "table", header: [XSS], rows: [[XSS]] },
          { kind: "list", ordered: false, items: [XSS] },
        ],
      },
      mount,
    );
    // The literal string is visible text in every block…
    for (const selector of ["p", "h3", ".callout", "th", "td", "li"]) {
      expect(mount.querySelector(selector)!.textContent).toBe(XSS);
    }
    // …and was never parsed into an element.
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.querySelectorAll("*").length).toBeGreaterThan(0);
  });
});

describe("absence card", () => {
  test("renders the reason as a first-class outcome, not an error banner", () => {
    const { mount } = makeDom();
    renderAbsence(
      {
        type: "absence",
        title: "Repo map declined",
        reason: "5,471 directories cannot be told truthfully in one artifact.",
      },
      mount,
    );
    expect(mount.classList.contains("absence-body")).toBe(true);
    expect(mount.querySelector(".absence-label")!.textContent).toContain(
      "Declined honestly",
    );
    expect(mount.querySelector(".absence-reason")!.textContent).toContain(
      "5,471 directories",
    );
    // Reason text goes through textContent too (XSS canary for absence).
    const { mount: hostile } = makeDom();
    renderAbsence(
      { type: "absence", title: "t", reason: XSS },
      hostile,
    );
    expect(hostile.querySelector("img")).toBeNull();
    expect(hostile.querySelector(".absence-reason")!.textContent).toBe(XSS);
  });
});

describe("golden fixture", () => {
  test("a document with all six kinds produces the expected DOM structure", () => {
    const { mount } = makeDom();
    const fixture: DocumentContent = {
      type: "document",
      title: "All six",
      blocks: [
        { kind: "heading", level: 1, text: "Decision" },
        { kind: "paragraph", text: "The terminal stays the driver." },
        { kind: "callout", tone: "info", text: "Honest absence is first-class." },
        { kind: "code", lang: "json", text: '{ "tool": "publish_artifact" }' },
        { kind: "table", header: ["k"], rows: [["v"]] },
        { kind: "list", ordered: false, items: ["anchored ask-backs"] },
      ],
    };
    componentRegistry.document(fixture, mount);
    expect(mount.classList.contains("doc")).toBe(true);
    const children = [...mount.children];
    expect(children.map((c) => c.tagName)).toEqual([
      "H3",
      "P",
      "DIV",
      "PRE",
      "TABLE",
      "UL",
    ]);
    // Every block carries its anchor index in DOM order.
    expect(
      children.map((c) => (c as HTMLElement).dataset.blockIndex),
    ).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  test("relative timestamps read like the prototype chrome", () => {
    const now = Date.parse("2026-07-14T12:00:00Z");
    expect(relativeTime("2026-07-14T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-07-14T11:51:00Z", now)).toBe("9 min ago");
    expect(relativeTime("2026-07-14T09:00:00Z", now)).toBe("3 h ago");
  });
});
