// GalleryNav: the top-left index that appears only when ≥2 renderings share the
// canvas, names each, and jumps to it. Scroll-spy (IntersectionObserver) is a
// progressive enhancement absent in the test DOM, so these cover the structural
// + navigation behavior, not the active-marker.
import { describe, expect, test } from "bun:test";
import type { ArtifactType } from "../src/shared/artifacts.js";
import { GalleryNav, type NavEntry } from "../src/canvas/gallery-nav.js";
import { makeDom } from "./dom.js";

function makeEntry(
  doc: Document,
  id: string,
  title: string,
  type: ArtifactType = "prose",
): NavEntry {
  const el = doc.createElement("section");
  el.className = "artifact";
  el.dataset.artifactId = id;
  doc.body.appendChild(el);
  return { id, title, type, el };
}

describe("GalleryNav", () => {
  test("stays hidden for 0 or 1 rendering (no clutter for the common case)", () => {
    const { document } = makeDom();
    const nav = new GalleryNav(document, document.body);
    const el = document.querySelector(".gallery-nav") as HTMLElement;
    expect(el.hidden).toBe(true);

    nav.sync([makeEntry(document, "a_1", "Only one")]);
    expect(el.hidden).toBe(true);
    expect(el.querySelectorAll(".gallery-nav-item")).toHaveLength(0);
  });

  test("shows a numbered index once ≥2 renderings exist", () => {
    const { document } = makeDom();
    const nav = new GalleryNav(document, document.body);
    nav.sync([
      makeEntry(document, "a_1", "Architecture", "html"),
      makeEntry(document, "a_2", "Latency review", "prose"),
    ]);

    const el = document.querySelector(".gallery-nav") as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".gallery-nav-count")!.textContent).toBe(
      "2 Worktables",
    );
    const items = el.querySelectorAll(".gallery-nav-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".gallery-nav-num")!.textContent).toBe("1");
    expect(items[0]!.querySelector(".gallery-nav-title")!.textContent).toBe(
      "Architecture",
    );
    // The type carries a per-register class (a color hint, not the sole signal).
    expect(
      items[0]!.querySelector(".gallery-nav-type--html"),
    ).not.toBeNull();
    // Full title on hover, since the rail truncates it.
    expect((items[0] as HTMLButtonElement).title).toBe("Architecture");
    expect((items[1] as HTMLButtonElement).title).toBe("Latency review");
  });

  test("clicking an entry scrolls to its card and flashes it", () => {
    const { document } = makeDom();
    const nav = new GalleryNav(document, document.body);
    const target = makeEntry(document, "a_2", "Second");
    let scrolledTo: HTMLElement | null = null;
    // happy-dom has no scrollIntoView; stub it to observe the call.
    (target.el as unknown as { scrollIntoView: () => void }).scrollIntoView =
      function (this: HTMLElement) {
        scrolledTo = this;
      };
    nav.sync([makeEntry(document, "a_1", "First"), target]);

    const secondBtn = document.querySelectorAll(
      ".gallery-nav-item",
    )[1] as HTMLButtonElement;
    secondBtn.click();

    expect(scrolledTo).toBe(target.el);
    expect(target.el.classList.contains("artifact--flash")).toBe(true);
  });

  test("re-syncing down to one rendering hides the panel again", () => {
    const { document } = makeDom();
    const nav = new GalleryNav(document, document.body);
    nav.sync([
      makeEntry(document, "a_1", "One"),
      makeEntry(document, "a_2", "Two"),
    ]);
    const el = document.querySelector(".gallery-nav") as HTMLElement;
    expect(el.hidden).toBe(false);

    nav.sync([makeEntry(document, "a_1", "One")]);
    expect(el.hidden).toBe(true);
    expect(el.querySelectorAll(".gallery-nav-item")).toHaveLength(0);
  });

  test("the header toggles the collapsed state", () => {
    const { document } = makeDom();
    const nav = new GalleryNav(document, document.body);
    nav.sync([
      makeEntry(document, "a_1", "One"),
      makeEntry(document, "a_2", "Two"),
    ]);
    const el = document.querySelector(".gallery-nav") as HTMLElement;
    const head = el.querySelector(".gallery-nav-head") as HTMLButtonElement;

    expect(head.getAttribute("aria-expanded")).toBe("true");
    head.click();
    expect(el.dataset.collapsed).toBe("true");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    head.click();
    expect(el.dataset.collapsed).toBe("false");
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });
});
