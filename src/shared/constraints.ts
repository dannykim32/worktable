// Shared boundary constraints — single source of truth for shapes and
// limits that both the Canvas Server and the canvas page enforce.

/** Artifact ids are "a_" + 8 hex chars, for their whole lifetime. */
export const ARTIFACT_ID_PATTERN = /^a_[0-9a-f]{8}$/;

/** An Anchor's quote is clamped to this many chars (survives content drift). */
export const QUOTE_MAX = 300;

/** Ask-back questions longer than this are rejected with a 400. */
export const QUESTION_MAX = 2000;

/** An agent's answer_askback answer longer than this is rejected (issue 22). */
export const ANSWER_MAX = 4000;

/** Clickable external references: an `openlink` href longer than this is
 *  dropped — by the frame prelude (convenience) AND by the parent bridge (the
 *  boundary). Matches the classic practical URL ceiling. */
export const HREF_MAX = 2048;

/** Free-form HTML hatch (issue 25): the model's HTML document is capped at this
 *  many UTF-8 bytes. Served verbatim into a sandboxed, origin-split, CSP-locked
 *  iframe — NEVER sanitized into the host DOM (ADR-0002 exception, issue 15). */
export const HTML_MAX = 256 * 1024;

/** A 128-bit frame slug is 16 random bytes as lowercase hex (issue 25). It gates
 *  the token-free frame routes; it is NOT the 8-hex display id. */
export const FRAME_SLUG_PATTERN = /^[0-9a-f]{32}$/;

export function isFrameSlug(value: unknown): value is string {
  return typeof value === "string" && FRAME_SLUG_PATTERN.test(value);
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}

/** A pasted ask-back image is capped at this many bytes (enforced BEFORE
 *  anything is stored — the upload route 413s an oversize body). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The only image types an ask-back may carry. Membership is decided by
 *  magic-byte sniffing (askbackImages.ts), never a client-declared header. */
export const IMAGE_MIME_ALLOWED: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Ask-back image ids are 16 random bytes as lowercase hex (128-bit, minted by
 *  the ImageStore). Regex-gated on EVERY read — no path traversal. */
export const IMAGE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isImageId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ID_PATTERN.test(value);
}
