// SVG sanitizer — the single last boundary before the browser (issue 09).
// Doctrine carried intact from the prior project:
//   · allowlist a strict subset; everything unknown fails the WHOLE artifact
//     (reject-not-drop: a silently-stripped artifact can tell an untrue story)
//   · re-serialize from the AST — input bytes never pass through to output
//   · char-allowlist every attribute value
//   · hard caps first; exceeding one is a violation, never a truncation
// This module is hand-audited: zero runtime dependencies, zero imports from
// outside this directory, readable over clever.
import type { SanitizeResult } from "./ast.js";
import { validateTree } from "./allowlist.js";
import { parseSvg, SVG_INPUT_MAX_BYTES } from "./parse.js";
import { writeSvg } from "./write.js";

export type {
  SanitizeResult,
  SvgAttribute,
  SvgElement,
  SvgNode,
  SvgText,
  Violation,
} from "./ast.js";
export {
  SVG_ATTR_VALUE_MAX,
  SVG_DEPTH_MAX,
  SVG_ELEMENT_MAX,
  SVG_INPUT_MAX_BYTES,
} from "./parse.js";
export { SVG_XMLNS } from "./allowlist.js";

/** UTF-8 byte length without Buffer/TextEncoder — this module imports and
 *  assumes nothing beyond the language. Lone surrogates count as the 3 bytes
 *  their replacement character would occupy. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * Sanitize agent-authored SVG. Either every check passes and the result is
 * our own canonical re-serialization, or the whole input is rejected with
 * violations precise enough (code + path + line detail) for a model to fix.
 */
export function sanitizeSvg(input: string): SanitizeResult {
  // Cap gate FIRST: an oversized input is rejected before any parsing.
  const bytes = utf8ByteLength(input);
  if (bytes > SVG_INPUT_MAX_BYTES) {
    return {
      ok: false,
      violations: [
        {
          code: "input-too-large",
          path: "/",
          detail: `input is ${bytes} bytes; the cap is ${SVG_INPUT_MAX_BYTES} (256KB)`,
        },
      ],
    };
  }

  const { root, violations } = parseSvg(input);
  if (root !== null) violations.push(...validateTree(root));
  if (root === null || violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, svg: writeSvg(root), root };
}
