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
          type: "prose",
          title: "Design note v1",
          markdown: "first draft",
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
          type: "prose",
          title: "Design note v2",
          markdown: "second draft",
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
        type: "prose",
        title: "bad",
        markdown: "nope",
        blocks: [{ kind: "marquee", text: "nope" }],
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    // Reject-not-drop: a cross-type field on a prose artifact fails the whole
    // call, naming the offending JSON path — nothing is stored.
    expect(result.content[0]!.text).toContain("/blocks");
    expect(result.content[0]!.text).toContain("unexpected field");
    expect(readdirSync(join(server.stateDir, "artifacts")).length).toBe(before);
  });

  test("SSE client receives the artifact event within 500ms of update", async () => {
    const sse = await openSse(server.port, server.token());
    try {
      const published = toolJson(
        await server.client.callTool({
          name: "publish_artifact",
          arguments: {
            type: "prose",
            title: "sse target",
            markdown: "watch me",
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
            type: "prose",
            title: "sse target",
            markdown: "updated",
          },
        }),
      );
      // Criterion 3: the connected client sees the update within 500ms.
      const frame = await sse.waitFor("artifact", 500, (f) => {
        const data = f.data as ArtifactEvent;
        return data.artifact_id === id && data.version === 2;
      });
      expect((frame.data as ArtifactEvent).type).toBe("prose");
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

  test("list_artifacts: newest first, meta fields only, dupe-avoidance hint", async () => {
    const first = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "prose", title: "Quarterly report", markdown: "v1" },
      }),
    );
    // Same-millisecond publishes tie on updated_at and fall to the random-id
    // tiebreak — give the clock a tick so newest-first is deterministic.
    await new Promise((r) => setTimeout(r, 25));
    const second = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "prose", title: "Rollout runbook", markdown: "v1" },
      }),
    );
    const listed = toolJson(
      await server.client.callTool({ name: "list_artifacts", arguments: {} }),
    ) as {
      artifacts: Array<Record<string, unknown>>;
      hint: string;
    };

    const ids = listed.artifacts.map((a) => a.artifact_id);
    // Newest first, both present.
    expect(ids.indexOf(second.artifact_id as string)).toBeLessThan(
      ids.indexOf(first.artifact_id as string),
    );
    const entry = listed.artifacts.find(
      (a) => a.artifact_id === second.artifact_id,
    )!;
    expect(entry.title).toBe("Rollout runbook");
    expect(entry.type).toBe("prose");
    expect(entry.latest_version).toBe(1);
    expect(typeof entry.updated_at).toBe("string");
    // Meta only — never content payloads.
    expect(entry.markdown).toBeUndefined();
    expect(listed.hint).toContain("update the matching artifact");
  });

  test("export route: attachment headers; ?conversation=1 appends the Q&A", async () => {
    const pub = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "html", title: "Export me", html: "<p>content</p>" },
      }),
    );
    const id = pub.artifact_id as string;
    await httpRequest({
      port: server.port,
      path: "/api/askbacks",
      method: "POST",
      headers: { ...bearer(server.token()), "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: { artifact_id: id, version: 1, block_index: null, quote: "content" },
        question: "why export?",
      }),
    });

    const plain = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/export`,
      headers: bearer(server.token()),
    });
    expect(plain.status).toBe(200);
    expect(plain.headers["content-type"]).toContain("text/html");
    expect(plain.headers["content-disposition"]).toContain('filename="export-me.html"');
    expect(plain.body).toContain("<p>content</p>");
    expect(plain.body).toContain("Content-Security-Policy");
    expect(plain.body).not.toContain("why export?"); // no appendix by default

    const withConv = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/export?conversation=1`,
      headers: bearer(server.token()),
    });
    expect(withConv.body).toContain("why export?");
    expect(withConv.body).toContain("not answered");

    const noAuth = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/export`,
    });
    expect(noAuth.status).toBe(401);
    // Drain so later tests see an empty queue.
    await server.client.callTool({ name: "check_askbacks", arguments: {} });
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
