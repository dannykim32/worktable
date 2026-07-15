// Legibility Gate — the geometry model (issue 11). Pure math over the
// sanitizer's AST: text bbox estimation, shape geometry, and 2-D affine
// transforms. Security-adjacent, so — like the sanitizer — this module takes
// ZERO runtime dependencies, imports only the sanitizer's AST *types*, and
// touches no DOM. All numbers live in the SVG user space (the viewBox frame).
//
// The bbox heuristics are deliberately approximate; the exact contract is
// documented next to each estimator. The gate is report-only in this
// milestone, so approximation is a feature — findings are advisory until a
// human calibrates them (ADR-0007).

/** An axis-aligned box in user space. */
export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2-D affine transform as SVG's own 6-tuple [a b c d e f], where
 *  x' = a·x + c·y + e and y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two transforms (parent then child), matching SVG semantics:
 *  a point is transformed by `child` first, then `parent`. */
export function multiply(p: Matrix, c: Matrix): Matrix {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The uniform scale a transform applies to lengths, taken as the square root
 *  of the absolute determinant (area scale). Used only for legibility, where
 *  a single representative scale is what "rendered font size" needs. */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

const DEG = Math.PI / 180;

/** Build the matrix for one transform function. The sanitizer has already
 *  validated the name and numeric arity, so this only has to interpret. */
function functionMatrix(name: string, args: number[]): Matrix {
  switch (name) {
    case "translate":
      return [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    case "scale": {
      const sx = args[0]!;
      return [sx, 0, 0, args[1] ?? sx, 0, 0];
    }
    case "rotate": {
      const a = args[0]! * DEG;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      if (args.length === 3) {
        const cx = args[1]!;
        const cy = args[2]!;
        return multiply(
          multiply([1, 0, 0, 1, cx, cy], rot),
          [1, 0, 0, 1, -cx, -cy],
        );
      }
      return rot;
    }
    case "matrix":
      return [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
    default:
      return IDENTITY;
  }
}

/** Parse an SVG `transform` value (already sanitizer-validated) into a single
 *  composed matrix. An unparseable value degrades to identity — never throws. */
export function parseTransform(value: string): Matrix {
  let m = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const args = match[2]!
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s !== "")
      .map(Number)
      .filter((n) => Number.isFinite(n));
    m = multiply(m, functionMatrix(match[1]!, args));
  }
  return m;
}

/** The axis-aligned bounding box of a box after a transform: transform the
 *  four corners, then take their AABB. Correct for translate/scale and a safe
 *  over-approximation for rotation. */
export function transformBbox(m: Matrix, b: Bbox): Bbox {
  const corners: Array<[number, number]> = [
    applyToPoint(m, b.x, b.y),
    applyToPoint(m, b.x + b.w, b.y),
    applyToPoint(m, b.x, b.y + b.h),
    applyToPoint(m, b.x + b.w, b.y + b.h),
  ];
  return bboxOfPoints(corners);
}

export function bboxOfPoints(points: Array<[number, number]>): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function area(b: Bbox): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

/** The overlap rectangle of two boxes, or null when they do not overlap. */
export function intersect(a: Bbox, b: Bbox): Bbox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/** Round a box to a tenth of a pixel — the coordinates are approximate, so
 *  emitting them to full float precision would falsely imply exactness. */
export function roundBbox(b: Bbox): Bbox {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}

// ── Text bbox estimation ────────────────────────────────────────────────────
//
// The v1 contract (issue 11), a monospace-ish upper bound:
//   width  = charCount · fontSize · 0.6
//   height = fontSize · 1.2
// The <text>/<tspan> (x, y) is the BASELINE anchor. Vertically we split the
// line box as ascent = fontSize above the baseline and descent = 0.2·fontSize
// below it (sum = 1.2·fontSize = height). Horizontally the box is placed by
// text-anchor: start → x is the left edge, middle → x is the centre, end → x
// is the right edge.

export const TEXT_WIDTH_PER_EM = 0.6;
export const TEXT_LINE_HEIGHT = 1.2;

export function textLocalBbox(
  charCount: number,
  fontSize: number,
  x: number,
  y: number,
  anchor: string,
): Bbox {
  const w = charCount * fontSize * TEXT_WIDTH_PER_EM;
  const h = fontSize * TEXT_LINE_HEIGHT;
  const left =
    anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  const top = y - fontSize; // ascent = one em above the baseline
  return { x: left, y: top, w, h };
}

// ── Shape geometry ──────────────────────────────────────────────────────────

/** Parse a coordinate list ("x1,y1 x2 y2 …") into [x,y] pairs. */
export function parsePoints(value: string): Array<[number, number]> {
  const nums = value
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s !== "")
    .map(Number);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pairs.push([nums[i]!, nums[i + 1]!]);
  }
  return pairs;
}

/** Collect the anchor + control points a path `d` visits, in absolute
 *  coordinates, tracking the pen for relative commands. Curves are bounded by
 *  their control polygon — an over-approximation, which is the safe side for a
 *  clip check. Good enough for advisory geometry; documented as approximate. */
export function pathPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return [];
  const argCount: Record<string, number> = {
    m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
  };
  const points: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  let cmd = "";
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (/[a-zA-Z]/.test(tok)) {
      cmd = tok;
      i++;
      if (cmd === "z" || cmd === "Z") {
        cx = startX;
        cy = startY;
        continue;
      }
    }
    const lower = cmd.toLowerCase();
    const n = argCount[lower];
    if (n === undefined) break; // unknown command — stop rather than guess
    const rel = cmd === lower;
    const args: number[] = [];
    for (let k = 0; k < n && i < tokens.length; k++) {
      args.push(Number(tokens[i++]!));
    }
    if (args.length < n) break;
    if (lower === "h") {
      cx = rel ? cx + args[0]! : args[0]!;
    } else if (lower === "v") {
      cy = rel ? cy + args[0]! : args[0]!;
    } else if (lower === "a") {
      cx = rel ? cx + args[5]! : args[5]!;
      cy = rel ? cy + args[6]! : args[6]!;
    } else {
      // m/l/c/s/q/t: record every (x,y) pair, ending on the last one.
      for (let k = 0; k + 1 < args.length; k += 2) {
        const px = rel ? cx + args[k]! : args[k]!;
        const py = rel ? cy + args[k + 1]! : args[k + 1]!;
        points.push([px, py]);
        if (k + 2 >= args.length) {
          cx = px;
          cy = py;
        }
      }
    }
    if (lower === "h" || lower === "v" || lower === "a") points.push([cx, cy]);
    if (lower === "m") {
      startX = cx;
      startY = cy;
      cmd = rel ? "l" : "L"; // subsequent pairs after M are implicit L
    }
  }
  return points;
}
