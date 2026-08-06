// Paste-an-image unit layer: the magic-byte sniff is the type authority
// (reject-not-drop), the ImageStore's id regex gates every read (no path
// traversal), files land 0600 in a 0700 dir, and validateAskbackBody accepts
// image_id only when it is well-formed AND exists in the store.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImageStore,
  ImageTooLargeError,
  NotAnImageError,
  sniffImageMime,
} from "../src/server/askbackImages.js";
import {
  AskbackValidationError,
  validateAskbackBody,
} from "../src/server/askbacks.js";
import { IMAGE_MAX_BYTES } from "../src/shared/constraints.js";
import type { Anchor } from "../src/shared/artifacts.js";

/** A tiny buffer that starts with a real magic prefix, padded to a plausible
 *  minimum length. */
function withMagic(prefix: number[] | string, pad = 16): Buffer {
  const head =
    typeof prefix === "string"
      ? Buffer.from(prefix, "ascii")
      : Buffer.from(prefix);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

const png = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = withMagic([0xff, 0xd8, 0xff, 0xe0]);
const gif = withMagic("GIF89a");
const webp = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
  Buffer.alloc(16),
]);

describe("sniffImageMime (magic bytes are the authority)", () => {
  test("accepts each real magic-byte prefix with its canonical mime", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  test("rejects a text blob, a truncated header, and declared-png-that-is-html", () => {
    expect(sniffImageMime(Buffer.from("just some text"))).toBeNull();
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull(); // truncated PNG
    // The classic smuggle: a body DECLARED image/png that is actually HTML.
    // The declared header never reaches the sniffer — only bytes do.
    expect(
      sniffImageMime(Buffer.from("<html><script>alert(1)</script></html>")),
    ).toBeNull();
    // RIFF container that is NOT WEBP (e.g. WAVE) is refused too.
    expect(
      sniffImageMime(
        Buffer.concat([
          Buffer.from("RIFF", "ascii"),
          Buffer.alloc(4),
          Buffer.from("WAVE", "ascii"),
          Buffer.alloc(8),
        ]),
      ),
    ).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("ImageStore", () => {
  test("save → get round-trips bytes + sniffed mime; has() agrees; 0600/0700 at rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-img-"));
    const store = new ImageStore(dir);
    const saved = store.save(png);
    expect(saved.id).toMatch(/^[0-9a-f]{32}$/);
    expect(saved.mime).toBe("image/png");
    expect(saved.bytes).toBe(png.length);

    const loaded = store.get(saved.id)!;
    expect(loaded.mime).toBe("image/png");
    expect(loaded.bytes.equals(png)).toBe(true);
    expect(store.has(saved.id)).toBe(true);

    // At-rest permissions: dir 0700, bytes + mime sidecar 0600.
    const imagesDir = join(dir, "askback-images");
    expect(statSync(imagesDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(imagesDir, saved.id)).mode & 0o777).toBe(0o600);
    expect(statSync(join(imagesDir, `${saved.id}.mime`)).mode & 0o777).toBe(
      0o600,
    );
  });

  test("rejects a non-image and an oversize image; nothing is stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-img-"));
    const store = new ImageStore(dir);
    expect(() => store.save(Buffer.from("not an image"))).toThrow(
      NotAnImageError,
    );
    const oversize = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(IMAGE_MAX_BYTES),
    ]);
    expect(() => store.save(oversize)).toThrow(ImageTooLargeError);
  });

  test("get()/has() on traversal-shaped or malformed ids return null — no path is ever built", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-img-"));
    const store = new ImageStore(dir);
    store.save(png); // a real image exists beside the probes
    expect(store.get("../foo")).toBeNull();
    expect(store.get("..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(store.get("abc")).toBeNull(); // too short
    expect(store.get("A".repeat(32))).toBeNull(); // uppercase — not the alphabet
    expect(store.get("0".repeat(31) + "/")).toBeNull();
    expect(store.get(42 as unknown as string)).toBeNull();
    expect(store.has("../foo")).toBe(false);
    // A well-formed but unknown id is a clean miss, not an error.
    expect(store.get("0123456789abcdef0123456789abcdef")).toBeNull();
  });
});

describe("validateAskbackBody with image_id", () => {
  const anchor: Anchor = {
    artifact_id: "a_12ab34cd",
    version: 1,
    block_index: null,
    quote: "the quote",
  };
  const realId = "0123456789abcdef0123456789abcdef";

  test("accepts a stored 32-hex image_id and threads it through", () => {
    const out = validateAskbackBody(
      { anchor, question: "what is this?", image_id: realId },
      { hasImage: (id) => id === realId },
    );
    expect(out.image_id).toBe(realId);
  });

  test("rejects malformed ids and ids the store does not have (400, reject-not-drop)", () => {
    expect(() =>
      validateAskbackBody(
        { anchor, question: "q", image_id: "../etc/passwd" },
        { hasImage: () => true },
      ),
    ).toThrow(AskbackValidationError);
    expect(() =>
      validateAskbackBody(
        { anchor, question: "q", image_id: realId },
        { hasImage: () => false },
      ),
    ).toThrow(`unknown image ${realId}`);
    expect(() =>
      validateAskbackBody({ anchor, question: "q", image_id: 7 }),
    ).toThrow(AskbackValidationError);
  });

  test("an image-free body still validates and carries no image_id key", () => {
    const out = validateAskbackBody({ anchor, question: "plain" });
    expect("image_id" in out).toBe(false);
  });
});
