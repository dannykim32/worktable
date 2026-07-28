// Issue 05 integration layer: POST → check_askbacks → redelivery-empty over
// real HTTP + stdio MCP; version pinning while scrubbed back; restart
// persistence; auth + size limits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CanvasApi } from "../src/canvas/api.js";
import { anchorFromRange } from "../src/canvas/askback.js";
import { Gallery } from "../src/canvas/gallery.js";
import type {
  Anchor,
  ArtifactContent,
  ArtifactMeta,
} from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";
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

interface CheckResult {
  askbacks: Array<{
    id: string;
    question: string;
    quote: string;
    anchor: Anchor;
    artifact_title: string | null;
  }>;
  hint?: string;
}

async function publishDoc(title: string, text: string): Promise<string> {
  const result = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "document",
        title,
        blocks: [{ kind: "paragraph", text }],
      },
    }),
  );
  return result.artifact_id as string;
}

function postAskback(body: unknown, token?: string) {
  return httpRequest({
    port: server.port,
    path: "/api/askbacks",
    method: "POST",
    headers: {
      ...(token ? bearer(token) : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("ask-back loop", () => {
  test("POST → check_askbacks returns anchor+quote+title; second check empty", async () => {
    const id = await publishDoc("Loop doc", "select me and ask");
    const res = await postAskback(
      {
        anchor: {
          artifact_id: id,
          version: 1,
          block_index: 0,
          char_start: 0,
          char_end: 9,
          quote: "select me",
        },
        question: "what does this mean?",
      },
      server.token(),
    );
    expect(res.status).toBe(201);

    const first = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as CheckResult;
    const item = first.askbacks.find((a) => a.anchor.artifact_id === id)!;
    expect(item.question).toBe("what does this mean?");
    expect(item.quote).toBe("select me");
    expect(item.anchor.version).toBe(1);
    expect(item.anchor.block_index).toBe(0);
    expect(item.anchor.char_start).toBe(0);
    expect(item.anchor.char_end).toBe(9);
    expect(item.artifact_title).toBe("Loop doc");

    const second = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as CheckResult;
    expect(second.askbacks).toHaveLength(0);
    expect(second.hint).toBe("no pending questions from the canvas");
  });

  test("ask-back from a scrubbed-back card pins the viewed version (ADR-0006)", async () => {
    const id = await publishDoc("Pinning doc", "version one wording here");
    toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: {
          artifact_id: id,
          type: "document",
          title: "Pinning doc",
          blocks: [{ kind: "paragraph", text: "version two wording here" }],
        },
      }),
    );

    // Real canvas gallery over real HTTP, scrubbed back to v1.
    const { document, mount } = makeDom();
    const api: CanvasApi = {
      health: async () => ({ workspaceId: server.workspaceId, version: "t" }),
      listArtifacts: async () =>
        JSON.parse(
          (
            await httpRequest({
              port: server.port,
              path: "/api/artifacts",
              headers: bearer(server.token()),
            })
          ).body,
        ) as ArtifactMeta[],
      getArtifact: async (artifactId) =>
        JSON.parse(
          (
            await httpRequest({
              port: server.port,
              path: `/api/artifacts/${artifactId}`,
              headers: bearer(server.token()),
            })
          ).body,
        ) as ArtifactMeta & { content: ArtifactContent },
      getVersion: async (artifactId, version) =>
        JSON.parse(
          (
            await httpRequest({
              port: server.port,
              path: `/api/artifacts/${artifactId}/v/${version}`,
              headers: bearer(server.token()),
            })
          ).body,
        ) as ArtifactContent,
      postAskback: async () => ({ id: "ab_stub", state: "pending" }),
      getAnsweredAskbacks: async () => [],
    };
    const gallery = new Gallery(mount, api);
    await gallery.init();
    const card = mount.querySelector(`[data-artifact-id="${id}"]`)!;
    (card.querySelector("button.prev") as HTMLButtonElement).click();
    const deadline = Date.now() + 1000;
    while (gallery.viewingVersion(id) !== 1) {
      if (Date.now() > deadline) throw new Error("scrub did not reach v1");
      await new Promise((r) => setTimeout(r, 10));
    }

    const p = card.querySelector("p")!;
    expect(p.textContent).toBe("version one wording here");
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 11);
    const anchor = anchorFromRange(
      range,
      p as HTMLElement,
      id,
      gallery.viewingVersion(id)!,
    );
    expect(anchor.version).toBe(1); // pinned to what the human was reading

    const res = await postAskback(
      { anchor, question: "was this wording deliberate?" },
      server.token(),
    );
    expect(res.status).toBe(201);
    const check = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as CheckResult;
    const item = check.askbacks.find((a) => a.anchor.artifact_id === id)!;
    expect(item.anchor.version).toBe(1);
    expect(item.quote).toBe("version one");
  });

  test("queue survives server restart: pending stays pending", async () => {
    const id = await publishDoc("Restart doc", "still here after restart");
    const res = await postAskback(
      {
        anchor: { artifact_id: id, version: 1, block_index: null, quote: "Restart doc" },
        question: "did you survive?",
      },
      server.token(),
    );
    expect(res.status).toBe(201);

    const home = server.home;
    await server.close();
    server = await spawnServer({ home });

    const check = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as unknown as CheckResult;
    const item = check.askbacks.find((a) => a.anchor.artifact_id === id)!;
    expect(item.question).toBe("did you survive?");
    expect(item.artifact_title).toBe("Restart doc"); // store reloaded too
  }, 20_000);

  test("the door rate-limits: 61st POST inside a minute is 429 + Retry-After", async () => {
    // Fresh server so this test's traffic cannot starve the others.
    const fresh = await spawnServer();
    try {
      const body = {
        anchor: {
          artifact_id: "a_00000000",
          version: 1,
          block_index: null,
          quote: "q",
        },
        question: "rapid fire",
      };
      for (let i = 0; i < 60; i++) {
        const res = await httpRequest({
          port: fresh.port,
          path: "/api/askbacks",
          method: "POST",
          headers: {
            ...bearer(fresh.token()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
      }
      const refused = await httpRequest({
        port: fresh.port,
        path: "/api/askbacks",
        method: "POST",
        headers: {
          ...bearer(fresh.token()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(refused.status).toBe(429);
      const retryAfter = Number(refused.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    } finally {
      await fresh.close();
    }
  }, 20_000);

  test("POST without bearer → 401; oversized question → 400 with reason", async () => {
    const noAuth = await postAskback({
      anchor: { artifact_id: "a_00000000", version: 1, block_index: null, quote: "q" },
      question: "unauthenticated",
    });
    expect(noAuth.status).toBe(401);

    const oversized = await postAskback(
      {
        anchor: { artifact_id: "a_00000000", version: 1, block_index: null, quote: "q" },
        question: "x".repeat(2001),
      },
      server.token(),
    );
    expect(oversized.status).toBe(400);
    expect((JSON.parse(oversized.body) as { error: string }).error).toContain(
      "2000",
    );
  });
});
