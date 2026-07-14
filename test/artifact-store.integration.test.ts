// Issue 03 integration layer: publish → update → read both versions over
// MCP + HTTP; SSE delivery; absence as first-class; 401 without bearer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactEvent, ArtifactMeta } from "../src/shared/artifacts.js";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  openSse,
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

describe("artifact store + tools + SSE", () => {
  test("publish then update: v2 live AND v1 still readable (ADR-0006)", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "document",
          title: "Design note v1",
          blocks: [{ kind: "paragraph", text: "first draft" }],
        },
      }),
    );
    const id = published.artifact_id as string;
    expect(published.version).toBe(1);
    expect(published.url as string).toContain("?token=");

    const updated = toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: {
          artifact_id: id,
          type: "document",
          title: "Design note v2",
          blocks: [{ kind: "paragraph", text: "second draft" }],
        },
      }),
    );
    expect(updated.version).toBe(2);

    const latest = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}`,
      headers: bearer(server.token()),
    });
    expect(latest.status).toBe(200);
    const latestBody = JSON.parse(latest.body) as ArtifactMeta & {
      content: { title: string };
    };
    expect(latestBody.latest).toBe(2);
    expect(latestBody.content.title).toBe("Design note v2");

    const v1 = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/v/1`,
      headers: bearer(server.token()),
    });
    expect(v1.status).toBe(200);
    expect((JSON.parse(v1.body) as { title: string }).title).toBe(
      "Design note v1",
    );

    // Both version files are on disk, 0600.
    const artifactDir = join(server.stateDir, "artifacts", id);
    const files = readdirSync(artifactDir).sort();
    expect(files).toEqual(["meta.json", "v1.json", "v2.json"]);
  });

  test("invalid input errors with the JSON path and writes nothing", async () => {
    const before = readdirSync(join(server.stateDir, "artifacts")).length;
    const result = (await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "document",
        title: "bad",
        blocks: [{ kind: "marquee", text: "nope" }],
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("/blocks/0/kind");
    expect(readdirSync(join(server.stateDir, "artifacts")).length).toBe(before);
  });

  test("SSE client receives the artifact event within 500ms of update", async () => {
    const sse = await openSse(server.port, server.token());
    try {
      const published = toolJson(
        await server.client.callTool({
          name: "publish_artifact",
          arguments: {
            type: "document",
            title: "sse target",
            blocks: [{ kind: "paragraph", text: "watch me" }],
          },
        }),
      );
      const id = published.artifact_id as string;
      await sse.waitFor(
        "artifact",
        500,
        (f) => (f.data as ArtifactEvent).artifact_id === id,
      );

      toolJson(
        await server.client.callTool({
          name: "update_artifact",
          arguments: {
            artifact_id: id,
            type: "document",
            title: "sse target",
            blocks: [{ kind: "paragraph", text: "updated" }],
          },
        }),
      );
      // Criterion 3: the connected client sees the update within 500ms.
      const frame = await sse.waitFor("artifact", 500, (f) => {
        const data = f.data as ArtifactEvent;
        return data.artifact_id === id && data.version === 2;
      });
      expect((frame.data as ArtifactEvent).type).toBe("document");
    } finally {
      sse.close();
    }
  });

  test("absence publishes and lists like any artifact", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "absence",
          title: "Repo map declined",
          reason: "5,471 directories cannot be summarized truthfully in one artifact.",
        },
      }),
    );
    const list = await httpRequest({
      port: server.port,
      path: "/api/artifacts",
      headers: bearer(server.token()),
    });
    expect(list.status).toBe(200);
    const metas = JSON.parse(list.body) as ArtifactMeta[];
    const absence = metas.find((m) => m.id === published.artifact_id);
    expect(absence?.type).toBe("absence");
    expect(metas[0]!.updated_at >= metas[metas.length - 1]!.updated_at).toBe(
      true,
    );
  });

  test("all artifact routes are 401 without a bearer", async () => {
    for (const path of [
      "/api/artifacts",
      "/api/artifacts/a_00000000",
      "/api/artifacts/a_00000000/v/1",
      "/api/events",
    ]) {
      const res = await httpRequest({ port: server.port, path });
      expect(res.status).toBe(401);
    }
  });
});
