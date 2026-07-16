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
import { runGate, runGateSafe } from "../src/gate/index.js";
import type { SvgElement } from "../src/sanitizer/ast.js";
import type { Bbox, CheckName, Finding, TextRun } from "../src/gate/index.js";
import {
  CANVAS_CONTENT_WIDTH,
  checkSubLegible,
  displayScaleFor,
} from "../src/gate/checks.js";
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
// A WIDE viewBox: the canvas shrinks it to 836px, so display scale is 836/1600 =
// 0.5225× — small user-space fonts render genuinely sub-legible here (issue 16).
const W = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 800">';
// A viewBox exactly twice the render width → display scale 836/1672 = 0.5×
// exactly, which makes the rendered-9px boundary land on round font sizes.
const B = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1672 400">';

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
    // 10px user-space font in a 1600-wide viewBox renders at ~5.2px (issue 16).
    name: "tiny text in a wide viewBox renders sub-legible",
    svg: W + '<text x="100" y="400" font-size="10">tiny in a wide canvas</text></svg>',
    check: "sub-legible",
    bbox: { x: 100, y: 390, w: 126, h: 12 },
  },
  {
    // Combined: transform scale 0.2 → 4px user space, then display scale 2.09×
    // in a 400-wide viewBox → ~8.36px rendered, still under the floor.
    name: "text sub-legible by combined transform and display scale",
    svg:
      S +
      '<g transform="scale(0.2)"><text x="100" y="200" font-size="20">shrunk small</text></g></svg>',
    check: "sub-legible",
    bbox: { x: 20, y: 36, w: 28.8, h: 4.8 },
  },
  {
    // Boundary just under: display scale 0.5×, 16px user → 8.0px rendered (< 9).
    name: "text just below the rendered 9px floor",
    svg: B + '<text x="200" y="200" font-size="16">boundary just under</text></svg>',
    check: "sub-legible",
    bbox: { x: 200, y: 184, w: 182.4, h: 19.2 },
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
  {
    // Calibration round-1 false positive #1: a 6px caption in a 400-wide viewBox
    // renders at ~12.5px on the 836px canvas — legible (issue 16, AC1).
    name: "round-1 6px caption in a 400 viewBox renders legibly",
    svg: S + '<text x="30" y="100" font-size="6">microscopic caption</text></svg>',
  },
  {
    // Calibration round-1 false positive #2: a 7px note renders at ~14.6px.
    name: "round-1 7px note in a 400 viewBox renders legibly",
    svg: S + '<text x="30" y="120" font-size="7">tiny note that still reads</text></svg>',
  },
  {
    // Boundary just above: display scale 0.5×, 18px user → 9.0px rendered — the
    // floor is inclusive, so this is legible (issue 16, AC3).
    name: "text at exactly the rendered 9px floor in a wide viewBox",
    svg: B + '<text x="200" y="200" font-size="18">boundary exactly nine</text></svg>',
  },
  {
    // Calibration round-3 false positive: an on-arrow edge-label sitting on the
    // connector between two container rects. Its wide bbox grazes BOTH container
    // edges, but its center is in the gap — outside every box — so it is NOT a
    // straddle. The old check flagged this twice (issue 17, AC1).
    name: "round-3 on-arrow edge-label grazing two container rects reads clean",
    svg:
      S +
      '<rect x="20" y="40" width="120" height="120" fill="none" stroke="black"/>' +
      '<rect x="240" y="40" width="120" height="120" fill="none" stroke="black"/>' +
      '<line x1="140" y1="100" x2="240" y2="100" stroke="black"/>' +
      '<text x="190" y="96" font-size="11" text-anchor="middle">SSE push, token fetch</text></svg>',
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

// ── edge-straddle over-fire fix (issue 17) ──────────────────────────────────
//
// The check must associate a label with the ONE box it belongs to (nearest
// containing shape), dedupe to at most one finding per run, and exclude
// on-arrow edge-labels whose center sits outside every shape.

import {
  checkEdgeStraddle,
  type Shape,
  type TextRun as GateTextRun,
} from "../src/gate/checks.js";

const shape = (ref: string, bbox: Bbox): Shape => ({
  ref,
  name: "rect",
  bbox,
  closed: true,
});
const textRun = (ref: string, bbox: Bbox): GateTextRun => ({
  ref,
  text: ref,
  bbox,
  transformedFontSize: 14,
});

describe("edge-straddle associates a label with one box (issue 17)", () => {
  test("AC1: on-arrow edge-label grazing two containers → zero findings (fixture)", () => {
    const svg =
      S +
      '<rect x="20" y="40" width="120" height="120" fill="none" stroke="black"/>' +
      '<rect x="240" y="40" width="120" height="120" fill="none" stroke="black"/>' +
      '<line x1="140" y1="100" x2="240" y2="100" stroke="black"/>' +
      '<text x="190" y="96" font-size="11" text-anchor="middle">SSE push, token fetch</text></svg>';
    expect(gate(svg).filter((f) => f.check === "edge-straddle")).toEqual([]);
  });

  test("AC2: a real straddle — center inside its OWN box, poking out a side → flagged with coords (fixture)", () => {
    // "Overflowing label" centred at (130,90) inside box A (40..140 × 60..120),
    // its bbox pokes past A's right edge. B sits just to the right; the bbox
    // also grazes B, but the label belongs to A.
    const svg =
      S +
      '<rect id="A" x="40" y="60" width="100" height="60" fill="none" stroke="black"/>' +
      '<rect id="B" x="150" y="60" width="100" height="60" fill="none" stroke="black"/>' +
      '<text x="130" y="95" font-size="12" text-anchor="middle">Overflowing label</text></svg>';
    const straddles = gate(svg).filter((f) => f.check === "edge-straddle");
    expect(straddles).toHaveLength(1);
    expect(straddles[0]!.elements).toContain("#A");
    expect(straddles[0]!.elements).not.toContain("#B");
    // Coordinate-bearing: the label bbox is reported.
    expect(near(straddles[0]!.bbox, { x: 68.8, y: 83, w: 122.4, h: 14.4 })).toBe(true);
    expect(straddles[0]!.message).toContain("#A");
  });

  test("AC3: a label grazing two rects yields exactly ONE finding (no double-count)", () => {
    // Same fixture as AC2: bbox overlaps both A and B. The old check produced
    // two findings (one per rect); the fix produces one, for the owning box.
    const svg =
      S +
      '<rect id="A" x="40" y="60" width="100" height="60" fill="none" stroke="black"/>' +
      '<rect id="B" x="150" y="60" width="100" height="60" fill="none" stroke="black"/>' +
      '<text x="130" y="95" font-size="12" text-anchor="middle">Overflowing label</text></svg>';
    expect(gate(svg).filter((f) => f.check === "edge-straddle")).toHaveLength(1);
  });

  test("unit: on-arrow exclusion — a center outside every shape is never a straddle", () => {
    // Label bbox spans the gap and clips both boxes, but its center (100,50) is
    // in neither box → not straddling.
    const runs = [textRun("#label", { x: 30, y: 44, w: 140, h: 12 })];
    const shapes = [
      shape("#left", { x: 0, y: 0, w: 60, h: 100 }),
      shape("#right", { x: 140, y: 0, w: 60, h: 100 }),
    ];
    expect(checkEdgeStraddle(runs, shapes)).toEqual([]);
  });

  test("unit: association-to-nearest-shape — a label in nested boxes flags the innermost", () => {
    // Center (80,60) sits inside both boxes; the inner box is smaller, so the
    // label belongs to it. The bbox pokes past BOTH right edges — the old check
    // flagged both; the fix flags only the inner one.
    const runs = [textRun("#label", { x: 30, y: 52, w: 100, h: 16 })]; // 30..130 × 52..68
    const shapes = [
      shape("#outer", { x: 20, y: 20, w: 80, h: 80 }), // 20..100
      shape("#inner", { x: 40, y: 40, w: 40, h: 40 }), // 40..80
    ];
    const findings = checkEdgeStraddle(runs, shapes);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.elements).toEqual(["#label", "#inner"]);
  });

  test("unit: dedupe — one run over adjacent boxes gives at most one finding", () => {
    // Center (110,60) is inside A only; the bbox also grazes B. One finding.
    const runs = [textRun("#label", { x: 60, y: 52, w: 100, h: 16 })]; // 60..160
    const shapes = [
      shape("#A", { x: 40, y: 40, w: 100, h: 40 }), // 40..140
      shape("#B", { x: 150, y: 40, w: 100, h: 40 }), // 150..250
    ];
    const findings = checkEdgeStraddle(runs, shapes);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.elements).toEqual(["#label", "#A"]);
  });

  test("unit: a label centred right on an edge (gap ≤ tolerance) still counts", () => {
    // Center x sits exactly on the box's right edge — within tolerance, so the
    // box still owns the label and the poke is flagged.
    const runs = [textRun("#label", { x: 60, y: 52, w: 80, h: 16 })]; // center (100,60)
    const shapes = [shape("#box", { x: 20, y: 40, w: 80, h: 40 })]; // 20..100
    const findings = checkEdgeStraddle(runs, shapes);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.elements).toEqual(["#label", "#box"]);
  });
});

// ── edge-straddle conservative-width poke (issue 18) ────────────────────────
//
// The 0.6-em text box is a generous UPPER bound. Safe for overlap/clip (they
// should over-warn), but for the straddle poke it manufactured a straddle a
// label did not have — calibration round 4: a 20-char label that really fit its
// box was ruled a false positive. The poke now measures the run's NARROWER
// `straddleBbox` (lower-bound width), flagging only when even that clearly pokes
// out. Ownership and the reported bbox stay on the 0.6-em `bbox` (issue-17
// behavior unchanged).

const textRunWithStraddle = (
  ref: string,
  bbox: Bbox,
  straddleBbox: Bbox,
): GateTextRun => ({ ref, text: ref, bbox, straddleBbox, transformedFontSize: 14 });

describe("edge-straddle uses a conservative width for the poke (issue 18)", () => {
  test("AC1: round-4 'label runs off right' — real render fits its box → ZERO edge-straddle", () => {
    // 20 chars @13px in a 160px box (x 100..260). The 0.6 estimate (156px) poked
    // 16px past the right edge and manufactured a straddle; the label really fit.
    const svg =
      S +
      '<rect x="100" y="40" width="160" height="60" fill="none" stroke="black"/>' +
      '<text x="120" y="75" font-size="13">label runs off right</text></svg>';
    expect(gate(svg).filter((f) => f.check === "edge-straddle")).toEqual([]);
  });

  test("AC1 (mechanism): the SAME geometry at the 0.6 width DID flag — the fix is the narrower poke box", () => {
    // Prove the round-4 case genuinely reproduced the bug: with only the wide
    // 0.6-em bbox (no straddleBbox) the old poke fires; adding the narrow
    // straddleBbox silences it. Box x 100..260; text start-anchored at x=120.
    const wide = { x: 120, y: 62, w: 156, h: 15.6 }; // 0.6 em → pokes 16px past 260
    const narrow = { x: 120, y: 62, w: 117, h: 15.6 }; // 0.45 em → fits (right 237)
    const owner = [shape("#box", { x: 100, y: 40, w: 160, h: 60 })];
    // Old behavior (bbox only): flags.
    expect(checkEdgeStraddle([textRun("#label", wide)], owner)).toHaveLength(1);
    // New behavior (narrow straddleBbox present): clean.
    expect(
      checkEdgeStraddle([textRunWithStraddle("#label", wide, narrow)], owner),
    ).toEqual([]);
  });

  test("AC2: a CLEARLY visible straddle — label far wider than its box → still flagged with coords", () => {
    // 22-char label centred on a 40px box (x 140..180): it pokes ~49px past the
    // edge even at the conservative 0.45-em width — unambiguous.
    const svg =
      S +
      '<rect id="box" x="140" y="50" width="40" height="40" fill="none" stroke="black"/>' +
      '<text x="160" y="75" font-size="14" text-anchor="middle">Overflowing Wide Label</text></svg>';
    const straddles = gate(svg).filter((f) => f.check === "edge-straddle");
    expect(straddles).toHaveLength(1);
    expect(straddles[0]!.elements).toContain("#box");
    // Coordinate-bearing: the reported bbox is the wide 0.6-em label box.
    expect(near(straddles[0]!.bbox, { x: 67.6, y: 61, w: 184.8, h: 16.8 })).toBe(true);
    expect(straddles[0]!.message).toContain("#box");
  });

  test("AC3 (regression): both existing straddle fixtures still flag with identical coords", () => {
    // The narrower poke must not silence GENUINE straddles. Re-run the two
    // round-11 edge-straddle BAD fixtures through the full pipeline.
    for (const fx of BAD.filter((b) => b.check === "edge-straddle")) {
      const match = gate(fx.svg).find((f) => f.check === "edge-straddle");
      expect(match, `no edge-straddle for ${fx.name}`).toBeDefined();
      expect(near(match!.bbox, fx.bbox)).toBe(true);
    }
  });

  test("unit: fits-vs-pokes boundary — the poke reads straddleBbox, not the wide bbox", () => {
    const owner = [shape("#box", { x: 40, y: 40, w: 80, h: 40 })]; // right edge 120
    // Wide bbox pokes 30px past; narrow straddleBbox ends at 118 → fits (≤ tol).
    const fits = textRunWithStraddle(
      "#label",
      { x: 60, y: 44, w: 90, h: 16 }, // 0.6: right 150, pokes 30
      { x: 60, y: 44, w: 58, h: 16 }, // narrow: right 118, within box
    );
    expect(checkEdgeStraddle([fits], owner)).toEqual([]);
    // Same wide bbox, but a narrow box that still clearly pokes → flags.
    const pokes = textRunWithStraddle(
      "#label",
      { x: 60, y: 44, w: 90, h: 16 },
      { x: 60, y: 44, w: 80, h: 16 }, // narrow: right 140, pokes 20
    );
    const found = checkEdgeStraddle([pokes], owner);
    expect(found).toHaveLength(1);
    expect(found[0]!.elements).toEqual(["#label", "#box"]);
    // The reported bbox is the WIDE box, unchanged (issue-17 contract).
    expect(found[0]!.bbox).toEqual({ x: 60, y: 44, w: 90, h: 16 });
  });

  test("unit: absent straddleBbox falls back to bbox (hand-built runs unaffected)", () => {
    // A run with no straddleBbox keeps the old poke semantics — the issue-17
    // unit tests (which build runs this way) must be untouched.
    const owner = [shape("#box", { x: 40, y: 40, w: 80, h: 40 })]; // right 120
    const runs = [textRun("#label", { x: 60, y: 44, w: 90, h: 16 })]; // right 150
    expect(checkEdgeStraddle(runs, owner)).toHaveLength(1);
  });
});

// ── Report-only is structural: the gate cannot block a publish (AC3) ────────

describe("runGateSafe fails open — a gate exception degrades to zero findings", () => {
  test("a clean root gates normally through the safe wrapper", () => {
    const result = sanitizeSvg(GOOD[0]!.svg);
    if (!result.ok) throw new Error("fixture did not sanitize");
    const safe = runGateSafe(result.root);
    expect(safe.error).toBeNull();
    expect(safe.findings).toEqual([]);
  });

  test("a root that makes runGate throw returns [] + an error, never propagates", () => {
    // A structurally broken AST (children not iterable) makes the real runGate
    // throw — proving the wrapper catches an ACTUAL throw, not a mocked one.
    const broken = {
      kind: "element",
      name: "svg",
      attributes: [],
      children: undefined,
      path: "/svg",
      line: 1,
    } as unknown as SvgElement;
    expect(() => runGate(broken)).toThrow(); // the raw gate does throw
    const safe = runGateSafe(broken); // the wrapper does not
    expect(safe.findings).toEqual([]);
    expect(safe.error).not.toBeNull();
  });
});

// ── Sub-legible display-scale model (issue 16) ──────────────────────────────

describe("sub-legible judges rendered px via display scale (issue 16)", () => {
  test("displayScaleFor divides the render width by the viewBox width", () => {
    expect(displayScaleFor(400)).toBeCloseTo(836 / 400, 6); // ~2.09×
    expect(displayScaleFor(1600)).toBeCloseTo(836 / 1600, 6); // ~0.52×
    expect(displayScaleFor(CANVAS_CONTENT_WIDTH)).toBe(1); // 1:1 at the render width
  });

  test("degenerate viewBox width falls back to scale 1 (never divides by zero)", () => {
    expect(displayScaleFor(null)).toBe(1); // no viewBox declared
    expect(displayScaleFor(0)).toBe(1); // zero width
    expect(displayScaleFor(-400)).toBe(1); // negative width
    expect(displayScaleFor(Number.NaN)).toBe(1);
    expect(displayScaleFor(Number.POSITIVE_INFINITY)).toBe(1);
  });

  const run = (transformedFontSize: number): TextRun => ({
    ref: "#t",
    text: "sample",
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    transformedFontSize,
  });

  test("judges the display-scaled px, not the raw user-space px", () => {
    // The same 6px user-space font: legible in a 400 viewBox (~12.5px), NOT in a
    // 1600 viewBox (~3px). This is the whole point of issue 16.
    expect(checkSubLegible([run(6)], 400)).toEqual([]);
    expect(checkSubLegible([run(6)], 1600)).toHaveLength(1);
  });

  test("combines transform scale and display scale multiplicatively", () => {
    // transformedFontSize already carries the transform scale; the 2.09× display
    // scale of a 400 viewBox pushes 4px → ~8.4px, still under the 9px floor.
    const findings = checkSubLegible([run(4)], 400);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("8.4px"); // rendered px, reported
    expect(findings[0]!.message).toContain("2.1×"); // display scale, reported
  });

  test("degenerate viewBox does not throw and does not false-positive a normal font", () => {
    // No usable width → scale 1; a 12px user-space font is still ≥ 9 → clean.
    expect(checkSubLegible([run(12)], null)).toEqual([]);
    expect(checkSubLegible([run(12)], 0)).toEqual([]);
    // The fallback still judges honestly: a genuinely tiny 6px font at scale 1
    // is caught, not silently passed.
    expect(checkSubLegible([run(6)], 0)).toHaveLength(1);
  });
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
