// Paste-an-image integration layer over a real spawned server: the upload
// route's auth/sniff/size gates, the serve route's stored-mime + inline
// delivery, image_id threading through POST /api/askbacks and the read routes,
// and check_askbacks delivering the bytes to the model as a REAL MCP image
// block (the _mcpContent passthrough) — while image-free drains keep the
// plain JSON-in-one-text-block shape.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bearer,
  ensureCanvasBuilt,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";
import { IMAGE_MAX_BYTES } from "../src/shared/constraints.js";

let server: SpawnedServer;
let artifactId: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("worktable-test-png-payload"),
]);

beforeAll(async () => {
  ensureCanvasBuilt();
  server = await spawnServer();
  const published = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "prose",
        title: "Image doc",
        markdown: "a paragraph to anchor image questions to",
      },
    }),
  );
  artifactId = published.artifact_id as string;
}, 30_000);

afterAll(async () => {
  await server?.close();
});

function uploadUrl(): string {
  return `http://127.0.0.1:${server.port}/api/askbacks/image`;
}

async function uploadImage(
  body: BodyInit,
  opts: { auth?: boolean; contentType?: string } = {},
): Promise<Response> {
  return fetch(uploadUrl(), {
    method: "POST",
    headers: {
      ...(opts.auth === false ? {} : bearer(server.token())),
      "Content-Type": opts.contentType ?? "application/octet-stream",
    },
    body,
  });
}

function anchorFor(quote: string) {
  return { artifact_id: artifactId, version: 1, block_index: null, quote };
}

async function postAskback(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/askbacks`, {
    method: "POST",
    headers: { ...bearer(server.token()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

describe("ask-back image upload + serve routes", () => {
  test("upload: 401 without bearer; 415 for a non-image (declared png, actually html); 413 oversize stores nothing", async () => {
    expect((await uploadImage(PNG, { auth: false })).status).toBe(401);

    // The declared Content-Type says png; the bytes say HTML. The sniff wins.
    const smuggled = await uploadImage(
      Buffer.from("<html><script>alert(1)</script></html>"),
      { contentType: "image/png" },
    );
    expect(smuggled.status).toBe(415);
    expect(((await smuggled.json()) as { error: string }).error).toContain(
      "not a supported image",
    );

    const oversize = await uploadImage(
      Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]),
    );
    expect(oversize.status).toBe(413);
  });

  test("upload a real png → 200 {image_id, mime, bytes}; serve returns the STORED sniffed mime inline", async () => {
    const res = await uploadImage(PNG);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as {
      image_id: string;
      mime: string;
      bytes: number;
    };
    expect(saved.image_id).toMatch(/^[0-9a-f]{32}$/);
    expect(saved.mime).toBe("image/png");
    expect(saved.bytes).toBe(PNG.length);

    const serveUrl = `http://127.0.0.1:${server.port}/api/askbacks/image/${saved.image_id}`;
    // Bearer-gated like every /api route — no query-token exception.
    expect((await fetch(serveUrl)).status).toBe(401);
    const served = await fetch(serveUrl, { headers: bearer(server.token()) });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    // Unknown/malformed ids 404 (regex-gated before any path is built).
    const bad = await fetch(
      `http://127.0.0.1:${server.port}/api/askbacks/image/deadbeef`,
      { headers: bearer(server.token()) },
    );
    expect(bad.status).toBe(404);
    const unknown = await fetch(
      `http://127.0.0.1:${server.port}/api/askbacks/image/${"0".repeat(32)}`,
      { headers: bearer(server.token()) },
    );
    expect(unknown.status).toBe(404);
  });
});

describe("image_id through the ask-back loop", () => {
  test("POST with a stored image_id → pending route carries it → check_askbacks returns an MCP image block", async () => {
    const saved = (await (await uploadImage(PNG)).json()) as {
      image_id: string;
    };
    const posted = await postAskback({
      anchor: anchorFor("a paragraph"),
      question: "what is wrong in this screenshot?",
      image_id: saved.image_id,
    });
    expect(posted.status).toBe(201);

    // The read-only peek carries image_id so a reloaded drawer can refetch.
    const pending = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/askbacks/pending`, {
        headers: bearer(server.token()),
      })
    ).json()) as { askbacks: Array<{ image_id?: string }> };
    expect(pending.askbacks.some((a) => a.image_id === saved.image_id)).toBe(
      true,
    );

    const result = (await server.client.callTool({
      name: "check_askbacks",
      arguments: {},
    })) as { isError?: boolean; content: ContentBlock[] };
    expect(result.isError).toBeFalsy();
    // Passthrough shape: text block first, then one image block per
    // image-bearing ask-back.
    expect(result.content.length).toBe(2);
    expect(result.content[0]!.type).toBe("text");
    const payload = JSON.parse(result.content[0]!.text!) as {
      askbacks: Array<{ id: string; image_id?: string; image?: string }>;
    };
    const item = payload.askbacks.find(
      (a) => a.image_id === saved.image_id,
    )!;
    expect(item.image).toBe("attached below"); // correlation marker
    const imageBlock = result.content[1]!;
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.mimeType).toBe("image/png");
    expect(imageBlock.data).toBe(PNG.toString("base64"));

    // Answer it: the answered read route carries image_id too.
    toolJson(
      await server.client.callTool({
        name: "answer_askback",
        arguments: { askback_id: item.id, answer: "the header is clipped" },
      }),
    );
    const answered = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/askbacks/answered`, {
        headers: bearer(server.token()),
      })
    ).json()) as { askbacks: Array<{ id: string; image_id?: string }> };
    expect(
      answered.askbacks.find((a) => a.id === item.id)!.image_id,
    ).toBe(saved.image_id);
  }, 15_000);

  test("an image-free ask-back keeps the plain JSON-wrapped shape (one text block, no image keys)", async () => {
    const posted = await postAskback({
      anchor: anchorFor("a paragraph"),
      question: "no image here",
    });
    expect(posted.status).toBe(201);
    const result = (await server.client.callTool({
      name: "check_askbacks",
      arguments: {},
    })) as { content: ContentBlock[] };
    expect(result.content.length).toBe(1);
    expect(result.content[0]!.type).toBe("text");
    const payload = JSON.parse(result.content[0]!.text!) as {
      askbacks: Array<Record<string, unknown>>;
    };
    const item = payload.askbacks.find((a) => a.question === "no image here")!;
    expect("image_id" in item).toBe(false);
    expect("image" in item).toBe(false);
  });

  test("a well-formed but unknown image_id is a 400, and a malformed one too (reject-not-drop)", async () => {
    const unknown = await postAskback({
      anchor: anchorFor("a paragraph"),
      question: "phantom image",
      image_id: "f".repeat(32),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain(
      "unknown image",
    );
    const malformed = await postAskback({
      anchor: anchorFor("a paragraph"),
      question: "traversal image",
      image_id: "../../etc/passwd",
    });
    expect(malformed.status).toBe(400);
  });
});
