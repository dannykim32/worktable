// Issue 06: the walking-skeleton E2E — the full loop over a real server
// subprocess, real stdio MCP, and real loopback HTTP. Locks M1's definition
// of done against regression.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Anchor, ArtifactMeta } from "../src/shared/artifacts.js";
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

test(
  "walking skeleton: publish → render → update → ask-back → check_askbacks",
  async () => {
    // 1. Agent publishes a prose artifact via MCP tool.
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "prose",
          title: "Walking skeleton note",
          markdown: "# The loop\n\npublish, read, ask, answer",
        },
      }),
    );
    const id = published.artifact_id as string;
    expect(published.version).toBe(1);
    const canvasUrl = new URL(published.url as string);

    // The tokened URL serves the canvas page (what the human opens).
    const page = await httpRequest({
      port: Number(canvasUrl.port),
      path: canvasUrl.pathname + canvasUrl.search,
    });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");

    // 2. HTTP shows v1.
    const v1 = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}`,
      headers: bearer(server.token()),
    });
    expect(v1.status).toBe(200);
    const v1Body = JSON.parse(v1.body) as ArtifactMeta & {
      content: { markdown: string };
    };
    expect(v1Body.latest).toBe(1);
    expect(v1Body.content.markdown).toBe("# The loop\n\npublish, read, ask, answer");

    // 3. Update → v2 live AND v1 still readable.
    const updated = toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: {
          artifact_id: id,
          type: "prose",
          title: "Walking skeleton note",
          markdown: "# The loop\n\npublish, read, ask, answer, revise",
        },
      }),
    );
    expect(updated.version).toBe(2);
    const latest = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/v/2`,
      headers: bearer(server.token()),
    });
    const old = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}/v/1`,
      headers: bearer(server.token()),
    });
    expect(latest.status).toBe(200);
    expect(old.status).toBe(200);
    expect(
      (JSON.parse(old.body) as { markdown: string }).markdown,
    ).toBe("# The loop\n\npublish, read, ask, answer");

    // 4. Human asks about a span of v2 (direct HTTP, simulating the browser).
    const anchor: Anchor = {
      artifact_id: id,
      version: 2,
      block_index: 1,
      char_start: 26,
      char_end: 32,
      quote: "revise",
    };
    const posted = await httpRequest({
      port: server.port,
      path: "/api/askbacks",
      method: "POST",
      headers: { ...bearer(server.token()), "Content-Type": "application/json" },
      body: JSON.stringify({ anchor, question: "what does revise mean here?" }),
    });
    expect(posted.status).toBe(201);

    // 5. Agent pulls it next turn, with the anchor.
    const check = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as {
      askbacks: Array<{
        question: string;
        quote: string;
        anchor: Anchor;
        artifact_title: string | null;
      }>;
    };
    expect(check.askbacks).toHaveLength(1);
    const item = check.askbacks[0]!;
    expect(item.question).toBe("what does revise mean here?");
    expect(item.quote).toBe("revise");
    expect(item.anchor).toEqual(anchor);
    expect(item.artifact_title).toBe("Walking skeleton note");

    // 6. Delivery is marked: second check is empty.
    const again = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as { askbacks: unknown[]; hint?: string };
    expect(again.askbacks).toHaveLength(0);
    expect(again.hint).toBe("no pending questions from the canvas");
  },
  25_000,
);
