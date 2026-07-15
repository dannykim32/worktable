// Issue 10 unit layer (jsdom/happy-dom): free-form SVG renders EXCLUSIVELY as
// an inert <img src="data:image/svg+xml,…"> — never inline <svg>, never an
// <iframe> — plus the provenance badge and standing caption. Image Isolation
// is asserted structurally, not by string filtering.
import { describe, expect, test } from "bun:test";
import type { SvgContent } from "../src/shared/artifacts.js";
import { renderSvg, SVG_CAPTION } from "../src/canvas/components/svg.js";
import { Gallery } from "../src/canvas/gallery.js";
import type { CanvasApi } from "../src/canvas/api.js";
import type {
  ArtifactContent,
  ArtifactMeta,
} from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";

const SAMPLE: SvgContent = {
  type: "svg",
  title: "Flow",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="teal" height="10" width="10"/><text x="1" y="8">alert probe</text></svg>',
};

describe("renderSvg — Image Isolation is structural (AC1, AC5)", () => {
  test("renders an <img> with a data:image/svg+xml src, and no inline svg/iframe", () => {
    const { mount } = makeDom();
    renderSvg(SAMPLE, mount);

    const img = mount.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")!.startsWith("data:image/svg+xml,")).toBe(true);

    // The element IS an img; the SVG never becomes live DOM.
    expect(mount.querySelector("svg")).toBeNull();
    expect(mount.querySelector("iframe")).toBeNull();
    expect(mount.querySelector("script")).toBeNull();
    // Even the <text> inside the SVG source is not a DOM node — it lives only
    // inside the opaque data-URL string, so "alert probe" cannot execute.
    expect(mount.querySelector("text")).toBeNull();
  });

  test("the data URL round-trips to the exact sanitized markup", () => {
    const { mount } = makeDom();
    renderSvg(SAMPLE, mount);
    const src = mount.querySelector("img")!.getAttribute("src")!;
    const decoded = decodeURIComponent(src.slice("data:image/svg+xml,".length));
    expect(decoded).toBe(SAMPLE.svg);
  });

  test("standing caption is present and exact (ADR-0009, AC4)", () => {
    const { mount } = makeDom();
    renderSvg(SAMPLE, mount);
    const caption = mount.querySelector(".svg-caption");
    expect(caption).not.toBeNull();
    expect(caption!.textContent).toBe(SVG_CAPTION);
    expect(SVG_CAPTION).toBe(
      "Depicts the idea, not the exact code — drawn by the model, shown as " +
        "an inert image.",
    );
  });

  test("a title with markup stays inert as the img alt (never parsed)", () => {
    const { mount } = makeDom();
    renderSvg(
      { type: "svg", title: "<img src=x onerror=alert(1)>", svg: SAMPLE.svg },
      mount,
    );
    const imgs = mount.querySelectorAll("img");
    // Exactly one img (ours) — the title text did not spawn a second one.
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("alt")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("svg card chrome — provenance badge (AC4)", () => {
  function apiWith(meta: ArtifactMeta, content: ArtifactContent): CanvasApi {
    return {
      health: async () => ({ workspaceId: "ws", version: "0" }),
      listArtifacts: async () => [meta],
      getArtifact: async () => ({ ...meta, content }),
      getVersion: async () => content,
      postAskback: async () => {},
    };
  }

  test('every svg card shows the "svg · free-form" badge and the caption', async () => {
    const { mount } = makeDom();
    const meta: ArtifactMeta = {
      id: "a_0000abcd",
      type: "svg",
      title: "Flow",
      latest: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const gallery = new Gallery(mount, apiWith(meta, SAMPLE));
    await gallery.init();

    const card = mount.querySelector('[data-artifact-id="a_0000abcd"]')!;
    const badge = card.querySelector(".badge")!;
    expect(badge.textContent).toBe("svg · free-form");
    expect(badge.classList.contains("freeform")).toBe(true);
    // Rendered body: an img and the standing caption, no inline svg.
    expect(card.querySelector("img")).not.toBeNull();
    expect(card.querySelector("svg")).toBeNull();
    expect(card.querySelector(".svg-caption")!.textContent).toBe(SVG_CAPTION);
  });
});
