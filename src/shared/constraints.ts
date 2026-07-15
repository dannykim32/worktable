// Shared boundary constraints — single source of truth for shapes and
// limits that both the Canvas Server and the canvas page enforce.

/** Artifact ids are "a_" + 8 hex chars, for their whole lifetime. */
export const ARTIFACT_ID_PATTERN = /^a_[0-9a-f]{8}$/;

/** An Anchor's quote is clamped to this many chars (survives content drift). */
export const QUOTE_MAX = 300;

/** Ask-back questions longer than this are rejected with a 400. */
export const QUESTION_MAX = 2000;

export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}
