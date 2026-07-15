// The allowlists (issue 09): the exact expressive subset free-form SVG may
// use. Everything not listed is a violation — reject-not-drop, because a
// silently-stripped artifact can tell an untrue story. Values are
// char-allowlisted per attribute family; url(…) exists nowhere except the
// dedicated marker-reference form (same-document `url(#id)`, resolved and
// checked against ids that <marker> elements actually define).
import type { SvgElement, Violation } from "./ast.js";

export const SVG_XMLNS = "http://www.w3.org/2000/svg";

/** The element allowlist. Deliberately absent: foreignObject, use, image,
 *  style, script, animate*, filter, a, symbol, pattern, mask, clipPath. */
const ELEMENTS = new Set([
  "svg",
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "defs",
  "marker",
  "title",
  "desc",
]);

/** Elements whose text content is meaningful (and preserved verbatim by the
 *  writer). Everywhere else only inter-element whitespace may appear. */
export const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);

/** Shared geometry/paint attribute set, allowed on every element.
 *  Deliberately absent: style, class, href, xlink:href, and every on* form. */
const SHARED_ATTRIBUTES = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "d",
  "transform",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "marker-end",
  "marker-start",
  "id",
]);

/** Marker geometry, allowed on <marker> only (needed for arrowheads; all
 *  numeric or fixed keywords — no reference or script surface). */
const MARKER_ONLY_ATTRIBUTES = new Set([
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "orient",
]);

// ── Value families ─────────────────────────────────────────────────────────

const NUMBER_LIST = /^[0-9eE+\-., ]+$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., ]+$/;
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const FONT_FAMILY = /^[a-zA-Z0-9 ,-]+$/;
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR = /^rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\)$/;
const RGBA_COLOR =
  /^rgba\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*(?:[01](?:\.[0-9]+)?|\.[0-9]+)\s*\)$/;
/** The 16 basic HTML color names — the whole named-color surface. */
const COLOR_NAMES = new Set([
  "black",
  "silver",
  "gray",
  "white",
  "maroon",
  "red",
  "purple",
  "fuchsia",
  "green",
  "lime",
  "olive",
  "yellow",
  "navy",
  "blue",
  "teal",
  "aqua",
]);
/** Same-document marker reference. The ONLY url(…) form in the subset. */
const MARKER_REF = /^url\(#([a-zA-Z][a-zA-Z0-9_-]{0,63})\)$/;

interface ValueCheck {
  ok(value: string): boolean;
  expected: string;
}

const numberList: ValueCheck = {
  ok: (v) => NUMBER_LIST.test(v),
  expected: "a number or number list (chars 0-9 e E + - . , space)",
};

const pathData: ValueCheck = {
  ok: (v) => PATH_DATA.test(v),
  expected: "path data (chars MmLlHhVvCcSsQqTtAaZz 0-9 e E + - . , space)",
};

const paint: ValueCheck = {
  ok: (v) =>
    v === "none" ||
    HEX_COLOR.test(v) ||
    RGB_COLOR.test(v) ||
    RGBA_COLOR.test(v) ||
    COLOR_NAMES.has(v),
  expected:
    'none, #hex (3/6/8 digits), rgb()/rgba() with numeric args, or one of ' +
    "the 16 basic color names — url(…) is forbidden in paint",
};

const fontFamily: ValueCheck = {
  ok: (v) => FONT_FAMILY.test(v),
  expected: "font family names (chars a-z A-Z 0-9 space comma hyphen; no quotes)",
};

const idValue: ValueCheck = {
  ok: (v) => ID_PATTERN.test(v),
  expected: "an id matching [a-zA-Z][a-zA-Z0-9_-]{0,63}",
};

function keywords(allowed: string[]): ValueCheck {
  return {
    ok: (v) => allowed.includes(v),
    expected: `one of: ${allowed.join(", ")}`,
  };
}

const fontWeight: ValueCheck = {
  ok: (v) => v === "normal" || v === "bold" || /^[1-9]00$/.test(v),
  expected: "normal, bold, or 100–900",
};

const orient: ValueCheck = {
  ok: (v) => v === "auto" || v === "auto-start-reverse" || NUMBER.test(v),
  expected: "auto, auto-start-reverse, or an angle number",
};

const markerRef: ValueCheck = {
  ok: (v) => v === "none" || MARKER_REF.test(v),
  expected: 'none or a same-document reference url(#id)',
};

const xmlnsValue: ValueCheck = {
  ok: (v) => v === SVG_XMLNS,
  expected: `exactly "${SVG_XMLNS}"`,
};

/** translate/rotate/scale/matrix with numeric args and exact arg counts.
 *  skewX/skewY and any other function are rejected. */
const transform: ValueCheck = {
  ok: (value) => {
    let rest = value.trim();
    if (rest === "") return false;
    while (rest !== "") {
      const open = rest.indexOf("(");
      const close = rest.indexOf(")");
      if (open === -1 || close === -1 || close < open) return false;
      const fn = rest.slice(0, open).trim();
      const args = rest
        .slice(open + 1, close)
        .trim()
        .split(/[\s,]+/)
        .filter((a) => a !== "");
      if (!args.every((a) => NUMBER.test(a))) return false;
      const n = args.length;
      const okCount =
        fn === "translate" || fn === "scale"
          ? n === 1 || n === 2
          : fn === "rotate"
            ? n === 1 || n === 3
            : fn === "matrix"
              ? n === 6
              : false;
      if (!okCount) return false;
      rest = rest.slice(close + 1).trim();
      if (rest.startsWith(",")) rest = rest.slice(1).trim();
    }
    return true;
  },
  expected:
    "a list of translate()/rotate()/scale()/matrix() with numeric arguments",
};

const VALUE_CHECKS: Record<string, ValueCheck> = {
  x: numberList,
  y: numberList,
  x1: numberList,
  y1: numberList,
  x2: numberList,
  y2: numberList,
  cx: numberList,
  cy: numberList,
  r: numberList,
  rx: numberList,
  ry: numberList,
  width: numberList,
  height: numberList,
  points: numberList,
  viewBox: numberList,
  "stroke-width": numberList,
  "stroke-dasharray": numberList,
  opacity: numberList,
  "fill-opacity": numberList,
  "stroke-opacity": numberList,
  "font-size": numberList,
  refX: numberList,
  refY: numberList,
  markerWidth: numberList,
  markerHeight: numberList,
  d: pathData,
  transform,
  fill: paint,
  stroke: paint,
  "font-family": fontFamily,
  "font-weight": fontWeight,
  "font-style": keywords(["normal", "italic", "oblique"]),
  "stroke-linecap": keywords(["butt", "round", "square"]),
  "stroke-linejoin": keywords(["miter", "round", "bevel"]),
  "text-anchor": keywords(["start", "middle", "end"]),
  "dominant-baseline": keywords([
    "auto",
    "middle",
    "central",
    "hanging",
    "alphabetic",
    "ideographic",
    "mathematical",
    "text-top",
    "text-bottom",
  ]),
  id: idValue,
  "marker-start": markerRef,
  "marker-end": markerRef,
  orient,
  xmlns: xmlnsValue,
};

// ── Tree validation ────────────────────────────────────────────────────────

function clip(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function describeName(name: string): string {
  const shown = clip(name, 40);
  return /[^\x20-\x7e]/.test(name)
    ? `"${shown}" (contains non-ASCII characters — homoglyph?)`
    : `"${shown}"`;
}

/** Walk the parsed tree and collect every allowlist violation. */
export function validateTree(root: SvgElement): Violation[] {
  const violations: Violation[] = [];
  const seenIds = new Map<string, string>(); // id → defining element path
  const markerIds = new Set<string>();
  const markerRefs: Array<{ id: string; path: string; line: number }> = [];

  if (root.name !== "svg") {
    violations.push({
      code: "root-not-svg",
      path: root.path,
      detail: `line ${root.line}: root element must be <svg>, got ${describeName(root.name)}`,
    });
  }

  const walk = (el: SvgElement): void => {
    if (!ELEMENTS.has(el.name)) {
      violations.push({
        code: "element-not-allowed",
        path: el.path,
        detail:
          `line ${el.line}: element ${describeName(el.name)} is not in the ` +
          `allowlist (allowed: ${[...ELEMENTS].join(", ")})`,
      });
    }

    for (const attr of el.attributes) {
      const attrPath = `${el.path}/@${attr.name}`;
      if (/^on/i.test(attr.name)) {
        violations.push({
          code: "event-attribute",
          path: attrPath,
          detail:
            `line ${attr.line}: event handler attributes (on*) are ` +
            "forbidden — remove it entirely",
        });
        continue;
      }
      const allowed =
        SHARED_ATTRIBUTES.has(attr.name) ||
        (el.name === "marker" && MARKER_ONLY_ATTRIBUTES.has(attr.name)) ||
        (el.name === "svg" && attr.name === "xmlns");
      if (!allowed) {
        const hint =
          attr.name === "style"
            ? " — use presentation attributes (fill, stroke, …) instead"
            : attr.name === "href" || attr.name === "xlink:href"
              ? " — references are forbidden in this subset"
              : MARKER_ONLY_ATTRIBUTES.has(attr.name)
                ? " — allowed on <marker> only"
                : "";
        violations.push({
          code: "attribute-not-allowed",
          path: attrPath,
          detail:
            `line ${attr.line}: attribute ${describeName(attr.name)} is not ` +
            `allowed on <${el.name}>${hint}`,
        });
        continue;
      }
      const check = VALUE_CHECKS[attr.name];
      if (check && !check.ok(attr.value)) {
        violations.push({
          code: "attribute-value-rejected",
          path: attrPath,
          detail:
            `line ${attr.line}: value "${clip(attr.value)}" rejected — ` +
            `expected ${check.expected}`,
        });
        continue;
      }
      if (attr.name === "id") {
        const existing = seenIds.get(attr.value);
        if (existing !== undefined) {
          violations.push({
            code: "duplicate-id",
            path: attrPath,
            detail:
              `line ${attr.line}: id "${clip(attr.value)}" is already ` +
              `defined at ${existing}`,
          });
        } else {
          seenIds.set(attr.value, el.path);
          if (el.name === "marker") markerIds.add(attr.value);
        }
      }
      if (attr.name === "marker-start" || attr.name === "marker-end") {
        const ref = MARKER_REF.exec(attr.value);
        if (ref) markerRefs.push({ id: ref[1]!, path: attrPath, line: attr.line });
      }
    }

    for (const child of el.children) {
      if (child.kind === "text") {
        if (child.value.trim() !== "" && !TEXT_ELEMENTS.has(el.name)) {
          violations.push({
            code: "text-not-allowed",
            path: el.path,
            detail:
              `line ${child.line}: text content ("${clip(child.value.trim())}") ` +
              `is only allowed inside <text>, <tspan>, <title>, <desc> — not <${el.name}>`,
          });
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);

  // Marker references must resolve to an id a <marker> element defines —
  // dangling references would render differently than the author intended.
  for (const ref of markerRefs) {
    if (!markerIds.has(ref.id)) {
      violations.push({
        code: "marker-ref-unresolved",
        path: ref.path,
        detail:
          `line ${ref.line}: url(#${ref.id}) does not reference the id of a ` +
          "<marker> element in this document",
      });
    }
  }

  return violations;
}
