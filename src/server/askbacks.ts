// The Ask-back queue: the ONLY browser→agent channel (ADR-0004, ADR-0010).
// Persistence: <stateDir>/askbacks.jsonl (0600), append-only for new items,
// atomic tmp+rename rewrite when marking delivery.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Anchor, Askback } from "../shared/artifacts.js";
import {
  isArtifactId,
  QUESTION_MAX,
  QUOTE_MAX,
} from "../shared/constraints.js";
import { atomicWriteFile } from "./atomicWrite.js";

export class AskbackValidationError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a POST /api/askbacks body; throws AskbackValidationError (→ 400). */
export function validateAskbackBody(body: unknown): {
  anchor: Anchor;
  question: string;
} {
  if (!isRecord(body)) {
    throw new AskbackValidationError("body must be a JSON object");
  }
  for (const key of Object.keys(body)) {
    if (key !== "anchor" && key !== "question") {
      throw new AskbackValidationError(`unexpected field "${key}"`);
    }
  }
  const { anchor, question } = body;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new AskbackValidationError("question must be a non-empty string");
  }
  if (question.length > QUESTION_MAX) {
    throw new AskbackValidationError(
      `question is ${question.length} chars; maximum is ${QUESTION_MAX}`,
    );
  }
  if (!isRecord(anchor)) {
    throw new AskbackValidationError("anchor is required");
  }
  const allowed = [
    "artifact_id",
    "version",
    "block_index",
    "char_start",
    "char_end",
    "quote",
  ];
  for (const key of Object.keys(anchor)) {
    if (!allowed.includes(key)) {
      throw new AskbackValidationError(`unexpected anchor field "${key}"`);
    }
  }
  if (!isArtifactId(anchor.artifact_id)) {
    throw new AskbackValidationError("anchor.artifact_id must be an artifact id");
  }
  if (!Number.isInteger(anchor.version) || (anchor.version as number) < 1) {
    throw new AskbackValidationError("anchor.version must be a positive integer");
  }
  const blockIndex = anchor.block_index ?? null;
  if (blockIndex !== null && (!Number.isInteger(blockIndex) || (blockIndex as number) < 0)) {
    throw new AskbackValidationError(
      "anchor.block_index must be a non-negative integer or null",
    );
  }
  for (const key of ["char_start", "char_end"] as const) {
    const v = anchor[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) {
      throw new AskbackValidationError(`anchor.${key} must be a non-negative integer`);
    }
  }
  if (
    anchor.char_start !== undefined &&
    anchor.char_end !== undefined &&
    (anchor.char_end as number) < (anchor.char_start as number)
  ) {
    throw new AskbackValidationError("anchor.char_end must be >= anchor.char_start");
  }
  if (typeof anchor.quote !== "string" || anchor.quote.length === 0) {
    throw new AskbackValidationError("anchor.quote is required");
  }
  if (anchor.quote.length > QUOTE_MAX) {
    throw new AskbackValidationError(
      `anchor.quote is ${anchor.quote.length} chars; maximum is ${QUOTE_MAX}`,
    );
  }
  const result: Anchor = {
    artifact_id: anchor.artifact_id,
    version: anchor.version as number,
    block_index: blockIndex as number | null,
    quote: anchor.quote,
  };
  if (anchor.char_start !== undefined) result.char_start = anchor.char_start as number;
  if (anchor.char_end !== undefined) result.char_end = anchor.char_end as number;
  return { anchor: result, question };
}

export class AskbackQueue {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "askbacks.jsonl");
  }

  private readAll(): Askback[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Askback);
  }

  append(input: { anchor: Anchor; question: string }): Askback {
    const askback: Askback = {
      id: `ab_${randomBytes(4).toString("hex")}`,
      anchor: input.anchor,
      question: input.question,
      state: "pending",
      created_at: new Date().toISOString(),
    };
    appendFileSync(this.path, `${JSON.stringify(askback)}\n`, { mode: 0o600 });
    return askback;
  }

  pending(): Askback[] {
    return this.readAll().filter((a) => a.state === "pending");
  }

  /** Return all pending ask-backs, atomically marking them delivered
   *  (tmp + rename rewrite so a crash never loses the queue). */
  drainPending(): Askback[] {
    const all = this.readAll();
    const drained: Askback[] = [];
    const rewritten = all.map((a) => {
      if (a.state !== "pending") return a;
      drained.push(a);
      return { ...a, state: "delivered" as const };
    });
    if (drained.length > 0) {
      atomicWriteFile(
        this.path,
        rewritten.map((a) => JSON.stringify(a)).join("\n") + "\n",
      );
    }
    return drained;
  }
}
