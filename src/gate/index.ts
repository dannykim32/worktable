// Legibility Gate — public entry (issue 11). Walks the sanitizer's AST (never
// reparsing SVG: the sanitizer is the project's only SVG parser), lays out
// every text run and shape in user space, and runs the four readability
// checks. REPORT-ONLY in this milestone: this function only COMPUTES findings.
// Nothing here blocks, alters, or rejects an artifact — that is the wiring
// caller's contract, and enforcement is a later milestone (issue 12).
//
// Zero runtime dependencies, no DOM — the only import is the sanitizer's AST
// *types*, which are erased at build time.
import type { SvgElement, SvgNode } from "../sanitizer/ast.js";
import {
  checkClipped,
  checkEdgeStraddle,
  checkSubLegible,
  checkTextOverlap,
  type Finding,
  type Shape,
  type TextRun,
} from "./checks.js";
import {
  type Bbox,
  bboxOfPoints,
  IDENTITY,
  type Matrix,
  multiply,
  parsePoints,
  parseTransform,
  pathPoints,
  scaleOf,
  STRADDLE_WIDTH_PER_EM,
  textLocalBbox,
  transformBbox,
} from "./geometry.js";

export type { Bbox, Matrix } from "./geometry.js";
export type { CheckName, Finding, Shape, TextRun } from "./checks.js";

const CLOSED_SHAPES = new Set(["rect", "circle", "ellipse", "polygon"]);
const OPEN_SHAPES = new Set(["line", "polyline", "path"]);
const DEFAULT_FONT_SIZE = 16; // the SVG default when none is inherited

interface Ctx {
  matrix: Matrix;
  fontSize: number;
  anchor: string;
  /** Current text position, for <tspan>s that omit x / y. */
  textX: number;
  textY: number;
}

interface Collected {
  runs: TextRun[];
  shapes: Shape[];
  /** Every element with a bbox, for the clip check. */
  boxed: Array<{ ref: string; name: string; bbox: Bbox }>;
}

/**
 * Run the Legibility Gate over a sanitized SVG AST. Returns the findings; an
 * empty array means the gate is clean. Pure and side-effect free.
 */
export function runGate(root: SvgElement): Finding[] {
  const collected: Collected = { runs: [], shapes: [], boxed: [] };
  const viewBox = parseViewBox(root);
  walk(root, { matrix: IDENTITY, fontSize: DEFAULT_FONT_SIZE, anchor: "start", textX: 0, textY: 0 }, collected);

  // The sub-legible check judges ON-SCREEN pixels, so it needs the display
  // scale, which comes from the root viewBox width (issue 16). A null viewBox
  // (no frame declared) passes null through — the check falls back to scale 1.
  return [
    ...checkTextOverlap(collected.runs),
    ...checkEdgeStraddle(collected.runs, collected.shapes),
    ...checkClipped(collected.boxed, viewBox),
    ...checkSubLegible(collected.runs, viewBox ? viewBox.w : null),
  ];
}

/**
 * Fail-open wrapper for the publish path. The gate is REPORT-ONLY (ADR-0007):
 * it must NEVER decide whether an artifact publishes — not by its findings, and
 * not by throwing. `runGate` is intended to be total, but a geometry bug on a
 * pathological input must not become a publish-blocking exception. So any throw
 * is swallowed here and degrades to zero findings; the caller publishes anyway.
 */
export function runGateSafe(root: SvgElement): {
  findings: Finding[];
  error: string | null;
} {
  try {
    return { findings: runGate(root), error: null };
  } catch (err) {
    return { findings: [], error: String(err) };
  }
}

/** The root viewBox as a user-space box, or a width/height fallback, or null
 *  when neither is declared (the clip check then has no frame and is skipped). */
export function parseViewBox(root: SvgElement): Bbox | null {
  const vb = attr(root, "viewBox");
  if (vb) {
    const n = vb.trim().split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x));
    if (n.length === 4) return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
  }
  const w = num(attr(root, "width"));
  const h = num(attr(root, "height"));
  if (w !== undefined && h !== undefined) return { x: 0, y: 0, w, h };
  return null;
}

function walk(el: SvgElement, ctx: Ctx, out: Collected): void {
  const local = attr(el, "transform");
  const matrix = local ? multiply(ctx.matrix, parseTransform(local)) : ctx.matrix;
  const fontSize = num(attr(el, "font-size")) ?? ctx.fontSize;
  const anchor = attr(el, "text-anchor") ?? ctx.anchor;

  const ref = refOf(el);

  if (el.name === "text" || el.name === "tspan") {
    const x = num(attr(el, "x")) ?? ctx.textX;
    const y = num(attr(el, "y")) ?? ctx.textY;
    const child: Ctx = { matrix, fontSize, anchor, textX: x, textY: y };
    const directText = directTextOf(el);
    if (directText !== "") {
      const chars = [...directText].length;
      const local2 = textLocalBbox(chars, fontSize, x, y, anchor);
      const bbox = transformBbox(matrix, local2);
      // A second, NARROWER box (lower-bound width) for the edge-straddle poke
      // only — see STRADDLE_WIDTH_PER_EM (issue 18). Same anchor/height as bbox.
      const straddleLocal = textLocalBbox(
        chars, fontSize, x, y, anchor, STRADDLE_WIDTH_PER_EM,
      );
      const straddleBbox = transformBbox(matrix, straddleLocal);
      out.runs.push({
        ref,
        text: directText,
        bbox,
        straddleBbox,
        transformedFontSize: fontSize * scaleOf(matrix),
      });
      out.boxed.push({ ref, name: el.name, bbox });
    }
    for (const c of el.children) {
      if (c.kind === "element") walk(c, child, out);
    }
    return;
  }

  const shapeBox = shapeLocalBbox(el);
  if (shapeBox) {
    const bbox = transformBbox(matrix, shapeBox);
    out.boxed.push({ ref, name: el.name, bbox });
    if (CLOSED_SHAPES.has(el.name) || OPEN_SHAPES.has(el.name)) {
      out.shapes.push({ ref, name: el.name, bbox, closed: CLOSED_SHAPES.has(el.name) });
    }
  }

  const child: Ctx = { matrix, fontSize, anchor, textX: ctx.textX, textY: ctx.textY };
  for (const c of el.children) {
    if (c.kind === "element") walk(c, child, out);
  }
}

/** The pre-transform bbox of a drawable shape, or null for non-shapes. */
function shapeLocalBbox(el: SvgElement): Bbox | null {
  switch (el.name) {
    case "rect":
      return {
        x: num(attr(el, "x")) ?? 0,
        y: num(attr(el, "y")) ?? 0,
        w: num(attr(el, "width")) ?? 0,
        h: num(attr(el, "height")) ?? 0,
      };
    case "circle": {
      const cx = num(attr(el, "cx")) ?? 0;
      const cy = num(attr(el, "cy")) ?? 0;
      const r = num(attr(el, "r")) ?? 0;
      return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    }
    case "ellipse": {
      const cx = num(attr(el, "cx")) ?? 0;
      const cy = num(attr(el, "cy")) ?? 0;
      const rx = num(attr(el, "rx")) ?? 0;
      const ry = num(attr(el, "ry")) ?? 0;
      return { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
    }
    case "line": {
      const x1 = num(attr(el, "x1")) ?? 0;
      const y1 = num(attr(el, "y1")) ?? 0;
      const x2 = num(attr(el, "x2")) ?? 0;
      const y2 = num(attr(el, "y2")) ?? 0;
      return bboxOfPoints([[x1, y1], [x2, y2]]);
    }
    case "polyline":
    case "polygon": {
      const pts = parsePoints(attr(el, "points") ?? "");
      return pts.length ? bboxOfPoints(pts) : null;
    }
    case "path": {
      const pts = pathPoints(attr(el, "d") ?? "");
      return pts.length ? bboxOfPoints(pts) : null;
    }
    default:
      return null;
  }
}

/** Concatenated immediate text-node children (tspans handled separately). */
function directTextOf(el: SvgElement): string {
  let s = "";
  for (const c of el.children as SvgNode[]) {
    if (c.kind === "text") s += c.value;
  }
  return s.replace(/\s+/g, " ").trim();
}

function attr(el: SvgElement, name: string): string | undefined {
  for (const a of el.attributes) if (a.name === name) return a.value;
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** A stable reference: `#id` when present, else the AST path. */
function refOf(el: SvgElement): string {
  const id = attr(el, "id");
  return id !== undefined ? `#${id}` : el.path;
}
