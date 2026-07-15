// AST for the sanitized SVG subset (issue 09). Exported for downstream
// consumers — issue 11's Legibility Gate walks this tree. Part of the
// hand-audited sanitizer: zero imports, plain data only.

/** One parsed attribute; `value` is entity-decoded. */
export interface SvgAttribute {
  name: string;
  value: string;
  /** 1-based source line of the attribute (for violation details). */
  line: number;
}

export interface SvgElement {
  kind: "element";
  name: string;
  attributes: SvgAttribute[];
  children: SvgNode[];
  /** Element path, e.g. "/svg/g[0]/rect[2]" — indexes count element
   *  children only, 0-based within the parent. */
  path: string;
  /** 1-based source line of the start tag. */
  line: number;
}

export interface SvgText {
  kind: "text";
  /** Entity-decoded character data. */
  value: string;
  line: number;
}

export type SvgNode = SvgElement | SvgText;

/** One reject-not-drop violation — precise enough for a model to fix:
 *  a stable code, the element/attribute path, and a line-bearing detail. */
export interface Violation {
  code: string;
  path: string;
  detail: string;
}

export type SanitizeResult =
  | {
      ok: true;
      svg: string;
      /** The validated AST the canonical `svg` was written from. Exposed so
       *  the Legibility Gate (issue 11) can walk the SAME tree instead of
       *  reparsing — the sanitizer is the only SVG parser in the project. */
      root: SvgElement;
    }
  | { ok: false; violations: Violation[] };
