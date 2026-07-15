// Schema validation at the MCP boundary IS the safety mechanism (ADR-0003).
// Reject-not-drop applies to structure: unknown kinds/fields fail the whole
// call with the offending JSON path — nothing is silently discarded.
import type {
  ArtifactContent,
  ChartSeries,
  ComparePane,
  DashboardChart,
  DashboardTile,
  DocumentBlock,
} from "../shared/artifacts.js";
import { ARTIFACT_ID_PATTERN, isArtifactId } from "../shared/constraints.js";

export class ValidationError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`invalid input at ${path}: ${detail}`);
  }
}

const TITLE_MAX = 200;
const BLOCKS_MAX = 200;
const REASON_MAX = 2000;
// Dashboard (issue 07): the schema forbids a legend explosion and a second
// y-axis by construction — there is nowhere to put either.
const TILES_MAX = 8;
const CHARTS_MAX = 4;
const SERIES_MAX = 4;
// Compare (issue 08): exactly two panes, agent-supplied marks.
const PANES_EXACT = 2;
const PANE_LINES_MAX = 500;

// ---------------------------------------------------------------------------
// JSON Schemas, declared on the MCP tools so hosts see the exact contract.
// ---------------------------------------------------------------------------

const blockSchemas = [
  {
    type: "object",
    properties: {
      kind: { const: "heading" },
      level: { enum: [1, 2, 3] },
      text: { type: "string" },
    },
    required: ["kind", "level", "text"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      kind: { const: "paragraph" },
      text: { type: "string", description: "plain text, no markup" },
    },
    required: ["kind", "text"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      kind: { const: "callout" },
      tone: { enum: ["info", "warn"] },
      text: { type: "string" },
    },
    required: ["kind", "tone", "text"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      kind: { const: "code" },
      lang: { type: "string" },
      text: { type: "string" },
    },
    required: ["kind", "text"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      kind: { const: "table" },
      header: { type: "array", items: { type: "string" }, minItems: 1 },
      rows: {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
    },
    required: ["kind", "header", "rows"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      kind: { const: "list" },
      ordered: { type: "boolean" },
      items: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["kind", "ordered", "items"],
    additionalProperties: false,
  },
];

const tileSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    value: { type: ["string", "number"] },
    delta: {
      type: "object",
      properties: {
        text: { type: "string" },
        tone: { enum: ["good", "bad", "neutral"] },
      },
      required: ["text", "tone"],
      additionalProperties: false,
    },
  },
  required: ["label", "value"],
  additionalProperties: false,
};

const chartSchema = {
  type: "object",
  description:
    "one value axis per chart — the schema has no second axis by construction",
  properties: {
    kind: { enum: ["bar", "line"] },
    title: { type: "string" },
    unit: { type: "string" },
    series: {
      type: "array",
      maxItems: SERIES_MAX,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          points: {
            type: "array",
            items: {
              type: "object",
              properties: {
                x: { type: ["string", "number"] },
                y: { type: "number" },
              },
              required: ["x", "y"],
              additionalProperties: false,
            },
          },
        },
        required: ["label", "points"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "title", "series"],
  additionalProperties: false,
};

const paneSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    lines: {
      type: "array",
      maxItems: PANE_LINES_MAX,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          mark: {
            enum: ["add", "del", null],
            description: "supplied by the agent — the canvas never diffs",
          },
        },
        required: ["text", "mark"],
        additionalProperties: false,
      },
    },
  },
  required: ["label", "lines"],
  additionalProperties: false,
};

const contentVariants = [
  {
    type: "object",
    properties: {
      type: { const: "document" },
      title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: BLOCKS_MAX,
        items: { oneOf: blockSchemas },
      },
    },
    required: ["type", "title", "blocks"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      type: { const: "dashboard" },
      title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
      tiles: { type: "array", maxItems: TILES_MAX, items: tileSchema },
      charts: { type: "array", maxItems: CHARTS_MAX, items: chartSchema },
    },
    required: ["type", "title", "tiles", "charts"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      type: { const: "compare" },
      title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
      panes: {
        type: "array",
        minItems: PANES_EXACT,
        maxItems: PANES_EXACT,
        items: paneSchema,
      },
    },
    required: ["type", "title", "panes"],
    additionalProperties: false,
  },
  {
    type: "object",
    description: "Honest Absence — a first-class refusal, never an error",
    properties: {
      type: { const: "absence" },
      title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
      reason: { type: "string", minLength: 1, maxLength: REASON_MAX },
    },
    required: ["type", "title", "reason"],
    additionalProperties: false,
  },
];

export const publishArtifactSchema = { oneOf: contentVariants };

export const updateArtifactSchema = {
  oneOf: contentVariants.map((variant) => ({
    ...variant,
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN.source },
      ...variant.properties,
    },
    required: ["artifact_id", ...variant.required],
  })),
};

// ---------------------------------------------------------------------------
// Validator (dependency-free; produces the JSON path of the first violation).
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  v: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): string {
  if (typeof v !== "string") throw new ValidationError(path, "expected a string");
  if (opts.min !== undefined && v.length < opts.min) {
    throw new ValidationError(path, `must be at least ${opts.min} character(s)`);
  }
  if (opts.max !== undefined && v.length > opts.max) {
    throw new ValidationError(path, `must be at most ${opts.max} characters`);
  }
  return v;
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${path}/${key}`, "unexpected field");
    }
  }
}

function requireStringArray(
  v: unknown,
  path: string,
  opts: { min?: number } = {},
): string[] {
  if (!Array.isArray(v)) throw new ValidationError(path, "expected an array");
  if (opts.min !== undefined && v.length < opts.min) {
    throw new ValidationError(path, `must have at least ${opts.min} item(s)`);
  }
  v.forEach((item, i) => requireString(item, `${path}/${i}`));
  return v as string[];
}

function validateBlock(v: unknown, path: string): DocumentBlock {
  if (!isRecord(v)) throw new ValidationError(path, "expected an object");
  const kind = v.kind;
  switch (kind) {
    case "heading": {
      rejectUnknownFields(v, ["kind", "level", "text"], path);
      if (v.level !== 1 && v.level !== 2 && v.level !== 3) {
        throw new ValidationError(`${path}/level`, "expected 1, 2, or 3");
      }
      requireString(v.text, `${path}/text`);
      return v as unknown as DocumentBlock;
    }
    case "paragraph": {
      rejectUnknownFields(v, ["kind", "text"], path);
      requireString(v.text, `${path}/text`);
      return v as unknown as DocumentBlock;
    }
    case "callout": {
      rejectUnknownFields(v, ["kind", "tone", "text"], path);
      if (v.tone !== "info" && v.tone !== "warn") {
        throw new ValidationError(`${path}/tone`, 'expected "info" or "warn"');
      }
      requireString(v.text, `${path}/text`);
      return v as unknown as DocumentBlock;
    }
    case "code": {
      rejectUnknownFields(v, ["kind", "lang", "text"], path);
      if (v.lang !== undefined) requireString(v.lang, `${path}/lang`);
      requireString(v.text, `${path}/text`);
      return v as unknown as DocumentBlock;
    }
    case "table": {
      rejectUnknownFields(v, ["kind", "header", "rows"], path);
      requireStringArray(v.header, `${path}/header`, { min: 1 });
      if (!Array.isArray(v.rows)) {
        throw new ValidationError(`${path}/rows`, "expected an array");
      }
      v.rows.forEach((row, i) =>
        requireStringArray(row, `${path}/rows/${i}`),
      );
      return v as unknown as DocumentBlock;
    }
    case "list": {
      rejectUnknownFields(v, ["kind", "ordered", "items"], path);
      if (typeof v.ordered !== "boolean") {
        throw new ValidationError(`${path}/ordered`, "expected a boolean");
      }
      requireStringArray(v.items, `${path}/items`, { min: 1 });
      return v as unknown as DocumentBlock;
    }
    default:
      throw new ValidationError(
        `${path}/kind`,
        `unknown block kind ${JSON.stringify(kind)}`,
      );
  }
}

function requireFiniteNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(path, "expected a finite number");
  }
  return v;
}

function requireLabelValue(v: unknown, path: string): string | number {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new ValidationError(path, "expected a string or finite number");
}

function validateTile(v: unknown, path: string): DashboardTile {
  if (!isRecord(v)) throw new ValidationError(path, "expected an object");
  rejectUnknownFields(v, ["label", "value", "delta"], path);
  requireString(v.label, `${path}/label`);
  requireLabelValue(v.value, `${path}/value`);
  if (v.delta !== undefined) {
    const delta = v.delta;
    if (!isRecord(delta)) {
      throw new ValidationError(`${path}/delta`, "expected an object");
    }
    rejectUnknownFields(delta, ["text", "tone"], `${path}/delta`);
    requireString(delta.text, `${path}/delta/text`);
    if (delta.tone !== "good" && delta.tone !== "bad" && delta.tone !== "neutral") {
      throw new ValidationError(
        `${path}/delta/tone`,
        'expected "good", "bad", or "neutral"',
      );
    }
  }
  return v as unknown as DashboardTile;
}

function validateSeries(v: unknown, path: string): ChartSeries {
  if (!isRecord(v)) throw new ValidationError(path, "expected an object");
  rejectUnknownFields(v, ["label", "points"], path);
  requireString(v.label, `${path}/label`);
  if (!Array.isArray(v.points)) {
    throw new ValidationError(`${path}/points`, "expected an array");
  }
  v.points.forEach((point, i) => {
    const pointPath = `${path}/points/${i}`;
    if (!isRecord(point)) {
      throw new ValidationError(pointPath, "expected an object");
    }
    rejectUnknownFields(point, ["x", "y"], pointPath);
    requireLabelValue(point.x, `${pointPath}/x`);
    requireFiniteNumber(point.y, `${pointPath}/y`);
  });
  return v as unknown as ChartSeries;
}

function validateChart(v: unknown, path: string): DashboardChart {
  if (!isRecord(v)) throw new ValidationError(path, "expected an object");
  rejectUnknownFields(v, ["kind", "title", "unit", "series"], path);
  if (v.kind !== "bar" && v.kind !== "line") {
    throw new ValidationError(`${path}/kind`, 'expected "bar" or "line"');
  }
  requireString(v.title, `${path}/title`);
  if (v.unit !== undefined) requireString(v.unit, `${path}/unit`);
  if (!Array.isArray(v.series)) {
    throw new ValidationError(`${path}/series`, "expected an array");
  }
  if (v.series.length > SERIES_MAX) {
    throw new ValidationError(
      `${path}/series`,
      `must have at most ${SERIES_MAX} series`,
    );
  }
  v.series.forEach((series, i) => validateSeries(series, `${path}/series/${i}`));
  return v as unknown as DashboardChart;
}

function validatePane(v: unknown, path: string): ComparePane {
  if (!isRecord(v)) throw new ValidationError(path, "expected an object");
  rejectUnknownFields(v, ["label", "lines"], path);
  requireString(v.label, `${path}/label`);
  if (!Array.isArray(v.lines)) {
    throw new ValidationError(`${path}/lines`, "expected an array");
  }
  if (v.lines.length > PANE_LINES_MAX) {
    throw new ValidationError(
      `${path}/lines`,
      `must have at most ${PANE_LINES_MAX} lines`,
    );
  }
  v.lines.forEach((line, i) => {
    const linePath = `${path}/lines/${i}`;
    if (!isRecord(line)) {
      throw new ValidationError(linePath, "expected an object");
    }
    rejectUnknownFields(line, ["text", "mark"], linePath);
    requireString(line.text, `${linePath}/text`);
    if (line.mark !== "add" && line.mark !== "del" && line.mark !== null) {
      throw new ValidationError(
        `${linePath}/mark`,
        'expected "add", "del", or null',
      );
    }
  });
  return v as unknown as ComparePane;
}

/** Validate publish_artifact input; throws ValidationError with a JSON path. */
export function validateArtifactContent(input: unknown): ArtifactContent {
  if (!isRecord(input)) throw new ValidationError("/", "expected an object");
  switch (input.type) {
    case "document": {
      rejectUnknownFields(input, ["type", "title", "blocks"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      if (!Array.isArray(input.blocks)) {
        throw new ValidationError("/blocks", "expected an array");
      }
      if (input.blocks.length < 1 || input.blocks.length > BLOCKS_MAX) {
        throw new ValidationError(
          "/blocks",
          `must have between 1 and ${BLOCKS_MAX} blocks`,
        );
      }
      input.blocks.forEach((block, i) => validateBlock(block, `/blocks/${i}`));
      return input as unknown as ArtifactContent;
    }
    case "dashboard": {
      rejectUnknownFields(input, ["type", "title", "tiles", "charts"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      if (!Array.isArray(input.tiles)) {
        throw new ValidationError("/tiles", "expected an array");
      }
      if (input.tiles.length > TILES_MAX) {
        throw new ValidationError(
          "/tiles",
          `must have at most ${TILES_MAX} tiles`,
        );
      }
      input.tiles.forEach((tile, i) => validateTile(tile, `/tiles/${i}`));
      if (!Array.isArray(input.charts)) {
        throw new ValidationError("/charts", "expected an array");
      }
      if (input.charts.length > CHARTS_MAX) {
        throw new ValidationError(
          "/charts",
          `must have at most ${CHARTS_MAX} charts`,
        );
      }
      input.charts.forEach((chart, i) => validateChart(chart, `/charts/${i}`));
      return input as unknown as ArtifactContent;
    }
    case "compare": {
      rejectUnknownFields(input, ["type", "title", "panes"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      if (!Array.isArray(input.panes)) {
        throw new ValidationError("/panes", "expected an array");
      }
      if (input.panes.length !== PANES_EXACT) {
        throw new ValidationError(
          "/panes",
          `must have exactly ${PANES_EXACT} panes`,
        );
      }
      input.panes.forEach((pane, i) => validatePane(pane, `/panes/${i}`));
      return input as unknown as ArtifactContent;
    }
    case "absence": {
      rejectUnknownFields(input, ["type", "title", "reason"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      requireString(input.reason, "/reason", { min: 1, max: REASON_MAX });
      return input as unknown as ArtifactContent;
    }
    default:
      throw new ValidationError(
        "/type",
        `expected "document", "dashboard", "compare", or "absence", ` +
          `got ${JSON.stringify(input.type)}`,
      );
  }
}

/** Validate update_artifact input: artifact_id + the same content fields. */
export function validateUpdateInput(input: unknown): {
  artifactId: string;
  content: ArtifactContent;
} {
  if (!isRecord(input)) throw new ValidationError("/", "expected an object");
  const { artifact_id: artifactId, ...content } = input;
  if (!isArtifactId(artifactId)) {
    throw new ValidationError(
      "/artifact_id",
      'expected an id of the form "a_" + 8 hex chars',
    );
  }
  return { artifactId, content: validateArtifactContent(content) };
}
