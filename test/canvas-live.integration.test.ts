// Issue 04 integration layer: the gallery live-updating from a real server's
// SSE events, and version scrubbing fetching real /v/:n content.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CanvasApi } from "../src/canvas/api.js";
import { Gallery } from "../src/canvas/gallery.js";
import type {
  ArtifactContent,
  ArtifactEvent,
  ArtifactMeta,
} from "../src/shared/artifacts.js";
import { makeDom } from "./dom.js";
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

/** CanvasApi adapter over the spawned server's real HTTP surface. */
function apiFor(s: SpawnedServer): CanvasApi {
  async function get<T>(path: string): Promise<T> {
    const res = await httpRequest({
      port: s.port,
      path,
      headers: bearer(s.token()),
    });
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status}`);
    return JSON.parse(res.body) as T;
  }
  return {
    health: () => get("/api/health"),
    listArtifacts: () => get<ArtifactMeta[]>("/api/artifacts"),
    getArtifact: (id) =>
      get<ArtifactMeta & { content: ArtifactContent }>(`/api/artifacts/${id}`),
    getVersion: (id, version) =>
      get<ArtifactContent>(`/api/artifacts/${id}/v/${version}`),
    postAskback: async () => ({ id: "ab_stub", state: "pending" }),
    getAnsweredAskbacks: async () => [],
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("gallery live behavior", () => {
  test("SSE-driven update re-renders the open card within 1s, no reload", async () => {
    const { mount } = makeDom();
    const gallery = new Gallery(mount, apiFor(server), mount.ownerDocument.body);
    await gallery.init();

    const sse = await openSse(server.port, server.token());
    try {
      const published = toolJson(
        await server.client.callTool({
          name: "publish_artifact",
          arguments: {
            type: "prose",
            title: "Live doc",
            markdown: "first wording",
          },
        }),
      );
      const id = published.artifact_id as string;
      const publishFrame = await sse.waitFor(
        "artifact",
        1000,
        (f) => (f.data as ArtifactEvent).artifact_id === id,
      );
      await gallery.handleArtifactEvent(publishFrame.data as ArtifactEvent);
      const card = mount.querySelector(`[data-artifact-id="${id}"]`)!;
      expect(card.querySelector("p")!.textContent).toBe("first wording");

      const start = Date.now();
      toolJson(
        await server.client.callTool({
          name: "update_artifact",
          arguments: {
            artifact_id: id,
            type: "prose",
            title: "Live doc",
            markdown: "second wording",
          },
        }),
      );
      const updateFrame = await sse.waitFor("artifact", 1000, (f) => {
        const d = f.data as ArtifactEvent;
        return d.artifact_id === id && d.version === 2;
      });
      await gallery.handleArtifactEvent(updateFrame.data as ArtifactEvent);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(card.querySelector("p")!.textContent).toBe("second wording");
      expect(card.querySelector(".vlabel")!.textContent).toContain("v2");
    } finally {
      sse.close();
    }
  });

  test("scrubbing back shows v1 content plus the viewing marker", async () => {
    const { mount } = makeDom();
    const gallery = new Gallery(mount, apiFor(server), mount.ownerDocument.body);
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "prose",
          title: "Scrub target",
          markdown: "version one text",
        },
      }),
    );
    const id = published.artifact_id as string;
    toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: {
          artifact_id: id,
          type: "prose",
          title: "Scrub target",
          markdown: "version two text",
        },
      }),
    );
    await gallery.init();

    const card = mount.querySelector(`[data-artifact-id="${id}"]`)!;
    expect(card.querySelector("p")!.textContent).toBe("version two text");
    const marker = card.querySelector(".viewing-marker") as HTMLElement;
    expect(marker.hidden).toBe(true);

    (card.querySelector("button.prev") as HTMLButtonElement).click();
    await until(
      () => card.querySelector("p")!.textContent === "version one text",
    );
    expect(gallery.viewingVersion(id)).toBe(1);
    expect(marker.hidden).toBe(false);
    expect(marker.textContent).toBe("viewing v1 of 2");
    expect((card.querySelector("button.prev") as HTMLButtonElement).disabled).toBe(true);

    (card.querySelector("button.next") as HTMLButtonElement).click();
    await until(
      () => card.querySelector("p")!.textContent === "version two text",
    );
    expect(marker.hidden).toBe(true);
  });
});
