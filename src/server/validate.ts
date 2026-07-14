// Schema validation at the MCP boundary IS the safety mechanism (ADR-0003).
// Reject-not-drop applies to structure: unknown kinds/fields fail the whole
// call with the offending JSON path — nothing is silently discarded.
import type {
  ArtifactContent,
  DocumentBlock,
} from "../shared/artifacts.js";

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
      artifact_id: { type: "string", pattern: "^a_[0-9a-f]{8}$" },
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
    case "absence": {
      rejectUnknownFields(input, ["type", "title", "reason"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      requireString(input.reason, "/reason", { min: 1, max: REASON_MAX });
      return input as unknown as ArtifactContent;
    }
    default:
      throw new ValidationError(
        "/type",
        `expected "document" or "absence", got ${JSON.stringify(input.type)}`,
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
  if (typeof artifactId !== "string" || !/^a_[0-9a-f]{8}$/.test(artifactId)) {
    throw new ValidationError(
      "/artifact_id",
      'expected an id of the form "a_" + 8 hex chars',
    );
  }
  return { artifactId, content: validateArtifactContent(content) };
}
