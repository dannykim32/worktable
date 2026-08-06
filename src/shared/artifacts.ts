// Shared Artifact vocabulary (types only — the canvas imports these with
// `import type`, so nothing here survives into the built bundle).
//
// The surface is exactly {html, prose, absence} (issue 26): the html hatch
// (issue 25), prose (issue 24), and Honest Absence. The structured components
// (document/dashboard/compare) and the free-form svg type were retired.

/** Honest Absence: a first-class outcome, never an error (CONTEXT.md). */
export interface AbsenceContent {
  type: "absence";
  title: string;
  reason: string;
}

/** Prose/markdown (issue 24, ADR-0002 trusted lane): the agent's long-form
 *  answer sent as MARKDOWN. It is untrusted model text, but rendered by our
 *  OWN markdown→DOM renderer using createElement/textContent ONLY — never
 *  innerHTML, never raw-HTML passthrough. It opens no HTML hole; it is NOT the
 *  free-form HTML hatch. Stored verbatim; parsed only at render time. */
export interface ProseContent {
  type: "prose";
  title: string;
  markdown: string;
}

/** Free-form HTML hatch (issue 25, ADR-0002 exception): agent-authored HTML
 *  served VERBATIM into a sandboxed, origin-split, CSP-locked iframe from a
 *  SECOND 127.0.0.1 port — never sanitized into the host DOM (issue 15). The
 *  `html` body is the model input; it is stored verbatim and travels ONLY to
 *  the frame-serving origin, never to the parent canvas JS. `frameSlug` is set
 *  ONLY on the parent-canvas API response (a fresh 128-bit slug per version)
 *  and is NEVER accepted from the model. */
export interface HtmlContent {
  type: "html";
  title: string;
  /** Model-authored HTML (≤256KB). Present in storage + on the model-input
   *  path; OMITTED from the parent-canvas API response. */
  html?: string;
  /** 128-bit frame slug for this version; present ONLY on the client-facing
   *  API response, so the canvas can build the iframe src. */
  frameSlug?: string;
}

export type ArtifactContent = AbsenceContent | ProseContent | HtmlContent;
export type ArtifactType = ArtifactContent["type"];

// ── HTML hatch bridge (issue 25 + issue 27) ─────────────────────────────
// The ONLY messages that cross the frame↔parent MessageChannel bridge. A
// closed, schema-validated verb set; the capability token NEVER crosses it
// (ADR-0010: the ask-back queue stays the single browser→agent write door —
// the parent re-POSTs a validated ask-back through it, host-side).

// ── Frame → parent ──────────────────────────────────────────────────────

/** Frame asks the parent to resize its iframe to fit content height. */
export interface ResizeVerb {
  v: "resize";
  px: number;
}

/** Issue 27: the human clicked "Ask about this" INSIDE the frame. The frame
 *  assigns a `markerId` (its own counter) and stashes the selection Range under
 *  it, then asks the parent to open the drawer composer pre-filled with `quote`.
 *  The composer + the whole conversation now live in the PARENT drawer — this
 *  verb replaces the old in-frame composer's `askback{quote,question}`. The
 *  question is typed in the parent and POSTed host-side through /api/askbacks. */
export interface AskStartVerb {
  v: "askstart";
  quote: string;
  markerId: string;
}

/** Issue 27: the human clicked an in-frame marker. The frame asks the parent to
 *  highlight the matching drawer entry (marker → drawer locate). */
export interface FocusEntryVerb {
  v: "focusEntry";
  markerId: string;
}

/** Every verb the parent accepts from the frame over the private port. */
export type FrameToParentVerb = ResizeVerb | AskStartVerb | FocusEntryVerb;

// ── Parent → frame ──────────────────────────────────────────────────────

/** Issue 27: parent asks the frame to draw (if not yet drawn), scroll to, and
 *  highlight the marker for `markerId` (drawer → marker locate; also the submit
 *  confirmation that persists the marker for an asked question). */
export interface FocusMarkerVerb {
  v: "focusMarker";
  markerId: string;
}

/** Every verb the frame accepts from the parent over the private port. The
 *  one-time `{v:"port"}` transfer travels the window channel, not the port. */
export type ParentToFrameVerb = FocusMarkerVerb;

/** @deprecated kept as an alias so external references don't break. */
export type FrameVerb = FrameToParentVerb;

export interface ArtifactMeta {
  id: string;
  type: ArtifactType;
  title: string;
  /** Latest Version number; every prior Version is retained (ADR-0006). */
  latest: number;
  created_at: string;
  updated_at: string;
}

/** SSE payload for `event: artifact` on publish/update. */
export interface ArtifactEvent {
  artifact_id: string;
  version: number;
  type: ArtifactType;
}

/** An Anchor: artifact + Version + region/span the human selected. */
export interface Anchor {
  artifact_id: string;
  version: number;
  /** Document block index; null for a whole-artifact ask. */
  block_index: number | null;
  char_start?: number;
  char_end?: number;
  /** Always present — survives content drift. ≤300 chars. */
  quote: string;
}

/** "question" is an anchored ask-back; "approval" is a Review Moment approval
 *  (issue 14) — an empty-question ask-back that resolves a blocking
 *  request_review. Both travel the single ask-back channel (ADR-0010). */
export type AskbackKind = "question" | "approval";

/** The agent's answer to an ask-back (issue 22). Stored alongside the queue
 *  entry; it flows agent→browser via SSE and does NOT change delivered state. */
export interface AskbackAnswer {
  text: string;
  answered_at: string;
}

export interface Askback {
  id: string;
  anchor: Anchor;
  question: string;
  kind: AskbackKind;
  state: "pending" | "delivered";
  created_at: string;
  /** A pasted screenshot's ImageStore id (128-bit hex; single image per
   *  ask-back in v1). The bytes live in the store; check_askbacks delivers
   *  them to the model as an MCP image block, and the canvas refetches the
   *  thumbnail from GET /api/askbacks/image/:id. */
  image_id?: string;
  /** Present once the agent has answered it via answer_askback (issue 22). */
  answer?: AskbackAnswer;
}

/** SSE payload for `event: askback_answered` (issue 22). Carries only ids —
 *  the canvas fetches the answer text from GET /api/askbacks/answered. */
export interface AskbackAnsweredEvent {
  askback_id: string;
  artifact_id: string;
  version: number;
}
