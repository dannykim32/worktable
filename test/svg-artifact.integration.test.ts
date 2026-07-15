// Issue 10 integration layer: publish valid + hostile SVG over real MCP.
// Valid → stored as the re-serialized form (byte-different from a messy input,
// AC3) and listed. Hostile → tool error listing violations, nothing stored
// (AC2). The stored bytes are the sanitizer's output, never the raw input.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactMeta, SvgContent } from "../src/shared/artifacts.js";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

let server: SpawnedServer;

beforeAll(async () => {
  ensureCanvasBuilt();
  server = await spawnServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

// Deliberately messy but benign: odd whitespace, single quotes, un-namespaced,
// attributes out of canonical order. Sanitizes fine; re-serializes different.
const MESSY_BENIGN =
  "<svg viewBox='0 0 10 10'  >\n   <rect   height='10' width='10'  fill='teal' />\n</svg>";

function toolError(result: unknown): string {
  const r = result as { isError?: boolean; content: Array<{ text: string }> };
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

describe("svg artifact publish over MCP", () => {
  test("valid SVG publishes, lists, and stores the RE-SERIALIZED form (AC3)", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Messy but benign", svg: MESSY_BENIGN },
      }),
    );
    const id = published.artifact_id as string;
    expect(published.version).toBe(1);

    // Listed like any artifact.
    const list = await httpRequest({
      port: server.port,
      path: "/api/artifacts",
      headers: bearer(server.token()),
    });
    const metas = JSON.parse(list.body) as ArtifactMeta[];
    expect(metas.find((m) => m.id === id)?.type).toBe("svg");

    // Stored v1.json holds the sanitizer's canonical output — byte-different
    // from the messy input (proves re-serialization; input never persisted).
    const v1Path = join(server.stateDir, "artifacts", id, "v1.json");
    const stored = JSON.parse(readFileSync(v1Path, "utf8")) as SvgContent;
    expect(stored.type).toBe("svg");
    expect(stored.svg).not.toBe(MESSY_BENIGN);
    // Canonical: namespaced root, double quotes, attributes sorted.
    expect(stored.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(stored.svg).toContain('<rect fill="teal" height="10" width="10"/>');
    // The raw messy bytes appear nowhere in the stored file.
    expect(readFileSync(v1Path, "utf8")).not.toContain("viewBox='0 0 10 10'");
  });

  test("hostile SVG → tool error listing violations, nothing stored (AC2)", async () => {
    const before = readdirSync(join(server.stateDir, "artifacts")).length;
    const result = await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "svg",
        title: "Attack",
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<script>alert(1)</script><rect width="10" height="10" onload="x()"/></svg>',
      },
    });
    const text = toolError(result);
    // Violations are surfaced verbatim, precise enough to fix.
    expect(text).toContain("element-not-allowed");
    expect(text).toContain("event-attribute");
    expect(text.toLowerCase()).toContain("nothing was stored");
    // No new artifact directory was created.
    expect(readdirSync(join(server.stateDir, "artifacts")).length).toBe(before);
  });

  test("XSS end-check: a benign SVG with <text>alert probe</text> stays inert (AC5)", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Probe",
          svg:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">' +
            '<text x="1" y="10">alert probe</text></svg>',
        },
      }),
    );
    const id = published.artifact_id as string;
    // Server returns the artifact content; the app renders it as a data-URL
    // <img> (asserted structurally in svg-artifact.test.ts). Here we confirm
    // the stored markup is the inert re-serialized SVG — no script, no handler.
    const res = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}`,
      headers: bearer(server.token()),
    });
    const body = JSON.parse(res.body) as { content: SvgContent };
    expect(body.content.svg).toContain("alert probe");
    expect(body.content.svg).not.toContain("<script");
    expect(body.content.svg).not.toMatch(/on[a-z]+=/i);
  });

  test("updating an svg artifact re-sanitizes; a hostile update is rejected", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Editable",
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="navy"/></svg>',
        },
      }),
    );
    const id = published.artifact_id as string;
    const bad = await server.client.callTool({
      name: "update_artifact",
      arguments: {
        artifact_id: id,
        type: "svg",
        title: "Editable",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject/></svg>',
      },
    });
    expect(toolError(bad)).toContain("element-not-allowed");
    // Still only v1 on disk — the rejected update stored nothing.
    const files = readdirSync(join(server.stateDir, "artifacts", id)).sort();
    expect(files).toEqual(["meta.json", "v1.json"]);
  });
});
