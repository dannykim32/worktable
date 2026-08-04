// Shared Artifact vocabulary (types only — the canvas imports these with
// `import type`, so nothing here survives into the built bundle).

export interface HeadingBlock {
  kind: "heading";
  level: 1 | 2 | 3;
  text: string;
}

export interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}

export interface CalloutBlock {
  kind: "callout";
  tone: "info" | "warn";
  text: string;
}

export interface CodeBlock {
  kind: "code";
  lang?: string;
  text: string;
}

export interface TableBlock {
  kind: "table";
  header: string[];
  rows: string[][];
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: string[];
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | CalloutBlock
  | CodeBlock
  | TableBlock
  | ListBlock;

export interface DocumentContent {
  type: "document";
  title: string;
  blocks: DocumentBlock[];
}

// ── Dashboard component (issue 07, ADR-0007) ────────────────────────────

export interface TileDelta {
  text: string;
  tone: "good" | "bad" | "neutral";
}

export interface DashboardTile {
  label: string;
  value: string | number;
  delta?: TileDelta;
}

export interface ChartPoint {
  x: string | number;
  y: number;
}

export interface ChartSeries {
  label: string;
  points: ChartPoint[];
}

export interface DashboardChart {
  kind: "bar" | "line";
  title: string;
  unit?: string;
  /** ≤4 series, categorical palette slots assigned in fixed order. */
  series: ChartSeries[];
}

export interface DashboardContent {
  type: "dashboard";
  title: string;
  /** 0..8 stat tiles. */
  tiles: DashboardTile[];
  /** 0..4 charts, each with exactly ONE y-axis (none other exists). */
  charts: DashboardChart[];
}

// ── Compare component (issue 08, ADR-0007) ──────────────────────────────

export interface CompareLine {
  text: string;
  /** Supplied by the agent — the canvas never computes diffs. */
  mark: "add" | "del" | null;
}

export interface ComparePane {
  label: string;
  /** ≤500 lines. */
  lines: CompareLine[];
}

export interface CompareContent {
  type: "compare";
  title: string;
  /** Exactly 2 panes. */
  panes: ComparePane[];
}

/** Honest Absence: a first-class outcome, never an error (CONTEXT.md). */
export interface AbsenceContent {
  type: "absence";
  title: string;
  reason: string;
}

/** Free-form SVG (ADR-0002): the only agent-authored markup in v1. `svg`
 *  holds the SANITIZED, re-serialized output of the SVG sanitizer (issue 09)
 *  — never the raw input, which is discarded on publish. Rendered only under
 *  Image Isolation, as a data:image/svg+xml URL in an <img> (issue 10). */
export interface SvgContent {
  type: "svg";
  title: string;
  svg: string;
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

export type ArtifactContent =
  | DocumentContent
  | DashboardContent
  | CompareContent
  | AbsenceContent
  | SvgContent
  | ProseContent
  | HtmlContent;
export type ArtifactType = ArtifactContent["type"];

// ── HTML hatch bridge (issue 25) ────────────────────────────────────────
// The ONLY messages that cross the frame→parent MessageChannel bridge. A
// closed, schema-validated verb set; the capability token NEVER crosses it
// (ADR-0010: the ask-back queue stays the single browser→agent write door —
// the parent re-POSTs a validated ask-back through it, host-side).

/** Frame asks the parent to open an ask-back for a selection inside the frame. */
export interface AskbackVerb {
  v: "askback";
  quote: string;
  question: string;
}

/** Frame asks the parent to resize its iframe to fit content height. */
export interface ResizeVerb {
  v: "resize";
  px: number;
}

export type FrameVerb = AskbackVerb | ResizeVerb;

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
