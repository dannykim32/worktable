// Schema validation at the MCP boundary IS the safety mechanism (ADR-0003).
// Reject-not-drop applies to structure: unknown kinds/fields fail the whole
// call with the offending JSON path — nothing is silently discarded.
//
// The artifact surface is exactly {html, prose, absence} (issue 26): the html
// hatch (issue 25) is the primary path, prose (issue 24) is the long markdown
// answer, and absence is Honest Absence. The structured components and the
// free-form svg type (with its sanitizer + legibility gate) were retired.
import type { ArtifactContent } from "../shared/artifacts.js";
import { ARTIFACT_ID_PATTERN, HTML_MAX, isArtifactId } from "../shared/constraints.js";
import { scanHtmlForEgress } from "./frameGuard.js";

export class ValidationError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`invalid input at ${path}: ${detail}`);
  }
}

const TITLE_MAX = 200;
const REASON_MAX = 2000;
// Prose (issue 24): a long response as markdown. Bounded so a runaway response
// can't blow up storage or the renderer; 100KB is a large document already.
const MARKDOWN_MAX = 100 * 1024;

// ---------------------------------------------------------------------------
// JSON Schemas, declared on the MCP tools so hosts see the exact contract.
// ---------------------------------------------------------------------------

// FLAT input schema: a single object with `type` as an ENUM and every artifact
// kind's content field present but OPTIONAL. The prior shape was a top-level
// `oneOf` of per-type branches — which LLM tool-use fills UNRELIABLY: the model
// can't choose a branch and defaults to the FIRST one, emitting e.g.
// `{type:"prose", html:"…"}` when it means html. A flat object with a `type`
// enum is the shape tool-use fills reliably. The hand-validator below stays the
// AUTHORITATIVE gate: it enforces which fields each `type` requires and rejects
// any cross-type field, so the looser exposed schema loses no safety — it only
// lets the model express the call correctly in the first place.
const contentProperties = {
  type: {
    enum: ["html", "prose", "absence"],
    description:
      "The artifact kind. Set this, then provide ONLY that kind's content " +
      "field(s): html→html · prose→markdown · absence→reason.",
  },
  title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
  html: {
    type: "string",
    minLength: 1,
    maxLength: HTML_MAX,
    description:
      "type=html: a rich, SELF-CONTAINED HTML/CSS/SVG page (≤256KB) served " +
      "verbatim in a sandboxed, network-less iframe. Inline everything; no " +
      "external <link>/fonts and no <meta http-equiv>. The model's own scripts " +
      "are neutralized (nonce CSP) — static rich HTML/CSS/SVG only.",
  },
  markdown: {
    type: "string",
    maxLength: MARKDOWN_MAX,
    description:
      "type=prose: markdown (≤100KB), rendered by the canvas's own safe " +
      "markdown→DOM renderer (no raw HTML, no scripts).",
  },
  reason: {
    type: "string",
    minLength: 1,
    maxLength: REASON_MAX,
    description:
      "type=absence: why you are declining to render (Honest Absence — a " +
      "first-class refusal, never an error).",
  },
};

export const publishArtifactSchema = {
  type: "object",
  properties: contentProperties,
  required: ["type", "title"],
  additionalProperties: false,
};

export const updateArtifactSchema = {
  type: "object",
  properties: {
    artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN.source },
    ...contentProperties,
  },
  required: ["artifact_id", "type", "title"],
  additionalProperties: false,
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

/** Validate publish_artifact input; throws ValidationError with a JSON path. */
export function validateArtifactContent(input: unknown): ArtifactContent {
  if (!isRecord(input)) throw new ValidationError("/", "expected an object");
  switch (input.type) {
    case "absence": {
      rejectUnknownFields(input, ["type", "title", "reason"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      requireString(input.reason, "/reason", { min: 1, max: REASON_MAX });
      return input as unknown as ArtifactContent;
    }
    case "html": {
      // Shape/size only. The html is stored VERBATIM and served into a
      // sandboxed, origin-split, CSP-locked iframe (issue 25) — the iframe's
      // sandbox + header CSP is the authoritative boundary, never a sanitizer
      // that mutates the markup into the host DOM. `frameSlug` is NEVER
      // accepted from the model (server-minted, client-response-only), so it is
      // an unknown field here and rejected.
      rejectUnknownFields(input, ["type", "title", "html"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      requireString(input.html, "/html", { min: 1, max: HTML_MAX });
      // REJECT-NOT-DROP (issue 25 security review): no-click network-egress
      // constructs (<meta http-equiv=refresh>, connection-hint / external
      // <link>) fire in the allow-scripts sandbox with no click and are NOT
      // governed by the header CSP. A regex strip proved bypassable, so we
      // reject the whole artifact naming the offending construct — nothing is
      // stored. The scanner is quote-aware + entity-decoding and fails closed.
      const egress = scanHtmlForEgress(input.html as string);
      if (egress.length > 0) {
        const lines = egress
          .map((e) => `  · [${e.code}] ${e.detail}`)
          .join("\n");
        throw new ValidationError(
          "/html",
          "contains disallowed no-click network-egress construct(s) — nothing " +
            "was stored. Inline the resource (fonts/styles/images as data: URIs " +
            "or inline <style>) so the page is self-contained, then re-publish to " +
            "this canvas — do NOT fall back to another rendering surface. The " +
            "sandboxed frame has no network by design:\n" +
            `${lines}`,
        );
      }
      return input as unknown as ArtifactContent;
    }
    case "prose": {
      rejectUnknownFields(input, ["type", "title", "markdown"], "");
      requireString(input.title, "/title", { min: 1, max: TITLE_MAX });
      // Shape/size only — the markdown is stored verbatim and rendered safely
      // by the canvas's own textContent-only renderer (issue 24), which is the
      // authoritative safety boundary.
      requireString(input.markdown, "/markdown", { max: MARKDOWN_MAX });
      return input as unknown as ArtifactContent;
    }
    default:
      throw new ValidationError(
        "/type",
        `expected "html", "prose", or "absence", got ${JSON.stringify(input.type)}`,
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
