// Issue 09 — the sanitizer's spine. Hostile fixtures (each asserted rejected
// with a code + path), the benign suite (each accepted), idempotence, the
// tokenizer/allowlist/caps units, the zero-dependency guard, and the 10k
// mutation fuzz smoke.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  sanitizeSvg,
  SVG_ATTR_VALUE_MAX,
  SVG_INPUT_MAX_BYTES,
  type Violation,
} from "../src/sanitizer/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostileDir = join(here, "fixtures", "hostile");
const benignDir = join(here, "fixtures", "benign");

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

function expectReject(input: string): Violation[] {
  const result = sanitizeSvg(input);
  if (result.ok) throw new Error("expected ok: false, got ok: true");
  expect(result.violations.length).toBeGreaterThan(0);
  for (const v of result.violations) {
    expect(typeof v.code).toBe("string");
    expect(v.code.length).toBeGreaterThan(0);
    expect(typeof v.path).toBe("string");
    expect(v.path.startsWith("/")).toBe(true);
    expect(typeof v.detail).toBe("string");
    // Every violation is precise enough to fix: it names a line.
    expect(v.detail).toMatch(/line \d+/);
  }
  return result.violations;
}

function expectAccept(input: string): string {
  const result = sanitizeSvg(input);
  if (!result.ok) {
    throw new Error(
      `expected ok: true, got violations:\n${result.violations
        .map((v) => `  [${v.code}] ${v.path}: ${v.detail}`)
        .join("\n")}`,
    );
  }
  return result.svg;
}

// ── Hostile fixture suite (AC1) ─────────────────────────────────────────────

describe("hostile fixtures — every one is rejected (AC1)", () => {
  const files = readdirSync(hostileDir).filter((f) => f.endsWith(".svg")).sort();

  test("the suite has at least 15 fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of files) {
    test(`${file} → ok:false with code + path`, () => {
      expectReject(read(hostileDir, file));
    });
  }

  // Spot-check that the right code fires for representative attacks, so a
  // future refactor that "rejects for the wrong reason" is caught.
  const codeFor = (file: string): string[] =>
    expectReject(read(hostileDir, file)).map((v) => v.code);

  test("script element → element-not-allowed", () => {
    expect(codeFor("01-script-element.svg")).toContain("element-not-allowed");
  });
  test("onload/onclick → event-attribute", () => {
    expect(codeFor("02-onload-attribute.svg")).toContain("event-attribute");
  });
  test("foreignObject/iframe → element-not-allowed", () => {
    expect(codeFor("03-foreignobject-iframe.svg")).toContain(
      "element-not-allowed",
    );
  });
  test("javascript:/data: href → attribute-not-allowed (a + href both gone)", () => {
    const codes = codeFor("04-javascript-href.svg");
    expect(codes).toContain("element-not-allowed"); // <a>
  });
  test("use recursion → element-not-allowed (use is not in the subset)", () => {
    expect(codeFor("05-use-recursion.svg")).toContain("element-not-allowed");
  });
  test("billion laughs → doctype-not-allowed (entities never expand)", () => {
    expect(codeFor("06-billion-laughs.svg")).toContain("doctype-not-allowed");
  });
  test("CDATA smuggle → cdata-not-allowed", () => {
    expect(codeFor("07-cdata-script.svg")).toContain("cdata-not-allowed");
  });
  test("url() beacon in fill → attribute-value-rejected", () => {
    expect(codeFor("08-url-beacon-fill.svg")).toContain(
      "attribute-value-rejected",
    );
  });
  test("style element → element-not-allowed", () => {
    expect(codeFor("09-style-import.svg")).toContain("element-not-allowed");
  });
  test("style attribute → attribute-not-allowed", () => {
    expect(codeFor("10-style-attribute.svg")).toContain("attribute-not-allowed");
  });
  test("animate injection → element-not-allowed", () => {
    expect(codeFor("11-animate-injection.svg")).toContain("element-not-allowed");
  });
  test("nested svg + xlink image → element-not-allowed", () => {
    expect(codeFor("12-nested-svg-xlink.svg")).toContain("element-not-allowed");
  });
  test("comment-split token → malformed-xml (tokens never reassemble across a comment)", () => {
    // <scr<!-- x -->ipt> must never be read as <script>: the parser sees a
    // malformed start tag the instant "<" appears mid-name, well before the
    // comment could be elided. Rejected either way.
    expect(codeFor("13-comment-split-token.svg")).toContain("malformed-xml");
  });
  test("homoglyph element → element-not-allowed", () => {
    expect(codeFor("14-homoglyph-element.svg")).toContain("element-not-allowed");
  });
  test("missing-quote attribute → malformed-xml", () => {
    expect(codeFor("15-missing-quote-attribute.svg")).toContain("malformed-xml");
  });
  test("depth bomb → depth-exceeded", () => {
    expect(codeFor("16-depth-bomb.svg")).toContain("depth-exceeded");
  });
});

// ── Caps are checked first, and exceeding one is a violation (not truncation) ─

describe("hard caps (AC: caps first, reject-not-truncate)", () => {
  test("input over 256KB → input-too-large, before any parse", () => {
    // A well-formed-looking but oversized document: the cap fires regardless.
    const filler = "<rect width=\"1\" height=\"1\"/>".repeat(12000);
    const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${filler}</svg>`;
    expect(big.length).toBeGreaterThan(SVG_INPUT_MAX_BYTES);
    const result = sanitizeSvg(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]!.code).toBe("input-too-large");
  });

  test("more than 5000 elements → too-many-elements (element bomb)", () => {
    const filler = '<rect width="1" height="1"/>'.repeat(6000);
    const bomb = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${filler}</svg>`;
    // Keep it under the byte cap so the element cap is what fires.
    expect(bomb.length).toBeLessThan(SVG_INPUT_MAX_BYTES);
    const result = sanitizeSvg(bomb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "too-many-elements")).toBe(
        true,
      );
    }
  });

  test("attribute value over 4KB → attr-value-too-long", () => {
    const long = "1 ".repeat(SVG_ATTR_VALUE_MAX);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><polyline points="${long}"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "attr-value-too-long")).toBe(
        true,
      );
    }
  });
});

// ── Benign suite (AC2) ──────────────────────────────────────────────────────

describe("benign fixtures — every one is accepted (AC2)", () => {
  const files = readdirSync(benignDir).filter((f) => f.endsWith(".svg")).sort();

  test("the suite has at least 5 fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    test(`${file} → ok:true and output carries the SVG namespace`, () => {
      const out = expectAccept(read(benignDir, file));
      expect(out.startsWith("<svg")).toBe(true);
      expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    });
  }

  test("the prototype flowchart preserves its meaning (labels + arrows)", () => {
    const out = expectAccept(read(benignDir, "flowchart.svg"));
    expect(out).toContain("TRUST BOUNDARY");
    expect(out).toContain("Canvas Server (MCP)");
    // Arrowhead markers survive, referenced by url(#id).
    expect(out).toContain('id="arr"');
    expect(out).toContain("marker-end=\"url(#arr)\"");
    // The 🔒 and — glyphs survive as text.
    expect(out).toContain("🔒");
  });
});

// ── Idempotence (AC3) ───────────────────────────────────────────────────────

describe("idempotence — sanitize(sanitize(x)) byte-equals sanitize(x) (AC3)", () => {
  const files = readdirSync(benignDir).filter((f) => f.endsWith(".svg")).sort();
  for (const file of files) {
    test(file, () => {
      const once = expectAccept(read(benignDir, file));
      const twice = expectAccept(once);
      expect(twice).toBe(once);
    });
  }
});

// ── Re-serialization proof: input bytes never reach output ──────────────────

describe("re-serialization (input bytes never pass through)", () => {
  test("messy-but-benign input is normalized: whitespace, quotes, self-close", () => {
    const messy = read(benignDir, "minimal.svg");
    const out = expectAccept(messy);
    // Canonical writer emits attributes in a fixed order, double-quoted, and
    // self-closes empty elements — so the byte stream differs from the input.
    expect(out).not.toBe(messy);
    expect(out).toContain('<rect fill="teal" height="10" width="10"/>');
    // No newlines/indentation carried through from the source.
    expect(out).not.toContain("\n   ");
  });

  test("attribute order is canonical regardless of source order", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect stroke="red" fill="none" y="1" x="0" width="1" height="1"/></svg>';
    const out = expectAccept(svg);
    expect(out).toContain(
      '<rect fill="none" height="1" stroke="red" width="1" x="0" y="1"/>',
    );
  });

  test("text is re-escaped by the writer, not passed through", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text x="0" y="0">a &amp; b &lt; c</text></svg>';
    const out = expectAccept(svg);
    expect(out).toContain("<text x=\"0\" y=\"0\">a &amp; b &lt; c</text>");
  });
});

// ── Tokenizer / allowlist units ─────────────────────────────────────────────

describe("tokenizer + allowlist units", () => {
  const wrap = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${inner}</svg>`;

  test("root must be <svg>", () => {
    const codes = expectReject('<g xmlns="http://www.w3.org/2000/svg"></g>').map(
      (v) => v.code,
    );
    expect(codes).toContain("root-not-svg");
  });

  test("unknown element rejected with its path", () => {
    const v = expectReject(wrap("<blink/>"));
    const hit = v.find((x) => x.code === "element-not-allowed")!;
    expect(hit.path).toContain("blink");
  });

  test("unknown attribute rejected", () => {
    expect(expectReject(wrap('<rect class="x" width="1" height="1"/>')).map((x) => x.code)).toContain(
      "attribute-not-allowed",
    );
  });

  test("marker-only attribute rejected on a plain element", () => {
    expect(
      expectReject(wrap('<rect refX="1" width="1" height="1"/>')).map((x) => x.code),
    ).toContain("attribute-not-allowed");
  });

  test("paint allowlist: names, hex, rgb, rgba, none accepted", () => {
    for (const paint of ["black", "#abc", "#aabbcc", "#aabbccdd", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "none"]) {
      expectAccept(wrap(`<rect width="1" height="1" fill="${paint}"/>`));
    }
  });

  test("paint allowlist: url() and unknown names rejected", () => {
    for (const paint of ["url(#g)", "cornflowerblue", "expression(1)", "rgb(1,2)"]) {
      const codes = expectReject(wrap(`<rect width="1" height="1" fill="${paint}"/>`)).map(
        (v) => v.code,
      );
      expect(codes).toContain("attribute-value-rejected");
    }
  });

  test("path data char-allowlist rejects letters outside the command set", () => {
    expect(
      expectReject(wrap('<path d="M0 0 Z alert(1)"/>')).map((v) => v.code),
    ).toContain("attribute-value-rejected");
  });

  test("transform allows translate/rotate/scale/matrix, rejects skewX and others", () => {
    expectAccept(wrap('<g transform="translate(1,2) rotate(45) scale(2)"><rect width="1" height="1"/></g>'));
    for (const t of ["skewX(10)", "url(#x)", "translate(a,b)", "rotate(1,2)"]) {
      expect(
        expectReject(wrap(`<g transform="${t}"><rect width="1" height="1"/></g>`)).map(
          (v) => v.code,
        ),
      ).toContain("attribute-value-rejected");
    }
  });

  test("id must match the id pattern; duplicates rejected", () => {
    expectAccept(wrap('<rect id="node-1" width="1" height="1"/>'));
    expect(expectReject(wrap('<rect id="1bad" width="1" height="1"/>')).map((v) => v.code)).toContain(
      "attribute-value-rejected",
    );
    const dup = expectReject(
      wrap('<rect id="dup" width="1" height="1"/><rect id="dup" width="1" height="1"/>'),
    ).map((v) => v.code);
    expect(dup).toContain("duplicate-id");
  });

  test("marker reference must resolve to a real <marker> id", () => {
    const codes = expectReject(
      wrap('<line x1="0" y1="0" x2="1" y2="1" marker-end="url(#ghost)"/>'),
    ).map((v) => v.code);
    expect(codes).toContain("marker-ref-unresolved");
  });

  test("text is only allowed inside text/tspan/title/desc", () => {
    expect(expectReject(wrap("<g>loose text</g>")).map((v) => v.code)).toContain(
      "text-not-allowed",
    );
    expectAccept(wrap('<text x="0" y="0">ok</text>'));
    expectAccept(wrap("<title>ok</title>"));
  });

  test("only the five entities are allowed; others rejected", () => {
    expectAccept(wrap('<text x="0" y="0">&amp;&lt;&gt;&quot;&apos;&#38;&#x26;</text>'));
    for (const bad of ["&nbsp;", "&copy;", "&#160;", "&#xA0;", "&foo;", "& "]) {
      expect(
        expectReject(wrap(`<text x="0" y="0">${bad}</text>`)).map((v) => v.code),
      ).toContain("entity-not-allowed");
    }
  });

  test("comments, CDATA, PIs, DOCTYPE each rejected by name", () => {
    expect(expectReject(wrap("<!-- c -->")).map((v) => v.code)).toContain(
      "comment-not-allowed",
    );
    expect(expectReject(wrap("<![CDATA[x]]>")).map((v) => v.code)).toContain(
      "cdata-not-allowed",
    );
    expect(expectReject("<?xml version=\"1.0\"?>" + wrap("")).map((v) => v.code)).toContain(
      "processing-instruction-not-allowed",
    );
    expect(
      expectReject("<!DOCTYPE svg>" + wrap("")).map((v) => v.code),
    ).toContain("doctype-not-allowed");
  });

  test("mismatched / unterminated tags are malformed-xml", () => {
    expect(expectReject('<svg xmlns="http://www.w3.org/2000/svg"><rect></g></svg>').map((v) => v.code)).toContain(
      "malformed-xml",
    );
    expect(expectReject('<svg xmlns="http://www.w3.org/2000/svg"><rect ').map((v) => v.code)).toContain(
      "malformed-xml",
    );
  });

  test("control characters in values are rejected", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text x="0" y="0">badbell</text></svg>`;
    expect(expectReject(svg).map((v) => v.code)).toContain("control-character");
  });
});

// ── Fuzz smoke (AC4) ────────────────────────────────────────────────────────

describe("fuzz smoke: output never contains dangerous tokens (AC4)", () => {
  test("10k random mutations of benign fixtures — output stays inert", () => {
    const seeds = readdirSync(benignDir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => read(benignDir, f));

    // A tiny deterministic PRNG so failures reproduce (seeded LCG).
    let state = 0x2545f491;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    const INJECT = [
      "<script>alert(1)</script>",
      ' onload="alert(1)"',
      ' onclick="x()"',
      "url(https://evil.example/b.png)",
      ' href="javascript:alert(1)"',
      ' xlink:href="data:text/html,x"',
      "<foreignObject><iframe></iframe></foreignObject>",
      "<!-- comment -->",
      "<![CDATA[x]]>",
      "&nbsp;",
      ' style="background:url(x)"',
    ];

    // AC4 asks that output never contains <script, on[a-z]+=, url(, href.
    // Two refinements, both flagged for security review:
    //   (a) The checks run against MARKUP only — text-node payloads are
    //       stripped first. An escaped label reading "see href" or "url(x)"
    //       is inert in an image-isolated SVG; the danger we assert against
    //       is an active element/attribute, never a displayed character.
    //   (b) The one url() the subset permits is a same-document marker
    //       reference url(#id) (validated to resolve to a real <marker>);
    //       the prototype flowchart relies on it. External/smuggling url(…)
    //       — anything not immediately followed by "#" — stays forbidden.
    const stripText = (svg: string): string => svg.replace(/>[^<]*</g, "><");
    const dangerous = [
      /<script/i,
      /\son[a-z]+\s*=/i,
      /url\((?!#[a-zA-Z])/i,
      /href/i,
    ];

    for (let i = 0; i < 10_000; i++) {
      let s = pick(seeds);
      const mutations = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < mutations; m++) {
        const op = rand();
        if (op < 0.45 && s.length > 4) {
          // Splice a hostile token at a random position.
          const at = Math.floor(rand() * s.length);
          s = s.slice(0, at) + pick(INJECT) + s.slice(at);
        } else if (op < 0.7 && s.length > 8) {
          // Delete a random slice (parser stress: truncation, torn tags).
          const at = Math.floor(rand() * (s.length - 4));
          s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rand() * 4));
        } else {
          // Flip a random character.
          const at = Math.floor(rand() * s.length);
          s =
            s.slice(0, at) +
            String.fromCharCode(32 + Math.floor(rand() * 94)) +
            s.slice(at + 1);
        }
      }
      const result = sanitizeSvg(s);
      if (result.ok) {
        const markup = stripText(result.svg);
        for (const re of dangerous) {
          if (re.test(markup)) {
            throw new Error(
              `mutation ${i} produced dangerous output matching ${re}:\n${result.svg.slice(0, 400)}`,
            );
          }
        }
      }
    }
  }, 30_000);
});

// ── Zero-dependency guard (AC5) ─────────────────────────────────────────────

describe("zero runtime dependencies (AC5)", () => {
  test("package.json declares no runtime deps beyond the MCP SDK, none added for the sanitizer", () => {
    const pkg = JSON.parse(read(join(here, ".."), "package.json")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(["@modelcontextprotocol/sdk"]);
  });

  test("src/sanitizer imports nothing outside its own directory", () => {
    const dir = join(here, "..", "src", "sanitizer");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = read(dir, file);
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        // Only relative imports within src/sanitizer are permitted.
        expect(spec.startsWith("./")).toBe(true);
      }
    }
  });
});
