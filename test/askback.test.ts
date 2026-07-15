// Issue 05 unit layer: anchor capture from a Range, jsonl state transitions,
// POST-body validation, composer keyboard behavior.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AskbackQueue,
  AskbackValidationError,
  validateAskbackBody,
} from "../src/server/askbacks.js";
import {
  anchorFromRange,
  AskbackUi,
  textOffsetWithin,
  wholeArtifactAnchor,
} from "../src/canvas/askback.js";
import type { Anchor } from "../src/shared/artifacts.js";
import type { CanvasApi } from "../src/canvas/api.js";
import type { Gallery } from "../src/canvas/gallery.js";
import { makeDom } from "./dom.js";

const goodAnchor: Anchor = {
  artifact_id: "a_12ab34cd",
  version: 3,
  block_index: 4,
  char_start: 12,
  char_end: 96,
  quote: "the exact words the human selected",
};

describe("anchor capture from a Range", () => {
  test("single-text-node paragraph yields exact block/char offsets + quote", () => {
    const { document, mount } = makeDom();
    const p = document.createElement("p");
    p.dataset.blockIndex = "4";
    p.textContent = "The terminal agent host stays the conversation driver.";
    mount.appendChild(p);

    const range = document.createRange();
    range.setStart(p.firstChild!, 4);
    range.setEnd(p.firstChild!, 23);
    const anchor = anchorFromRange(range, p, "a_12ab34cd", 3);
    expect(anchor).toEqual({
      artifact_id: "a_12ab34cd",
      version: 3,
      block_index: 4,
      char_start: 4,
      char_end: 23,
      quote: "terminal agent host",
    });
  });

  test("offsets accumulate across multiple text nodes in one block", () => {
    const { document, mount } = makeDom();
    const p = document.createElement("p");
    p.dataset.blockIndex = "0";
    p.appendChild(document.createTextNode("Hello "));
    p.appendChild(document.createTextNode("canvas world"));
    mount.appendChild(p);

    const second = p.childNodes[1]!;
    expect(textOffsetWithin(p, second, 7)).toBe(13); // "Hello " + "canvas "
    const range = document.createRange();
    range.setStart(second, 0);
    range.setEnd(second, 6);
    const anchor = anchorFromRange(range, p, "a_00000001", 1);
    expect(anchor.char_start).toBe(6);
    expect(anchor.char_end).toBe(12);
    expect(anchor.quote).toBe("canvas");
  });

  test("quotes are clamped to 300 chars; whole-artifact anchors use the title", () => {
    const { document, mount } = makeDom();
    const p = document.createElement("p");
    p.dataset.blockIndex = "1";
    p.textContent = "x".repeat(500);
    mount.appendChild(p);
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 500);
    expect(anchorFromRange(range, p, "a_00000001", 2).quote).toHaveLength(300);

    const whole = wholeArtifactAnchor("a_00000001", 5, "Design note");
    expect(whole.block_index).toBeNull();
    expect(whole.version).toBe(5);
    expect(whole.quote).toBe("Design note");
  });
});

describe("askback queue jsonl state transitions", () => {
  test("pending → delivered via atomic drain; delivery persists on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-chat-ab-"));
    const queue = new AskbackQueue(dir);
    queue.append({ anchor: goodAnchor, question: "why this design?" });
    queue.append({ anchor: goodAnchor, question: "second question" });
    expect(queue.pending()).toHaveLength(2);

    const drained = queue.drainPending();
    expect(drained.map((a) => a.question)).toEqual([
      "why this design?",
      "second question",
    ]);
    expect(queue.pending()).toHaveLength(0);
    expect(queue.drainPending()).toHaveLength(0);

    // Restart: a fresh queue over the same file sees delivered, not pending.
    const reopened = new AskbackQueue(dir);
    expect(reopened.pending()).toHaveLength(0);
    const lines = readFileSync(join(dir, "askbacks.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect((JSON.parse(line) as { state: string }).state).toBe("delivered");
    }
  });

  test("validation rejects oversized questions, missing anchors, junk fields", () => {
    expect(() =>
      validateAskbackBody({ anchor: goodAnchor, question: "x".repeat(2001) }),
    ).toThrow(AskbackValidationError);
    expect(() => validateAskbackBody({ question: "no anchor" })).toThrow(
      "anchor is required",
    );
    expect(() =>
      validateAskbackBody({
        anchor: { ...goodAnchor, evil: true },
        question: "q",
      }),
    ).toThrow('unexpected anchor field "evil"');
    expect(() =>
      validateAskbackBody({
        anchor: { ...goodAnchor, char_start: 50, char_end: 10 },
        question: "q",
      }),
    ).toThrow("char_end");

    const ok = validateAskbackBody({
      anchor: { artifact_id: "a_12ab34cd", version: 1, block_index: null, quote: "t" },
      question: "whole-artifact ask",
    });
    expect(ok.anchor.block_index).toBeNull();
  });
});

describe("composer keyboard behavior", () => {
  function makeUi() {
    const dom = makeDom();
    const sent: Array<{ anchor: unknown; question: string }> = [];
    const api = {
      postAskback: async (body: { anchor: unknown; question: string }) => {
        sent.push(body);
      },
    } as unknown as CanvasApi;
    const gallery = { viewingVersion: () => 1 } as unknown as Gallery;
    const ui = new AskbackUi(dom.document, { api, gallery });
    return { ...dom, ui, sent };
  }

  test("Enter submits the ask-back and shows the optimistic sent state", async () => {
    const { window, ui, sent } = makeUi();
    ui.openComposer(goodAnchor);
    expect(ui.composer.hidden).toBe(false);
    expect(ui.quoteBox.textContent).toContain("v3");
    expect(ui.quoteBox.textContent).toContain(goodAnchor.quote);

    ui.input.value = "Why queue + pull instead of push?";
    ui.input.dispatchEvent(
      new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
        "keydown",
        { key: "Enter", bubbles: true },
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question).toBe("Why queue + pull instead of push?");
    expect((sent[0]!.anchor as Anchor).version).toBe(3);
    expect(ui.status.textContent).toContain("reaches the agent next turn");
  });

  test("Esc closes the composer without sending", () => {
    const { window, ui, sent } = makeUi();
    ui.openComposer(goodAnchor);
    ui.input.value = "never sent";
    ui.input.dispatchEvent(
      new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
        "keydown",
        { key: "Escape", bubbles: true },
      ),
    );
    expect(ui.composer.hidden).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
