// Issue 08 unit layer: pane-count/line-cap rejection at the tool boundary,
// the golden before/after fixture, empty and all-marked panes, XSS canary.
import { describe, expect, test } from "bun:test";
import type { CompareContent } from "../src/shared/artifacts.js";
import { renderCompare } from "../src/canvas/components/compare.js";
import { componentRegistry } from "../src/canvas/components/registry.js";
import {
  validateArtifactContent,
  ValidationError,
} from "../src/server/validate.js";
import { makeDom } from "./dom.js";

const XSS = "<img src=x onerror=alert(1)>";

/** Golden fixture: the prototype's "Ask-back delivery: before / after". */
const golden: CompareContent = {
  type: "compare",
  title: "Ask-back delivery: before / after",
  panes: [
    {
      label: "Before — clipboard hand-off",
      lines: [
        { text: "user selects paragraph in browser", mark: null },
        { text: "- copies quote by hand", mark: "del" },
        { text: "- pastes into terminal, retypes context", mark: "del" },
        { text: "agent guesses which artifact/version", mark: null },
      ],
    },
    {
      label: "After — queue + pull (+ host hook)",
      lines: [
        { text: "user selects paragraph in browser", mark: null },
        { text: "+ ask-back POSTed with anchor:", mark: "add" },
        { text: "  artifact a_7f2, v3, block 4, chars 12–96", mark: "add" },
        { text: "agent pulls queue next turn", mark: null },
      ],
    },
  ],
};

function rejectPath(input: unknown): string {
  try {
    validateArtifactContent(input);
  } catch (err) {
    if (err instanceof ValidationError) return err.path;
    throw err;
  }
  throw new Error("expected a ValidationError");
}

const pane = (label: string, n = 1) => ({
  label,
  lines: Array.from({ length: n }, (_, i) => ({
    text: `line ${i}`,
    mark: null,
  })),
});

describe("compare schema boundary", () => {
  test("accepts the golden fixture at the tool boundary", () => {
    const content = validateArtifactContent(golden);
    expect(content.type).toBe("compare");
    if (content.type === "compare") expect(content.panes).toHaveLength(2);
  });

  test("panes ≠ 2 are rejected — one, three, or none", () => {
    expect(
      rejectPath({ type: "compare", title: "t", panes: [pane("only")] }),
    ).toBe("/panes");
    expect(
      rejectPath({
        type: "compare",
        title: "t",
        panes: [pane("a"), pane("b"), pane("c")],
      }),
    ).toBe("/panes");
    expect(rejectPath({ type: "compare", title: "t", panes: [] })).toBe(
      "/panes",
    );
  });

  test(">500 lines in a pane are rejected with the pane's JSON path", () => {
    expect(
      rejectPath({
        type: "compare",
        title: "t",
        panes: [pane("a"), pane("b", 501)],
      }),
    ).toBe("/panes/1/lines");
    // 500 exactly is fine.
    const ok = validateArtifactContent({
      type: "compare",
      title: "t",
      panes: [pane("a"), pane("b", 500)],
    });
    expect(ok.type).toBe("compare");
  });

  test("bad marks and extra fields are rejected (agent supplies marks)", () => {
    expect(
      rejectPath({
        type: "compare",
        title: "t",
        panes: [
          pane("a"),
          { label: "b", lines: [{ text: "x", mark: "changed" }] },
        ],
      }),
    ).toBe("/panes/1/lines/0/mark");
    expect(
      rejectPath({
        type: "compare",
        title: "t",
        panes: [
          pane("a"),
          { label: "b", lines: [{ text: "x", mark: null, html: "<b>" }] },
        ],
      }),
    ).toBe("/panes/1/lines/0/html");
  });
});

describe("compare renderer", () => {
  test("golden fixture renders two labeled panes with add/del tinting", () => {
    const { mount } = makeDom();
    componentRegistry.compare(golden, mount);
    expect(mount.classList.contains("compare")).toBe(true);
    const panes = [...mount.querySelectorAll(".pane")];
    expect(panes).toHaveLength(2);
    expect(panes[0]!.querySelector(".pane-head")!.textContent).toBe(
      "Before — clipboard hand-off",
    );
    expect(panes[1]!.querySelector(".pane-head")!.textContent).toBe(
      "After — queue + pull (+ host hook)",
    );
    // Monospace body: every line is a block span inside a <pre>.
    const before = [...panes[0]!.querySelectorAll("pre .line")];
    expect(before).toHaveLength(4);
    expect(before.map((l) => l.className)).toEqual([
      "line",
      "line del",
      "line del",
      "line",
    ]);
    const after = [...panes[1]!.querySelectorAll("pre .line")];
    expect(after.map((l) => l.className)).toEqual([
      "line",
      "line add",
      "line add",
      "line",
    ]);
    expect(after[1]!.textContent).toBe("+ ask-back POSTed with anchor:");
    // Lines carry their anchor index in DOM order.
    expect(
      before.map((l) => (l as HTMLElement).dataset.lineIndex),
    ).toEqual(["0", "1", "2", "3"]);
  });

  test("an empty pane renders its header and an empty body", () => {
    const { mount } = makeDom();
    renderCompare(
      {
        type: "compare",
        title: "one side missing",
        panes: [
          { label: "Before", lines: [{ text: "only line", mark: null }] },
          { label: "After", lines: [] },
        ],
      },
      mount,
    );
    const panes = [...mount.querySelectorAll(".pane")];
    expect(panes).toHaveLength(2);
    expect(panes[1]!.querySelector(".pane-head")!.textContent).toBe("After");
    expect(panes[1]!.querySelector("pre")).not.toBeNull();
    expect(panes[1]!.querySelectorAll(".line")).toHaveLength(0);
  });

  test("an all-marked pane tints every line", () => {
    const { mount } = makeDom();
    renderCompare(
      {
        type: "compare",
        title: "full rewrite",
        panes: [
          {
            label: "Before",
            lines: [
              { text: "old 1", mark: "del" },
              { text: "old 2", mark: "del" },
            ],
          },
          {
            label: "After",
            lines: [
              { text: "new 1", mark: "add" },
              { text: "new 2", mark: "add" },
            ],
          },
        ],
      },
      mount,
    );
    const panes = [...mount.querySelectorAll(".pane")];
    for (const line of panes[0]!.querySelectorAll(".line")) {
      expect(line.classList.contains("del")).toBe(true);
    }
    for (const line of panes[1]!.querySelectorAll(".line")) {
      expect(line.classList.contains("add")).toBe(true);
    }
  });

  test("XSS canary: hostile line and label text renders literally", () => {
    const { mount } = makeDom();
    renderCompare(
      {
        type: "compare",
        title: "canary",
        panes: [
          { label: XSS, lines: [{ text: XSS, mark: "add" }] },
          { label: "clean", lines: [{ text: XSS, mark: null }] },
        ],
      },
      mount,
    );
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.querySelector(".pane-head")!.textContent).toBe(XSS);
    for (const line of mount.querySelectorAll(".line")) {
      expect(line.textContent).toBe(XSS);
    }
    expect(mount.querySelectorAll("img, script")).toHaveLength(0);
  });
});
