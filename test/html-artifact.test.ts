// Issue 25 — free-form HTML hatch: server-side unit tests.
// Validation shape, frame-slug registry, the trusted shell + markup strips, and
// the exact header CSP string.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifactContent, ValidationError } from "../src/server/validate.js";
import { FrameRegistry, mintFrameSlug } from "../src/server/frames.js";
import {
  buildFrameDocument,
  sanitizeModelHtmlMarkup,
  stripMetaRefresh,
  stripNonceAttributes,
} from "../src/server/frameShell.js";
import { frameCsp } from "../src/server/frameHttp.js";
import { HTML_MAX } from "../src/shared/constraints.js";

describe("html validation", () => {
  test("accepts a well-formed html artifact", () => {
    const content = validateArtifactContent({
      type: "html",
      title: "Rich card",
      html: "<h1>Hi</h1>",
    });
    expect(content.type).toBe("html");
    expect((content as { html?: string }).html).toBe("<h1>Hi</h1>");
  });

  test("rejects html over 256KB", () => {
    expect(() =>
      validateArtifactContent({
        type: "html",
        title: "big",
        html: "a".repeat(HTML_MAX + 1),
      }),
    ).toThrow(ValidationError);
  });

  test("rejects empty html", () => {
    expect(() =>
      validateArtifactContent({ type: "html", title: "t", html: "" }),
    ).toThrow(ValidationError);
  });

  test("rejects a model-supplied frameSlug (server-minted only)", () => {
    expect(() =>
      validateArtifactContent({
        type: "html",
        title: "t",
        html: "<p>x</p>",
        frameSlug: "deadbeef".repeat(4),
      }),
    ).toThrow(ValidationError);
  });

  test("rejects other unknown fields", () => {
    expect(() =>
      validateArtifactContent({
        type: "html",
        title: "t",
        html: "<p>x</p>",
        script: "evil",
      }),
    ).toThrow(ValidationError);
  });
});

describe("frame slug registry", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("mints a 128-bit (32-hex) slug and resolves it round-trip", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-frames-"));
    const reg = new FrameRegistry(dir);
    const slug = reg.mint("a_00000001", 1);
    expect(slug).toMatch(/^[0-9a-f]{32}$/);
    expect(reg.resolve(slug)).toEqual({ artifactId: "a_00000001", version: 1 });
    expect(reg.slugFor("a_00000001", 1)).toBe(slug);
  });

  test("mint is idempotent per (id, version); distinct per version", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-frames-"));
    const reg = new FrameRegistry(dir);
    const a = reg.mint("a_00000001", 1);
    const again = reg.mint("a_00000001", 1);
    const v2 = reg.mint("a_00000001", 2);
    expect(again).toBe(a);
    expect(v2).not.toBe(a);
  });

  test("resolve rejects malformed / unknown slugs", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-frames-"));
    const reg = new FrameRegistry(dir);
    expect(reg.resolve("not-a-slug")).toBeNull();
    expect(reg.resolve(mintFrameSlug())).toBeNull(); // valid shape, unknown
    expect(reg.resolve(undefined)).toBeNull();
    expect(reg.resolve("A".repeat(32))).toBeNull(); // uppercase not allowed
  });

  test("slugs survive a restart (persisted to disk)", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-frames-"));
    const slug = new FrameRegistry(dir).mint("a_00000009", 3);
    const reopened = new FrameRegistry(dir);
    expect(reopened.resolve(slug)).toEqual({
      artifactId: "a_00000009",
      version: 3,
    });
  });
});

describe("trusted shell markup strips", () => {
  test("strips <meta http-equiv=refresh> (any quoting)", () => {
    expect(
      stripMetaRefresh('<meta http-equiv="refresh" content="0;url=x">'),
    ).toBe("");
    expect(stripMetaRefresh("<meta http-equiv=refresh content='1'>")).toBe("");
    expect(stripMetaRefresh("<p>keep</p>")).toBe("<p>keep</p>");
  });

  test("strips nonce= attributes from model tags", () => {
    expect(stripNonceAttributes('<script nonce="abc">x</script>')).toBe(
      "<script>x</script>",
    );
    expect(stripNonceAttributes("<style nonce=xyz>a{}</style>")).toBe(
      "<style>a{}</style>",
    );
  });

  test("buildFrameDocument embeds verbatim body + one nonce'd prelude", () => {
    const doc = buildFrameDocument(
      '<img src="https://beacon.example/x"><script>alert(1)</script>',
      "N0NCE",
    );
    // Model markup survives verbatim (inert under the header CSP).
    expect(doc).toContain('<img src="https://beacon.example/x">');
    // The model script carries NO nonce → CSP will block it.
    expect(doc).toContain("<script>alert(1)</script>");
    // Exactly one nonce'd script — the trusted prelude.
    expect(doc).toContain('<script nonce="N0NCE">');
    expect(doc.match(/nonce=/g)?.length).toBe(1);
    expect(doc).toContain("<!doctype html>");
  });

  test("prelude intercepts anchor clicks and speaks the closed openlink verb", () => {
    // The prelude is served as a string, so lock in its source: the capture-
    // phase click interception, the never-self-navigate preventDefault, the
    // absolute-http(s)-only + bounded checks, the fragment carve-out, and the
    // closed {v:'openlink',href} verb.
    const doc = buildFrameDocument("<a href='https://x.example/'>x</a>", "N0NCE");
    expect(doc).toContain("document.addEventListener('click', function (ev) {");
    expect(doc).toContain("ev.preventDefault(); // no self-navigation, ever");
    expect(doc).toContain(
      "if (url.protocol !== 'http:' && url.protocol !== 'https:') return;",
    );
    expect(doc).toContain("var HREF_MAX = 2048;");
    expect(doc).toContain("if (href.length > HREF_MAX) return;");
    expect(doc).toContain("send({ v: 'openlink', href: href });");
    // Pure in-page fragments keep their default same-document scroll.
    expect(doc).toContain("raw.charAt(0) === '#'");
    // The interception walks up the parent chain (clicks land on child spans).
    expect(doc).toContain("node = node.parentNode;");
  });

  test("sanitizeModelHtmlMarkup applies both strips", () => {
    const out = sanitizeModelHtmlMarkup(
      '<meta http-equiv="refresh" content="0"><b nonce="z">hi</b>',
    );
    expect(out).toBe("<b>hi</b>");
  });
});

describe("frame CSP", () => {
  test("exact directive string with nonce + canvas-origin frame-ancestors", () => {
    const csp = frameCsp("NONCE123", "http://127.0.0.1:8787");
    expect(csp).toBe(
      "default-src 'none'; script-src 'nonce-NONCE123'; style-src " +
        "'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; " +
        "form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:8787",
    );
  });
});
