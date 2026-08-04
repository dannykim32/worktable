// Issue 22 canvas unit layer: the reply thread renders under the anchored
// selection (block-anchored under the block, whole-artifact on the card); a
// live askback_answered append needs no reload; a boot fetch re-renders after
// a reload; and the agent's answer is textContent-only (XSS canary).
import { describe, expect, test } from "bun:test";
import type { CanvasApi, AnsweredAskback } from "../src/canvas/api.js";
import { ReplyThreads } from "../src/canvas/replies.js";
import type { Anchor } from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";

const ARTIFACT = "a_0000abcd";

/** Build the DOM the gallery produces: a card with a document body + one
 *  block, mounted in a gallery root. */
function makeGallery() {
  const { document, mount } = makeDom();
  const card = document.createElement("section");
  card.className = "artifact";
  card.dataset.artifactId = ARTIFACT;
  const body = document.createElement("div");
  body.className = "body";
  const block = document.createElement("p");
  block.dataset.blockIndex = "0";
  block.textContent = "the sentence the human selected";
  body.appendChild(block);
  card.appendChild(body);
  mount.appendChild(card);
  return { document, galleryRoot: mount, card, body, block };
}

function stubApi(answered: AnsweredAskback[]): CanvasApi {
  return {
    getAnsweredAskbacks: async () => answered,
  } as unknown as CanvasApi;
}

const blockAnchor: Anchor = {
  artifact_id: ARTIFACT,
  version: 1,
  block_index: 0,
  char_start: 0,
  char_end: 3,
  quote: "the",
};

const wholeAnchor: Anchor = {
  artifact_id: ARTIFACT,
  version: 1,
  block_index: null,
  quote: "A title",
};

function answeredItem(
  anchor: Anchor,
  question: string,
  text: string,
): AnsweredAskback {
  return {
    id: "ab_11112222",
    anchor,
    question,
    answer: { text, answered_at: "2026-07-14T00:00:00.000Z" },
  };
}

describe("ReplyThreads (issue 22)", () => {
  test("a block-anchored answer renders right under that block", async () => {
    const { document, galleryRoot, block } = makeGallery();
    const item = answeredItem(blockAnchor, "what is this?", "it is the anchor.");
    const replies = new ReplyThreads(document, galleryRoot, stubApi([item]));
    await replies.loadAnswered();

    const thread = galleryRoot.querySelector(".reply-thread") as HTMLElement;
    expect(thread).not.toBeNull();
    // Inserted as the block's next sibling (under the selected block).
    expect(block.nextSibling).toBe(thread);
    expect(thread.querySelector(".reply-question")!.textContent).toBe(
      "what is this?",
    );
    expect(thread.querySelector(".reply-text")!.textContent).toBe(
      "it is the anchor.",
    );
    // Expanded on arrival so the reply is noticed; the toggle still collapses it.
    const toggle = thread.querySelector(".reply-toggle") as HTMLElement;
    expect(toggle.textContent).toBe("agent replied");
    expect((thread.querySelector(".reply-body") as HTMLElement).hidden).toBe(false);
    (toggle as HTMLButtonElement).click();
    expect((thread.querySelector(".reply-body") as HTMLElement).hidden).toBe(
      true,
    );
  });

  test("a whole-artifact answer renders on the card, not inside a block", async () => {
    const { document, galleryRoot, card } = makeGallery();
    const item = answeredItem(wholeAnchor, "overall?", "looks good overall.");
    const replies = new ReplyThreads(document, galleryRoot, stubApi([item]));
    await replies.loadAnswered();

    const thread = galleryRoot.querySelector(".reply-thread") as HTMLElement;
    expect(thread.parentElement).toBe(card); // on the card, not the block
    expect(thread.querySelector(".reply-text")!.textContent).toBe(
      "looks good overall.",
    );
  });

  test("live: a tracked ask-back appears via askback_answered with no reload", async () => {
    const { document, galleryRoot, block } = makeGallery();
    // Nothing answered yet at boot.
    const api = stubApi([]);
    const replies = new ReplyThreads(document, galleryRoot, api);
    // Human submits → the canvas tracks it locally (id + anchor) and shows a
    // "waiting for the agent" marker at the selection immediately, so the human
    // sees where the reply will land. No answer text yet.
    replies.track("ab_11112222", blockAnchor, "what is this?");
    await replies.loadAnswered();
    const pending = galleryRoot.querySelector(".reply-thread--pending");
    expect(pending).not.toBeNull();
    expect(pending!.querySelector(".reply-pending")).not.toBeNull();
    expect(galleryRoot.querySelector(".reply-text")).toBeNull();

    // The agent answers: the read route now returns it; the SSE event drives a
    // fetch + render.
    (api.getAnsweredAskbacks as unknown) = async () => [
      answeredItem(blockAnchor, "what is this?", "answered live."),
    ];
    await replies.handleAnswered({
      askback_id: "ab_11112222",
      artifact_id: ARTIFACT,
      version: 1,
    });

    const thread = galleryRoot.querySelector(".reply-thread") as HTMLElement;
    expect(thread).not.toBeNull();
    expect(block.nextSibling).toBe(thread);
    expect(thread.querySelector(".reply-text")!.textContent).toBe(
      "answered live.",
    );
  });

  test("boot re-render: answers survive a reload with no prior tracking", async () => {
    const { document, galleryRoot } = makeGallery();
    // A fresh page load: no track() calls, only the read route.
    const item = answeredItem(blockAnchor, "persisted?", "yes, on reload.");
    const replies = new ReplyThreads(document, galleryRoot, stubApi([item]));
    await replies.loadAnswered();
    expect(
      galleryRoot.querySelector(".reply-thread .reply-text")!.textContent,
    ).toBe("yes, on reload.");
  });

  test("XSS canary: an html-shaped answer renders as literal text, no nodes", async () => {
    const { document, galleryRoot } = makeGallery();
    const payload = '<img src=x onerror="window.__pwned=1">';
    const item = answeredItem(blockAnchor, "safe?", payload);
    const replies = new ReplyThreads(document, galleryRoot, stubApi([item]));
    await replies.loadAnswered();

    const thread = galleryRoot.querySelector(".reply-thread") as HTMLElement;
    // No element was parsed out of the answer text.
    expect(thread.querySelector("img")).toBeNull();
    // It renders as the literal string.
    expect(thread.querySelector(".reply-text")!.textContent).toBe(payload);
  });
});
