// Issue 22 integration layer: answer_askback stores the answer + emits SSE +
// returns the record (unknown id → tool error, nothing stored); the answered
// read route is bearer-gated; the closed tool set is exactly 7 and still holds
// the no-self-grant invariant; and answering never changes delivered state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Anchor } from "../src/shared/artifacts.js";
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

async function publishDoc(title: string, text: string): Promise<string> {
  const result = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "prose",
        title,
        markdown: text,
      },
    }),
  );
  return result.artifact_id as string;
}

async function postAskback(anchor: Anchor, question: string): Promise<string> {
  const res = await httpRequest({
    port: server.port,
    path: "/api/askbacks",
    method: "POST",
    headers: { ...bearer(server.token()), "Content-Type": "application/json" },
    body: JSON.stringify({ anchor, question }),
  });
  expect(res.status).toBe(201);
  return (JSON.parse(res.body) as { id: string }).id;
}

function answered(): Promise<{
  askbacks: Array<{
    id: string;
    question: string;
    anchor: Anchor;
    answer: { text: string; answered_at: string };
  }>;
}> {
  return httpRequest({
    port: server.port,
    path: "/api/askbacks/answered",
    headers: bearer(server.token()),
  }).then((r) => JSON.parse(r.body));
}

describe("answer_askback (issue 22)", () => {
  test("stores the answer, emits SSE, returns the record; loop stays pending", async () => {
    const id = await publishDoc("Answerable", "select me and ask");
    const anchor: Anchor = {
      artifact_id: id,
      version: 1,
      block_index: 0,
      char_start: 0,
      char_end: 9,
      quote: "select me",
    };
    const askbackId = await postAskback(anchor, "what does this mean?");

    const sse = await openSse(server.port, server.token());
    try {
      const record = toolJson(
        await server.client.callTool({
          name: "answer_askback",
          arguments: {
            askback_id: askbackId,
            answer: "it means the selection is anchored to this artifact.",
          },
        }),
      ) as {
        id: string;
        anchor: Anchor;
        question: string;
        answer: { text: string; answered_at: string };
      };
      // The returned record carries the stored answer.
      expect(record.id).toBe(askbackId);
      expect(record.question).toBe("what does this mean?");
      expect(record.answer.text).toContain("anchored to this artifact");
      expect(typeof record.answer.answered_at).toBe("string");

      // SSE askback_answered carries the ids the canvas needs to re-anchor.
      const frame = await sse.waitFor(
        "askback_answered",
        2000,
        (f) => (f.data as { askback_id: string }).askback_id === askbackId,
      );
      const data = frame.data as {
        askback_id: string;
        artifact_id: string;
        version: number;
      };
      expect(data.artifact_id).toBe(id);
      expect(data.version).toBe(1);
    } finally {
      sse.close();
    }

    // The answered read route returns the item (id + anchor + question + answer).
    const list = await answered();
    const item = list.askbacks.find((a) => a.id === askbackId)!;
    expect(item.question).toBe("what does this mean?");
    expect(item.anchor.artifact_id).toBe(id);
    expect(item.answer.text).toContain("anchored to this artifact");

    // Answering does NOT deliver the ask-back: it is still pending, and
    // check_askbacks (the only delivery path) still drains it (AC7 regression).
    const peek = await httpRequest({
      port: server.port,
      path: "/api/askbacks/pending",
      headers: bearer(server.token()),
    });
    const pending = (JSON.parse(peek.body) as { askbacks: Array<{ id: string }> })
      .askbacks;
    expect(pending.some((a) => a.id === askbackId)).toBe(true);
    const drained = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as { askbacks: Array<{ id: string }> };
    expect(drained.askbacks.some((a) => a.id === askbackId)).toBe(true);
  });

  test("unknown id → tool error, nothing stored", async () => {
    const before = (await answered()).askbacks.length;
    const res = (await server.client.callTool({
      name: "answer_askback",
      arguments: { askback_id: "ab_deadbeef", answer: "into the void" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("unknown ask-back");
    // The answered set did not grow.
    expect((await answered()).askbacks.length).toBe(before);
  });

  test("empty answer → tool error", async () => {
    const id = await publishDoc("Blank", "x");
    const askbackId = await postAskback(
      { artifact_id: id, version: 1, block_index: null, quote: "Blank" },
      "anything?",
    );
    const res = (await server.client.callTool({
      name: "answer_askback",
      arguments: { askback_id: askbackId, answer: "   " },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  test("the answered read route is bearer-gated (401 without token)", async () => {
    const noAuth = await httpRequest({
      port: server.port,
      path: "/api/askbacks/answered",
    });
    expect(noAuth.status).toBe(401);
  });

  test("listTools() is exactly 8 and answer_askback is not a gate/config surface", async () => {
    const { tools } = await server.client.listTools();
    expect(tools).toHaveLength(8); // +list_artifacts (dupe-avoidance read, 0.5.4)
    expect(tools.map((t) => t.name)).toContain("answer_askback");
    expect(tools.map((t) => t.name)).toContain("list_artifacts");
    // The no-self-grant invariant (issue 12) is untouched: no tool arms the gate.
    for (const t of tools) {
      expect(t.name).not.toMatch(/gate|config|mode|enforce|setting/i);
    }
  });
});
