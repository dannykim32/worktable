// Legibility Gate unit + fixture suite (issue 11). The gate consumes the
// sanitizer's AST (never reparses SVG), so every fixture goes through
// sanitizeSvg() first — proving the two modules compose on the publish path.
//
// AC1: ≥8 known-bad SVGs each produce the expected finding with coords within
// ±5px; ≥5 known-good produce zero findings.
// AC5: the gate is pure geometry — zero runtime deps, no DOM (guarded below).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sanitizeSvg } from "../src/sanitizer/index.js";
import { runGate } from "../src/gate/index.js";
import type { Bbox, CheckName, Finding } from "../src/gate/index.js";
import {
  applyToPoint,
  bboxOfPoints,
  IDENTITY,
  intersect,
  multiply,
  parsePoints,
  parseTransform,
  pathPoints,
  scaleOf,
  textLocalBbox,
  transformBbox,
} from "../src/gate/geometry.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Sanitize then gate — the exact composition the server's publish path uses. */
function gate(svg: string): Finding[] {
  const result = sanitizeSvg(svg);
  if (!result.ok) {
    throw new Error(
      `fixture did not sanitize: ${result.violations
        .map((v) => `${v.code} ${v.detail}`)
        .join("; ")}`,
    );
  }
  return runGate(result.root);
}

function near(a: Bbox, b: Bbox, tol = 5): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol &&
    Math.abs(a.h - b.h) <= tol
  );
}

const S = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">';

// ── The ±5px fixture suite ──────────────────────────────────────────────────

interface BadFixture {
  name: string;
  svg: string;
  check: CheckName;
  bbox: Bbox;
}

const BAD: BadFixture[] = [
  {
    name: "overlapping stacked labels",
    svg:
      S +
      '<text x="30" y="60" font-size="16">Deploy Service</text>' +
      '<text x="30" y="66" font-size="16">Deploy Server</text></svg>',
    check: "text-overlap",
    bbox: { x: 30, y: 50, w: 124.8, h: 13.2 },
  },
  {
    name: "labels colliding side-by-side",
    svg:
      S +
      '<text x="40" y="100" font-size="14" text-anchor="middle">Alpha</text>' +
      '<text x="55" y="100" font-size="14" text-anchor="middle">Beta</text></svg>',
    check: "text-overlap",
    bbox: { x: 38.2, y: 86, w: 22.8, h: 16.8 },
  },
  {
    name: "label straddling a box right edge",
    svg:
      S +
      '<rect x="40" y="40" width="80" height="50" fill="none" stroke="black"/>' +
      '<text x="120" y="70" font-size="13" text-anchor="middle">Overhang</text></svg>',
    check: "edge-straddle",
    bbox: { x: 88.8, y: 57, w: 62.4, h: 15.6 },
  },
  {
    name: "label straddling a box top edge",
    svg:
      S +
      '<rect x="60" y="80" width="120" height="60" fill="none" stroke="black"/>' +
      '<text x="120" y="84" font-size="13" text-anchor="middle">On The Edge</text></svg>',
    check: "edge-straddle",
    bbox: { x: 77.1, y: 71, w: 85.8, h: 15.6 },
  },
  {
    name: "node clipped off the right edge",
    svg: S + '<rect x="360" y="60" width="70" height="40" fill="teal"/></svg>',
    check: "clipped",
    bbox: { x: 360, y: 60, w: 70, h: 40 },
  },
  {
    name: "node clipped above the top edge",
    svg: S + '<circle cx="100" cy="-10" r="25" fill="navy"/></svg>',
    check: "clipped",
    bbox: { x: 75, y: -35, w: 50, h: 50 },
  },
  {
    name: "wide label running off the canvas",
    svg:
      S +
      '<text x="250" y="100" font-size="20">This label runs off the canvas edge</text></svg>',
    check: "clipped",
    bbox: { x: 250, y: 80, w: 420, h: 24 },
  },
  {
    name: "6px sub-legible caption",
    svg: S + '<text x="30" y="100" font-size="6">microscopic caption</text></svg>',
    check: "sub-legible",
    bbox: { x: 30, y: 94, w: 68.4, h: 7.2 },
  },
  {
    name: "text shrunk sub-legible by a transform",
    svg:
      S +
      '<g transform="scale(0.4)"><text x="100" y="200" font-size="20">shrunk by transform</text></g></svg>',
    check: "sub-legible",
    bbox: { x: 40, y: 72, w: 91.2, h: 9.6 },
  },
];

const GOOD: Array<{ name: string; svg: string }> = [
  {
    name: "label centred inside a box",
    svg:
      S +
      '<rect x="40" y="40" width="160" height="60" fill="none" stroke="black"/>' +
      '<text x="120" y="76" font-size="14" text-anchor="middle">Inside</text></svg>',
  },
  {
    name: "two well-separated labels",
    svg:
      S +
      '<text x="30" y="50" font-size="14">Left Node</text>' +
      '<text x="250" y="50" font-size="14">Right Node</text></svg>',
  },
  {
    name: "a small clean flow: two boxes and a connector",
    svg:
      S +
      '<rect x="30" y="70" width="120" height="50" fill="none" stroke="black"/>' +
      '<text x="90" y="100" font-size="13" text-anchor="middle">Source</text>' +
      '<line x1="150" y1="95" x2="240" y2="95" stroke="black"/>' +
      '<rect x="240" y="70" width="120" height="50" fill="none" stroke="black"/>' +
      '<text x="300" y="100" font-size="13" text-anchor="middle">Sink</text></svg>',
  },
  {
    name: "text halved by a transform but still legible",
    svg:
      S +
      '<g transform="scale(0.5)"><text x="80" y="120" font-size="20">Halved but fine</text></g></svg>',
  },
  {
    name: "a title sitting cleanly above its box",
    svg:
      S +
      '<rect x="60" y="70" width="160" height="70" fill="none" stroke="black"/>' +
      '<text x="140" y="55" font-size="13" text-anchor="middle">Section Title</text></svg>',
  },
  {
    name: "text at exactly the 9px legibility floor",
    svg: S + '<text x="30" y="100" font-size="9">just legible enough</text></svg>',
  },
];

describe("fixture suite — known-bad SVGs (AC1)", () => {
  for (const fx of BAD) {
    test(`${fx.name} → ${fx.check} within ±5px`, () => {
      const findings = gate(fx.svg);
      const match = findings.find((f) => f.check === fx.check);
      expect(match, `no ${fx.check} finding in ${JSON.stringify(findings)}`).toBeDefined();
      expect(
        near(match!.bbox, fx.bbox),
        `bbox ${JSON.stringify(match!.bbox)} not within ±5px of ${JSON.stringify(fx.bbox)}`,
      ).toBe(true);
      // Findings are coordinate-bearing and element-referencing (issue 12 input).
      expect(match!.elements.length).toBeGreaterThan(0);
      expect(match!.message.length).toBeGreaterThan(0);
    });
  }

  test(`the suite covers all four checks across ≥8 bad fixtures`, () => {
    expect(BAD.length).toBeGreaterThanOrEqual(8);
    const checks = new Set(BAD.map((b) => b.check));
    expect([...checks].sort()).toEqual([
      "clipped",
      "edge-straddle",
      "sub-legible",
      "text-overlap",
    ]);
  });
});

describe("fixture suite — known-good SVGs produce zero findings (AC1)", () => {
  expect(GOOD.length).toBeGreaterThanOrEqual(5);
  for (const fx of GOOD) {
    test(`${fx.name} → clean`, () => {
      expect(gate(fx.svg)).toEqual([]);
    });
  }
});

// ── Geometry units (bbox math incl. transforms + anchors) ───────────────────

describe("geometry — matrices and transforms", () => {
  test("multiply composes parent∘child in SVG order", () => {
    const t = parseTransform("translate(10 20)");
    const s = parseTransform("scale(2)");
    // translate then scale: a child point (1,1) → scaled (2,2) → translated (12,22).
    const m = multiply(t, s);
    expect(applyToPoint(m, 1, 1)).toEqual([12, 22]);
  });

  test("parseTransform handles translate, scale, rotate, and matrix", () => {
    expect(parseTransform("translate(5)")).toEqual([1, 0, 0, 1, 5, 0]);
    expect(parseTransform("scale(2 3)")).toEqual([2, 0, 0, 3, 0, 0]);
    expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
    const [x, y] = applyToPoint(parseTransform("rotate(90)"), 1, 0);
    expect(Math.round(x)).toBe(0);
    expect(Math.round(y)).toBe(1);
  });

  test("rotate about a centre leaves the centre fixed", () => {
    const m = parseTransform("rotate(37 50 60)");
    const [x, y] = applyToPoint(m, 50, 60);
    expect(Math.round(x)).toBe(50);
    expect(Math.round(y)).toBe(60);
  });

  test("scaleOf returns the area-scale (sqrt of |det|)", () => {
    expect(scaleOf(parseTransform("scale(0.5)"))).toBeCloseTo(0.5, 6);
    expect(scaleOf(parseTransform("scale(2 8)"))).toBeCloseTo(4, 6);
    expect(scaleOf(IDENTITY)).toBe(1);
  });

  test("transformBbox AABBs a rotated box conservatively", () => {
    const b = transformBbox(parseTransform("rotate(45)"), { x: 0, y: 0, w: 10, h: 0 });
    // A 10-wide horizontal segment rotated 45° spans ~7.07 in x and y.
    expect(b.w).toBeCloseTo(Math.SQRT1_2 * 10, 4);
    expect(b.h).toBeCloseTo(Math.SQRT1_2 * 10, 4);
  });
});

describe("geometry — text bbox anchors", () => {
  test("start anchor puts x at the left edge", () => {
    const b = textLocalBbox(4, 10, 100, 50, "start");
    expect(b).toEqual({ x: 100, y: 40, w: 24, h: 12 });
  });

  test("middle anchor centres the box on x", () => {
    const b = textLocalBbox(4, 10, 100, 50, "middle");
    expect(b.x).toBe(100 - 12);
    expect(b.w).toBe(24);
  });

  test("end anchor puts x at the right edge", () => {
    const b = textLocalBbox(4, 10, 100, 50, "end");
    expect(b.x).toBe(100 - 24);
  });
});

describe("geometry — shape helpers", () => {
  test("parsePoints reads coordinate pairs", () => {
    expect(parsePoints("0,0 10 10 20,0")).toEqual([
      [0, 0],
      [10, 10],
      [20, 0],
    ]);
  });

  test("bboxOfPoints spans the extremes", () => {
    expect(bboxOfPoints([[0, 0], [10, 5], [-3, 8]])).toEqual({
      x: -3,
      y: 0,
      w: 13,
      h: 8,
    });
  });

  test("pathPoints tracks absolute + relative moves and closes", () => {
    // M then relative l, absolute H, and Z back to start.
    const pts = pathPoints("M 10 10 l 20 0 H 50 Z");
    expect(pts).toContainEqual([10, 10]);
    expect(pts).toContainEqual([30, 10]);
    expect(pts).toContainEqual([50, 10]);
    const bb = bboxOfPoints(pts);
    expect(bb).toEqual({ x: 10, y: 10, w: 40, h: 0 });
  });

  test("intersect returns the overlap rect or null", () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
      x: 5,
      y: 5,
      w: 5,
      h: 5,
    });
    expect(intersect({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 })).toBeNull();
  });
});

// ── AC5: pure geometry — zero runtime deps, no DOM ──────────────────────────

describe("gate module is pure geometry — zero deps, no DOM (AC5)", () => {
  const dir = join(here, "..", "src", "gate");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  test("imports nothing beyond its own dir and the sanitizer AST types", () => {
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specs) {
        const ok = spec.startsWith("./") || spec === "../sanitizer/ast.js";
        expect(ok, `${file} imports disallowed module ${spec}`).toBe(true);
      }
    }
  });

  test("references no DOM globals (document/window/HTMLElement)", () => {
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(/\b(document|window|HTMLElement|globalThis)\b/.test(src)).toBe(false);
    }
  });
});
