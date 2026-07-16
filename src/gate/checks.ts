// The four Legibility Gate checks (issue 11). Each is pure geometry over the
// collected text runs and shapes, and each emits coordinate-bearing findings
// precise enough to hand straight back to a model for repair (issue 12):
//   { check, elements, bbox, message }.
//
// CONTEXT.md: the gate judges READABILITY only, never truth. These checks
// therefore look at overlap/straddle/clipping/size — never at meaning.
import { area, type Bbox, intersect, roundBbox } from "./geometry.js";

/** How far a point sits OUTSIDE a box, as a Chebyshev distance: 0 when the
 *  point is inside (or on an edge), otherwise the larger of the two axis gaps
 *  by which it overshoots the box. Used to find the shape a label belongs to —
 *  a label whose center is well outside every box is an on-arrow edge-label,
 *  not a straddle (issue 17). */
function centerGap(cx: number, cy: number, s: Bbox): number {
  const dx = Math.max(s.x - cx, cx - (s.x + s.w), 0);
  const dy = Math.max(s.y - cy, cy - (s.y + s.h), 0);
  return Math.max(dx, dy);
}

export type CheckName =
  | "text-overlap"
  | "edge-straddle"
  | "clipped"
  | "sub-legible";

export interface Finding {
  check: CheckName;
  /** Element references (`#id` when the element has one, else its AST path). */
  elements: string[];
  /** The coordinate-bearing region of the problem, in SVG user space. */
  bbox: Bbox;
  message: string;
}

/** A laid-out piece of text — one <text> run or one <tspan> run. */
export interface TextRun {
  ref: string;
  text: string;
  /** AABB in user space (post-transform), at the generous 0.6-em width. This is
   *  the box the overlap and clip checks read, and the one reported in findings. */
  bbox: Bbox;
  /** A NARROWER AABB (lower-bound em width, STRADDLE_WIDTH_PER_EM) used ONLY by
   *  the edge-straddle poke test, so a label whose real render fits its box is
   *  not judged a straddle by the 0.6 over-estimate (issue 18). Same anchor and
   *  height as `bbox`; only the width differs. Optional: when absent (e.g. a
   *  hand-built run in a unit test) the poke falls back to `bbox`. */
  straddleBbox?: Bbox;
  /** Font size in user space, AFTER transform scale only. This is NOT the
   *  on-screen pixel size: the viewBox→viewport display scale is applied later,
   *  by the sub-legible check, which alone knows the render width. */
  transformedFontSize: number;
}

/** A drawable shape with its user-space AABB. `closed` shapes (rect, polygon,
 *  circle, ellipse) can contain a label; open ones (line, polyline, path) only
 *  participate in the clip check. */
export interface Shape {
  ref: string;
  name: string;
  bbox: Bbox;
  closed: boolean;
}

/** Overlap as a fraction of the SMALLER box beyond which two labels are judged
 *  to collide (issue 11: >15%). */
export const OVERLAP_FRACTION = 0.15;
/** How far a label may poke past a shape edge before it counts as straddling
 *  rather than as rounding noise (issue 11: 2px). */
export const STRADDLE_TOLERANCE = 2;
/** Slack on the viewBox so a shape flush with the frame is not "clipped". */
export const CLIP_TOLERANCE = 1;
/** Rendered font sizes below this are sub-legible (issue 11: <9). */
export const MIN_LEGIBLE_FONT = 9;

/** The pixel width the canvas renders every free-form SVG to. Derived from
 *  src/canvas/styles.css: `.artifact` max-width 880 − 2×22 `.body` horizontal
 *  padding ≈ 836 (the 1px border-box borders make the true content box ~834; the
 *  2px difference is far below a 9px heuristic and errs conservative, so we keep
 *  836). `.svg-holder img` is `max-width:100%`, so the SVG fills that content box.
 *  This is the ONE place the layout width is encoded — if the
 *  card layout in styles.css changes, update this constant to match (issue 16).
 *
 *  Why a constant and not a measurement: the gate runs at publish time on the
 *  server, with no client viewport to read. A fixed content width is the v1
 *  contract (issue 16, Out of Scope: no dynamic width). */
export const CANVAS_CONTENT_WIDTH = 836;

/** The viewBox→viewport display scale the canvas applies: it renders a
 *  `vbW`-wide viewBox into CANVAS_CONTENT_WIDTH px, so lengths (and font sizes)
 *  are multiplied by CANVAS_CONTENT_WIDTH / vbW on screen.
 *
 *  A missing viewBox width (`null`), or a degenerate one (zero, negative, or
 *  non-finite), gives no reliable scale — there is nothing to divide into. In
 *  that case we fall back to displayScale = 1 (judge the user-space size as-is)
 *  rather than throw or divide by zero. This is the honest degenerate contract
 *  from issue 16: never a divide-by-zero, never a scale-driven false positive. */
export function displayScaleFor(viewBoxWidth: number | null): number {
  if (
    viewBoxWidth === null ||
    !Number.isFinite(viewBoxWidth) ||
    viewBoxWidth <= 0
  ) {
    return 1;
  }
  return CANVAS_CONTENT_WIDTH / viewBoxWidth;
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** text-overlap: two text bboxes intersect by >15% of the smaller's area. */
export function checkTextOverlap(runs: TextRun[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]!;
      const b = runs[j]!;
      const smaller = Math.min(area(a.bbox), area(b.bbox));
      if (smaller <= 0) continue;
      const overlap = intersect(a.bbox, b.bbox);
      if (!overlap) continue;
      const fraction = area(overlap) / smaller;
      if (fraction <= OVERLAP_FRACTION) continue;
      findings.push({
        check: "text-overlap",
        elements: [a.ref, b.ref],
        bbox: roundBbox(overlap),
        message:
          `text "${clip(a.text)}" and "${clip(b.text)}" overlap by ` +
          `${Math.round(fraction * 100)}% of the smaller label — they will ` +
          "render on top of each other",
      });
    }
  }
  return findings;
}

/** edge-straddle: a label sits half-inside / half-outside the box it labels.
 *
 *  A straddle is judged against ONE shape — the box the label BELONGS TO — not
 *  every rect its bounding box grazes (calibration round 3: that over-fired,
 *  0% precision, and double-counted one label against multiple containers). The
 *  owning shape is the nearest closed shape whose interior the text's center
 *  sits in (or within STRADDLE_TOLERANCE of an edge, so a label centred right on
 *  the boundary still counts); ties break to the smaller, innermost box.
 *
 *  A text whose center is outside EVERY shape is an on-arrow edge-label sitting
 *  on a connector between boxes — its bbox may clip a distant container's edge,
 *  but that is not a straddle, so it is excluded. Each run yields at most one
 *  finding (issue 17).
 *
 *  The poke test uses the run's NARROWER `straddleBbox` (a lower-bound width),
 *  not its 0.6-em `bbox`: the generous width over-estimates and manufactured a
 *  straddle for a label that really fit its box (calibration round 4, issue 18).
 *  Ownership still keys off the (wider) `bbox` center — unchanged from issue 17 —
 *  and the reported finding bbox stays the `bbox`; only the poke geometry narrows. */
export function checkEdgeStraddle(runs: TextRun[], shapes: Shape[]): Finding[] {
  const findings: Finding[] = [];
  for (const run of runs) {
    const r = run.bbox;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;

    // The box this label belongs to: nearest closed shape the center is in/on,
    // tie-broken to the innermost (smallest-area) one. A center outside all
    // shapes means an on-arrow edge-label — leaves owner null, so we skip it.
    let owner: Shape | null = null;
    let ownerGap = Infinity;
    let ownerArea = Infinity;
    for (const shape of shapes) {
      if (!shape.closed) continue;
      const gap = centerGap(cx, cy, shape.bbox);
      if (gap > STRADDLE_TOLERANCE) continue; // center not on/in this box
      const a = area(shape.bbox);
      if (gap < ownerGap || (gap === ownerGap && a < ownerArea)) {
        owner = shape;
        ownerGap = gap;
        ownerArea = a;
      }
    }
    if (!owner) continue; // on-arrow edge-label — belongs to no box, not a straddle

    // Measure the poke against the CONSERVATIVE box (lower-bound width), so a
    // label whose real render fits is not flagged by the 0.6 over-estimate
    // (issue 18). Same anchor/height as `bbox`; only the width is narrower.
    const s = owner.bbox;
    const p = run.straddleBbox ?? run.bbox;
    const pokeLeft = s.x - p.x;
    const pokeRight = p.x + p.w - (s.x + s.w);
    const pokeTop = s.y - p.y;
    const pokeBottom = p.y + p.h - (s.y + s.h);
    const worstPoke = Math.max(pokeLeft, pokeRight, pokeTop, pokeBottom);
    if (worstPoke <= STRADDLE_TOLERANCE) continue; // fits its box (conservative) — fine

    findings.push({
      check: "edge-straddle",
      elements: [run.ref, owner.ref],
      bbox: roundBbox(run.bbox),
      message:
        `text "${clip(run.text)}" crosses the edge of <${owner.name}> ` +
        `${owner.ref} (extends ${fmt(worstPoke)}px past it) — it sits half ` +
        "on, half off the shape",
    });
  }
  return findings;
}

/** clipped: any element's bbox extends past the viewBox frame. */
export function checkClipped(
  elements: Array<{ ref: string; name: string; bbox: Bbox }>,
  viewBox: Bbox | null,
): Finding[] {
  if (!viewBox) return [];
  const findings: Finding[] = [];
  const vRight = viewBox.x + viewBox.w;
  const vBottom = viewBox.y + viewBox.h;
  for (const el of elements) {
    const b = el.bbox;
    const over = Math.max(
      viewBox.x - b.x,
      viewBox.y - b.y,
      b.x + b.w - vRight,
      b.y + b.h - vBottom,
    );
    if (over <= CLIP_TOLERANCE) continue;
    findings.push({
      check: "clipped",
      elements: [el.ref],
      bbox: roundBbox(b),
      message:
        `<${el.name}> ${el.ref} extends ${fmt(over)}px beyond the viewBox ` +
        `(${fmt(viewBox.x)} ${fmt(viewBox.y)} ${fmt(viewBox.w)} ` +
        `${fmt(viewBox.h)}) — part of it will be cut off`,
    });
  }
  return findings;
}

/** sub-legible: the ON-SCREEN font size — user-space size after the transform
 *  scale, then times the viewBox→viewport display scale — is below the floor.
 *  Judging the display-scaled size (not the raw user-space size) is the issue-16
 *  fix: a 6px font inside a 400-wide viewBox renders at ~12.5px and is legible,
 *  while a 6px font inside a 1600-wide viewBox renders at ~3px and is not.
 *
 *  `viewBoxWidth` is the root viewBox width (null when the SVG declares none);
 *  displayScaleFor handles the degenerate cases (see there). */
export function checkSubLegible(
  runs: TextRun[],
  viewBoxWidth: number | null,
): Finding[] {
  const displayScale = displayScaleFor(viewBoxWidth);
  const findings: Finding[] = [];
  for (const run of runs) {
    const renderedPx = run.transformedFontSize * displayScale;
    if (renderedPx >= MIN_LEGIBLE_FONT) continue;
    findings.push({
      check: "sub-legible",
      elements: [run.ref],
      bbox: roundBbox(run.bbox),
      message:
        `text "${clip(run.text)}" renders at ~${fmt(renderedPx)}px ` +
        `(display scale ${fmt(displayScale)}×) — below the ` +
        `${MIN_LEGIBLE_FONT}px legibility floor`,
    });
  }
  return findings;
}

function clip(s: string, max = 40): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
