// Issue 27 — ask-back side drawer: the composer + the whole conversation +
// in-content markers with bidirectional click-to-locate. This replaces the old
// inline reply-thread tests (issue 22): the conversation lives in the drawer now.
//
// Covered: the composer opens pre-filled with the quote (never covering the
// content); submit POSTs, places a pending entry with the honest terminal-turn
// copy, and draws a parent marker for prose; SSE fills the answer in place; a
// boot fetch re-creates entries after a reload; the XSS canary (quote + answer
// are textContent-only); prose marker ⇄ entry locate; and the html path drives
// the frame over the bridge (locateInFrame) instead of drawing a parent marker.
import { describe, expect, test } from "bun:test";
import type { AnsweredAskback, CanvasApi } from "../src/canvas/api.js";
import { Drawer } from "../src/canvas/drawer.js";
import type { Anchor, ArtifactType } from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";

const ARTIFACT = "a_0000abcd";
const HTML_ARTIFACT = "a_0000ffff";

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

interface PostCall {
  anchor: unknown;
  question: string;
}

function fakeApi(answered: AnsweredAskback[] = []) {
  const posts: PostCall[] = [];
  let seq = 0;
  const api = {
    postAskback: async (body: { anchor: unknown; question: string }) => {
      posts.push({ anchor: body.anchor, question: body.question });
      seq++;
      return { id: `ab_${seq}`, state: "pending" };
    },
    getAnsweredAskbacks: async () => answered,
  } as unknown as CanvasApi;
  return { api, posts };
}

const blockAnchor: Anchor = {
  artifact_id: ARTIFACT,
  version: 1,
  block_index: 0,
  quote: "the sentence",
};

function makeDrawer(
  galleryRoot: HTMLElement,
  api: CanvasApi,
  overrides: Partial<{
    locateInFrame: (a: string, m: string) => void;
    artifactType: (id: string) => ArtifactType | null;
  }> = {},
) {
  return new Drawer(galleryRoot.ownerDocument as unknown as Document, {
    api,
    galleryRoot,
    locateInFrame: overrides.locateInFrame,
    artifactType:
      overrides.artifactType ??
      ((id) => (id === HTML_ARTIFACT ? "html" : "prose")),
  });
}

function answeredItem(anchor: Anchor, q: string, text: string): AnsweredAskback {
  return {
    id: "ab_1",
    anchor,
    question: q,
    answer: { text, answered_at: "2026-08-04T00:00:00.000Z" },
  };
}

describe("Drawer composer + submit (issue 27)", () => {
  test("startAsk opens the composer pre-filled with the quote; it never covers content", () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);
    const composer = drawer.panel.querySelector(".drawer-composer") as HTMLElement;
    expect(composer.hidden).toBe(true); // hidden until a question starts

    drawer.startAsk(blockAnchor, { isHtml: false });
    expect(composer.hidden).toBe(false);
    expect(drawer.panel.querySelector(".drawer-quote")!.textContent).toBe(
      "the sentence",
    );
    // The composer lives in the drawer panel — not over the selected block.
    expect(galleryRoot.querySelector(".drawer-composer")).toBeNull();
  });

  test("submit POSTs, shows the honest pending copy, and draws a prose marker at the block", async () => {
    const { galleryRoot, block } = makeGallery();
    const { api, posts } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);

    drawer.startAsk(blockAnchor, { isHtml: false });
    const input = drawer.panel.querySelector(".drawer-input") as HTMLInputElement;
    input.value = "why this sentence?";
    await drawer.submit();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.question).toBe("why this sentence?");

    // A pending entry with the honest terminal-turn copy.
    const pending = drawer.panel.querySelector(".drawer-pending-label")!;
    expect(pending.textContent).toContain("next terminal turn");
    expect(drawer.panel.querySelector(".drawer-entry-q")!.textContent).toBe(
      "why this sentence?",
    );

    // The terminal-turn nudge banner is shown (unmissable) while a question waits.
    const nudge = drawer.panel.querySelector(".drawer-nudge") as HTMLElement;
    expect(nudge.hidden).toBe(false);
    expect(nudge.textContent).toContain("terminal");

    // A parent marker is drawn right after the anchored block.
    const marker = galleryRoot.querySelector(".anchor-marker") as HTMLElement;
    expect(marker).not.toBeNull();
    expect(block.nextSibling).toBe(marker);
  });

  test("SSE askback_answered fills the answer into its entry in place", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);
    drawer.startAsk(blockAnchor, { isHtml: false });
    (drawer.panel.querySelector(".drawer-input") as HTMLInputElement).value = "q?";
    await drawer.submit(); // → ab_1, pending

    // The read route now returns the answer; the SSE event drives a refetch.
    (api.getAnsweredAskbacks as unknown) = async () => [
      { id: "ab_1", anchor: blockAnchor, question: "q?", answer: { text: "the answer.", answered_at: "t" } },
    ];
    await drawer.handleAnswered({
      askback_id: "ab_1",
      artifact_id: ARTIFACT,
      version: 1,
    });

    expect(drawer.panel.querySelector(".drawer-pending")).toBeNull();
    expect(drawer.panel.querySelector(".drawer-entry-text")!.textContent).toBe(
      "the answer.",
    );
    // Nothing waiting → the terminal-turn nudge clears.
    expect(
      (drawer.panel.querySelector(".drawer-nudge") as HTMLElement).hidden,
    ).toBe(true);
  });

  test("boot re-render: answered ask-backs appear after a reload with no prior tracking", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi([
      answeredItem(blockAnchor, "persisted?", "yes, on reload."),
    ]);
    const drawer = makeDrawer(galleryRoot, api);
    await drawer.loadAnswered();
    expect(drawer.panel.querySelector(".drawer-entry-text")!.textContent).toBe(
      "yes, on reload.",
    );
    // Prose marker redrawn from the stored anchor.
    expect(galleryRoot.querySelector(".anchor-marker")).not.toBeNull();
  });

  test("XSS canary: html-shaped quote + answer render as literal text, no nodes", async () => {
    const { galleryRoot } = makeGallery();
    const payload = '<img src=x onerror="window.__pwned=1">';
    const evilAnchor: Anchor = { ...blockAnchor, quote: payload };
    const { api } = fakeApi([answeredItem(evilAnchor, "safe?", payload)]);
    const drawer = makeDrawer(galleryRoot, api);
    await drawer.loadAnswered();

    expect(drawer.panel.querySelector("img")).toBeNull();
    expect(drawer.panel.querySelector(".drawer-entry-quote-text")!.textContent).toBe(
      payload,
    );
    expect(drawer.panel.querySelector(".drawer-entry-text")!.textContent).toBe(
      payload,
    );
  });
});

describe("Drawer markers + click-to-locate (issue 27)", () => {
  test("prose: clicking the in-content marker highlights its drawer entry", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);
    drawer.startAsk(blockAnchor, { isHtml: false });
    (drawer.panel.querySelector(".drawer-input") as HTMLInputElement).value = "q?";
    await drawer.submit();

    const marker = galleryRoot.querySelector(".anchor-marker") as HTMLButtonElement;
    marker.click();
    const entry = drawer.panel.querySelector(".drawer-entry") as HTMLElement;
    expect(entry.classList.contains("drawer-entry--flash")).toBe(true);
  });

  test("prose: clicking a drawer entry flashes its parent marker (drawer → content)", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);
    drawer.startAsk(blockAnchor, { isHtml: false });
    (drawer.panel.querySelector(".drawer-input") as HTMLInputElement).value = "q?";
    await drawer.submit();

    (drawer.panel.querySelector(".drawer-entry") as HTMLElement).click();
    const marker = galleryRoot.querySelector(".anchor-marker") as HTMLElement;
    expect(marker.classList.contains("anchor-marker--flash")).toBe(true);
  });

  test("html: askstart opens the composer; submit + locate drive the frame over the bridge", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const located: Array<{ a: string; m: string }> = [];
    const drawer = makeDrawer(galleryRoot, api, {
      locateInFrame: (a, m) => located.push({ a, m }),
    });

    // The frame prelude sent askstart{quote, markerId}.
    drawer.onFrameAskStart(HTML_ARTIFACT, 2, "inside the frame", "m1");
    expect(drawer.panel.querySelector(".drawer-quote")!.textContent).toBe(
      "inside the frame",
    );
    (drawer.panel.querySelector(".drawer-input") as HTMLInputElement).value = "why?";
    await drawer.submit();

    // Submit confirms the marker into the frame (draw + scroll + highlight).
    expect(located).toEqual([{ a: HTML_ARTIFACT, m: "m1" }]);
    // No PARENT marker for an html entry — the frame owns it.
    expect(galleryRoot.querySelector(".anchor-marker")).toBeNull();

    // Drawer → marker locate drives the frame again.
    (drawer.panel.querySelector(".drawer-entry") as HTMLElement).click();
    expect(located).toHaveLength(2);
    expect(located[1]).toEqual({ a: HTML_ARTIFACT, m: "m1" });
  });

  test("html: a frame marker click (focusEntry) highlights the matching drawer entry", async () => {
    const { galleryRoot } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api, { locateInFrame: () => {} });
    drawer.onFrameAskStart(HTML_ARTIFACT, 2, "inside the frame", "m1");
    (drawer.panel.querySelector(".drawer-input") as HTMLInputElement).value = "why?";
    await drawer.submit();

    drawer.highlightEntryByMarker(HTML_ARTIFACT, "m1");
    const entry = drawer.panel.querySelector(".drawer-entry") as HTMLElement;
    expect(entry.classList.contains("drawer-entry--flash")).toBe(true);
  });
});

describe("Drawer open/close reflow (issue 27)", () => {
  test("toggling sets the reflow class so the artifact column narrows", () => {
    const { galleryRoot, document } = makeGallery();
    const { api } = fakeApi();
    const drawer = makeDrawer(galleryRoot, api);
    expect(document.documentElement.classList.contains("drawer-open")).toBe(false);
    drawer.toggle();
    expect(document.documentElement.classList.contains("drawer-open")).toBe(true);
    drawer.toggle();
    expect(document.documentElement.classList.contains("drawer-open")).toBe(false);
  });
});
