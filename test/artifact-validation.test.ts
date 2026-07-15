// Issue 03 unit layer: schema validation (accepts each block kind, rejects
// with JSON paths), artifact id generation, atomic write commit point.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStore,
  ArtifactTypeMismatchError,
  atomicWriteJson,
  mintArtifactId,
} from "../src/server/store.js";
import {
  validateArtifactContent,
  validateUpdateInput,
  ValidationError,
} from "../src/server/validate.js";

const allSixKinds = {
  type: "document",
  title: "Every block kind",
  blocks: [
    { kind: "heading", level: 2, text: "A heading" },
    { kind: "paragraph", text: "A paragraph." },
    { kind: "callout", tone: "warn", text: "A warning." },
    { kind: "code", lang: "ts", text: "const x = 1;" },
    { kind: "table", header: ["k", "v"], rows: [["a", "1"]] },
    { kind: "list", ordered: true, items: ["one", "two"] },
  ],
};

function rejectPath(input: unknown): string {
  try {
    validateArtifactContent(input);
  } catch (err) {
    if (err instanceof ValidationError) return err.path;
    throw err;
  }
  throw new Error("expected a ValidationError");
}

describe("publish_artifact schema validation", () => {
  test("accepts a document containing all six block kinds", () => {
    const content = validateArtifactContent(allSixKinds);
    expect(content.type).toBe("document");
    if (content.type === "document") expect(content.blocks).toHaveLength(6);
  });

  test("accepts honest absence as first-class content", () => {
    const content = validateArtifactContent({
      type: "absence",
      title: "Cannot summarize 5,471 directories",
      reason: "One artifact cannot tell that story truthfully.",
    });
    expect(content.type).toBe("absence");
  });

  test("rejects an unknown block kind, naming the JSON path", () => {
    expect(
      rejectPath({
        type: "document",
        title: "t",
        blocks: [
          { kind: "paragraph", text: "ok" },
          { kind: "banner", text: "nope" },
        ],
      }),
    ).toBe("/blocks/1/kind");
  });

  test("rejects an extra field on a block (additionalProperties: false)", () => {
    expect(
      rejectPath({
        type: "document",
        title: "t",
        blocks: [{ kind: "paragraph", text: "ok", html: "<b>no</b>" }],
      }),
    ).toBe("/blocks/0/html");
  });

  test("rejects an extra top-level field", () => {
    expect(
      rejectPath({ type: "absence", title: "t", reason: "r", extra: 1 }),
    ).toBe("/extra");
  });

  test("rejects an empty title", () => {
    expect(
      rejectPath({
        type: "document",
        title: "",
        blocks: [{ kind: "paragraph", text: "x" }],
      }),
    ).toBe("/title");
  });

  test("rejects a bad callout tone and a bad heading level", () => {
    expect(
      rejectPath({
        type: "document",
        title: "t",
        blocks: [{ kind: "callout", tone: "danger", text: "x" }],
      }),
    ).toBe("/blocks/0/tone");
    expect(
      rejectPath({
        type: "document",
        title: "t",
        blocks: [{ kind: "heading", level: 4, text: "x" }],
      }),
    ).toBe("/blocks/0/level");
  });

  test("rejects unknown top-level type and empty blocks", () => {
    expect(rejectPath({ type: "widget", title: "t" })).toBe("/type");
    expect(rejectPath({ type: "document", title: "t", blocks: [] })).toBe(
      "/blocks",
    );
  });

  test("update input requires a well-formed artifact_id", () => {
    expect(() =>
      validateUpdateInput({ ...allSixKinds, artifact_id: "not-an-id" }),
    ).toThrow("/artifact_id");
    const ok = validateUpdateInput({ ...allSixKinds, artifact_id: "a_12ab34cd" });
    expect(ok.artifactId).toBe("a_12ab34cd");
    expect(ok.content.type).toBe("document");
  });
});

describe("artifact ids", () => {
  test('ids are "a_" + 8 hex and unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintArtifactId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^a_[0-9a-f]{8}$/);
  });
});

describe("atomic version writes", () => {
  test("an interrupt between tmp write and rename leaves no torn v<N>.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-chat-atomic-"));
    const target = join(dir, "v1.json");
    expect(() =>
      atomicWriteJson(target, { type: "absence" }, {
        beforeRename: () => {
          throw new Error("simulated kill -9 before the rename commit point");
        },
      }),
    ).toThrow("simulated kill -9");
    expect(existsSync(target)).toBe(false); // nothing torn at the final path
    // The stray tmp file is invisible to the store's reader.
    const leftovers = readdirSync(dir);
    expect(leftovers.some((f) => f.includes(".tmp-"))).toBe(true);
  });

  test("store itself rejects a type change on update (ADR-0006 invariant)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "visual-chat-typestable-"));
    const store = new ArtifactStore(stateDir);
    const meta = store.publish({
      type: "document",
      title: "stays a document",
      blocks: [{ kind: "paragraph", text: "v1" }],
    });
    expect(() =>
      store.update(meta.id, {
        type: "absence",
        title: "stays a document",
        reason: "trying to morph",
      }),
    ).toThrow(ArtifactTypeMismatchError);
    // Nothing was written: still v1, still a document.
    expect(store.getMeta(meta.id)?.latest).toBe(1);
    expect(store.getMeta(meta.id)?.type).toBe("document");
    expect(store.getVersion(meta.id, 2)).toBeNull();
  });

  test("store scan ignores stray tmp files and reloads metas after restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "visual-chat-store-"));
    const store = new ArtifactStore(stateDir);
    const meta = store.publish({
      type: "document",
      title: "survives restart",
      blocks: [{ kind: "paragraph", text: "hello" }],
    });
    // Simulate a crashed write alongside the good files.
    atomicWriteJson(join(stateDir, "artifacts", meta.id, "v2.json.crash"), {});
    const reloaded = new ArtifactStore(stateDir);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.getMeta(meta.id)?.title).toBe("survives restart");
    expect(reloaded.getVersion(meta.id, 1)?.type).toBe("document");
    expect(reloaded.getVersion(meta.id, 2)).toBeNull();
  });
});
