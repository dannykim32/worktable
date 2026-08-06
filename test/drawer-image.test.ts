// Paste-an-image in the drawer composer: a clipboard image uploads at paste
// time and shows a preview chip (with a remove ✕); submit sends the image_id
// with the ask-back; the pending image resets wholesale with the composer
// (startAsk / esc), like the text draft; and an entry with an image_id renders
// a width-capped thumbnail via the bearer-fetch → blob: URL path (the token
// never enters an <img src>).
import { describe, expect, test } from "bun:test";
import type { AnsweredAskback, CanvasApi } from "../src/canvas/api.js";
import { Drawer } from "../src/canvas/drawer.js";
import type { Anchor } from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";

const ARTIFACT = "a_0000abcd";
const IMAGE_ID = "0123456789abcdef0123456789abcdef";

const anchor: Anchor = {
  artifact_id: ARTIFACT,
  version: 1,
  block_index: 0,
  quote: "the sentence",
};

interface PostCall {
  anchor: unknown;
  question: string;
  image_id?: string;
}

function fakeApi(answered: AnsweredAskback[] = []) {
  const posts: PostCall[] = [];
  const uploads: Blob[] = [];
  const fetched: string[] = [];
  let seq = 0;
  const api = {
    postAskback: async (body: PostCall) => {
      posts.push(body);
      seq++;
      return { id: `ab_${seq}`, state: "pending" };
    },
    getAnsweredAskbacks: async () => answered,
    uploadAskbackImage: async (blob: Blob) => {
      uploads.push(blob);
      return { image_id: IMAGE_ID, mime: "image/png", bytes: blob.size };
    },
    fetchAskbackImage: async (id: string) => {
      fetched.push(id);
      return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      });
    },
  } as unknown as CanvasApi;
  return { api, posts, uploads, fetched };
}

function makeDrawer(api: CanvasApi) {
  const { document, mount } = makeDom();
  const drawer = new Drawer(document, {
    api,
    galleryRoot: mount,
    artifactType: () => "prose",
  });
  return { drawer, document, mount };
}

function pasteImage(
  drawer: Drawer,
  document: Document,
  file: File,
): { defaultPrevented: boolean } {
  const input = drawer.panel.querySelector(
    ".drawer-input",
  ) as HTMLTextAreaElement;
  const win = document.defaultView as unknown as { Event: typeof Event };
  const event = new win.Event("paste", { bubbles: true, cancelable: true });
  // happy-dom has no ClipboardEvent constructor with clipboardData; a plain
  // own property carries the same shape the handler reads.
  (event as unknown as { clipboardData: unknown }).clipboardData = {
    files: [file],
    items: [],
  };
  input.dispatchEvent(event);
  return event;
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const pngFile = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
    type: "image/png",
  });

describe("Drawer paste-an-image", () => {
  test("pasting an image uploads it and shows the preview chip with a remove ✕", async () => {
    const { api, uploads } = fakeApi();
    const { drawer, document } = makeDrawer(api);
    drawer.startAsk(anchor, { isHtml: false });

    const event = pasteImage(drawer, document, pngFile());
    expect(event.defaultPrevented).toBe(true); // the image never lands as text
    await settle();

    expect(uploads).toHaveLength(1);
    const chip = drawer.panel.querySelector(".drawer-image-chip") as HTMLElement;
    expect(chip.hidden).toBe(false);
    const img = chip.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.alt).toBe("pasted image");
    expect(chip.querySelector(".drawer-image-remove")).not.toBeNull();
  });

  test("a text-only paste is left to the textarea (no upload, no preventDefault)", async () => {
    const { api, uploads } = fakeApi();
    const { drawer, document } = makeDrawer(api);
    drawer.startAsk(anchor, { isHtml: false });

    const input = drawer.panel.querySelector(
      ".drawer-input",
    ) as HTMLTextAreaElement;
    const win = document.defaultView as unknown as { Event: typeof Event };
    const event = new win.Event("paste", { bubbles: true, cancelable: true });
    (event as unknown as { clipboardData: unknown }).clipboardData = {
      files: [],
      items: [{ kind: "string", type: "text/plain" }],
    };
    input.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  test("submit sends the image_id and clears the chip; the entry shows a thumbnail", async () => {
    const { api, posts } = fakeApi();
    const { drawer, document } = makeDrawer(api);
    drawer.startAsk(anchor, { isHtml: false });
    pasteImage(drawer, document, pngFile());
    await settle();

    (drawer.panel.querySelector(".drawer-input") as HTMLTextAreaElement).value =
      "what is this widget?";
    await drawer.submit();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.image_id).toBe(IMAGE_ID);
    expect(
      (drawer.panel.querySelector(".drawer-image-chip") as HTMLElement).hidden,
    ).toBe(true);
    const entryImg = drawer.panel.querySelector(
      ".drawer-entry-image",
    ) as HTMLImageElement;
    expect(entryImg).not.toBeNull();
    expect(entryImg.alt).toBe("pasted image");
  });

  test("the remove ✕ discards the pending image — submit sends no image_id", async () => {
    const { api, posts } = fakeApi();
    const { drawer, document } = makeDrawer(api);
    drawer.startAsk(anchor, { isHtml: false });
    pasteImage(drawer, document, pngFile());
    await settle();

    (
      drawer.panel.querySelector(".drawer-image-remove") as HTMLButtonElement
    ).click();
    expect(
      (drawer.panel.querySelector(".drawer-image-chip") as HTMLElement).hidden,
    ).toBe(true);

    (drawer.panel.querySelector(".drawer-input") as HTMLTextAreaElement).value =
      "without the image after all";
    await drawer.submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.image_id).toBeUndefined();
  });

  test("a fresh startAsk resets the pending image wholesale, like the text draft", async () => {
    const { api, posts } = fakeApi();
    const { drawer, document } = makeDrawer(api);
    drawer.startAsk(anchor, { isHtml: false });
    pasteImage(drawer, document, pngFile());
    await settle();

    // The human abandons this ask and selects something new.
    drawer.startAsk({ ...anchor, quote: "another selection" }, { isHtml: false });
    expect(
      (drawer.panel.querySelector(".drawer-image-chip") as HTMLElement).hidden,
    ).toBe(true);
    (drawer.panel.querySelector(".drawer-input") as HTMLTextAreaElement).value =
      "about the new selection";
    await drawer.submit();
    expect(posts[0]!.image_id).toBeUndefined(); // stale image never leaks in
  });

  test("boot: an answered ask-back with image_id renders an entry thumbnail via fetchAskbackImage", async () => {
    const { api, fetched } = fakeApi([
      {
        id: "ab_1",
        anchor,
        question: "what broke?",
        answer: { text: "the layout.", answered_at: "t" },
        image_id: IMAGE_ID,
      },
    ]);
    const { drawer } = makeDrawer(api);
    await drawer.loadAnswered();
    await settle();

    const img = drawer.panel.querySelector(
      ".drawer-entry-image",
    ) as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.alt).toBe("pasted image");
    expect(fetched).toContain(IMAGE_ID); // bearer fetch → blob URL, never ?token=
  });
});
