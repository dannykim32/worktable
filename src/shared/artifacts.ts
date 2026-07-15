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

export type ArtifactContent =
  | DocumentContent
  | DashboardContent
  | CompareContent
  | AbsenceContent
  | SvgContent;
export type ArtifactType = ArtifactContent["type"];

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

export interface Askback {
  id: string;
  anchor: Anchor;
  question: string;
  state: "pending" | "delivered";
  created_at: string;
}
