// Issue 03 unit layer (updated for issue 26): schema validation over the
// {html, prose, absence} surface (accepts each type, rejects with JSON paths),
// artifact id generation, atomic write commit point.
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
  publishArtifactSchema,
  validateArtifactContent,
  validateUpdateInput,
  ValidationError,
} from "../src/server/validate.js";

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
  test("accepts an html artifact and stores the html verbatim", () => {
    const content = validateArtifactContent({
      type: "html",
      title: "Flowchart",
      html: "<h1>hi</h1><p>self-contained</p>",
    });
    expect(content.type).toBe("html");
    if (content.type === "html") {
      expect(content.html).toContain("self-contained");
    }
  });

  test("accepts honest absence as first-class content", () => {
    const content = validateArtifactContent({
      type: "absence",
      title: "Cannot summarize 5,471 directories",
      reason: "One artifact cannot tell that story truthfully.",
    });
    expect(content.type).toBe("absence");
  });

  test("accepts a prose artifact and stores the markdown verbatim", () => {
    const content = validateArtifactContent({
      type: "prose",
      title: "Design rationale",
      markdown: "# Heading\n\nSome **bold** prose with `code`.",
    });
    expect(content.type).toBe("prose");
    if (content.type === "prose") {
      expect(content.markdown).toContain("**bold**");
    }
  });

  test("accepts empty-markdown prose but rejects oversize markdown at /markdown", () => {
    // Empty markdown is allowed (renders nothing); only the size ceiling bites.
    expect(
      validateArtifactContent({ type: "prose", title: "t", markdown: "" }).type,
    ).toBe("prose");
    expect(
      rejectPath({
        type: "prose",
        title: "t",
        markdown: "x".repeat(100 * 1024 + 1),
      }),
    ).toBe("/markdown");
  });

  test("rejects an extra top-level field", () => {
    expect(
      rejectPath({ type: "absence", title: "t", reason: "r", extra: 1 }),
    ).toBe("/extra");
  });

  test("rejects an empty title", () => {
    expect(
      rejectPath({ type: "prose", title: "", markdown: "x" }),
    ).toBe("/title");
  });

  test("rejects every retired type (document/dashboard/compare/svg) at /type", () => {
    for (const type of ["document", "dashboard", "compare", "svg", "widget"]) {
      expect(rejectPath({ type, title: "t" })).toBe("/type");
    }
  });

  test("rejects a cross-type field on a prose artifact (reject-not-drop)", () => {
    // A field belonging to another type fails the whole call, naming its path —
    // nothing is silently dropped.
    expect(
      rejectPath({ type: "prose", title: "t", markdown: "hi", html: "<b>no</b>" }),
    ).toBe("/html");
    expect(
      rejectPath({ type: "html", title: "t", html: "<b>ok</b>", markdown: "x" }),
    ).toBe("/markdown");
  });

  test("publish inputSchema is a FLAT MCP object schema with a three-value type enum", () => {
    // A top-level `oneOf` of per-type branches is filled UNRELIABLY by LLM
    // tool-use — the model defaults to the first branch. A flat object with a
    // `type` ENUM is filled reliably; the hand-validator stays authoritative.
    expect(publishArtifactSchema.type).toBe("object");
    expect(
      (publishArtifactSchema as { oneOf?: unknown }).oneOf,
    ).toBeUndefined();
    const props = (
      publishArtifactSchema as { properties: Record<string, { enum?: string[] }> }
    ).properties;
    expect(props.type.enum).toEqual(["html", "prose", "absence"]);
    // Exactly the three types' content fields are exposed — nothing else.
    for (const f of ["html", "markdown", "reason"]) {
      expect(props[f]).toBeDefined();
    }
    for (const f of ["blocks", "tiles", "charts", "panes", "svg", "repair_token"]) {
      expect(props[f]).toBeUndefined();
    }
    // Update input carries content through with an artifact_id.
    const upd = validateUpdateInput({
      type: "prose",
      title: "t",
      markdown: "hi",
      artifact_id: "a_12ab34cd",
    });
    expect(upd.content.type).toBe("prose");
  });

  test("update input requires a well-formed artifact_id", () => {
    const good = { type: "prose", title: "t", markdown: "hi" };
    expect(() =>
      validateUpdateInput({ ...good, artifact_id: "not-an-id" }),
    ).toThrow("/artifact_id");
    const ok = validateUpdateInput({ ...good, artifact_id: "a_12ab34cd" });
    expect(ok.artifactId).toBe("a_12ab34cd");
    expect(ok.content.type).toBe("prose");
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
      type: "prose",
      title: "stays prose",
      markdown: "v1",
    });
    expect(() =>
      store.update(meta.id, {
        type: "absence",
        title: "stays prose",
        reason: "trying to morph",
      }),
    ).toThrow(ArtifactTypeMismatchError);
    // Nothing was written: still v1, still prose.
    expect(store.getMeta(meta.id)?.latest).toBe(1);
    expect(store.getMeta(meta.id)?.type).toBe("prose");
    expect(store.getVersion(meta.id, 2)).toBeNull();
  });

  test("store scan ignores stray tmp files and reloads metas after restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "visual-chat-store-"));
    const store = new ArtifactStore(stateDir);
    const meta = store.publish({
      type: "prose",
      title: "survives restart",
      markdown: "hello",
    });
    // Simulate a crashed write alongside the good files.
    atomicWriteJson(join(stateDir, "artifacts", meta.id, "v2.json.crash"), {});
    const reloaded = new ArtifactStore(stateDir);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.getMeta(meta.id)?.title).toBe("survives restart");
    expect(reloaded.getVersion(meta.id, 1)?.type).toBe("prose");
    expect(reloaded.getVersion(meta.id, 2)).toBeNull();
  });
});
