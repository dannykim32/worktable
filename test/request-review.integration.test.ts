// Issue 14: request_review — the blocking Review Moment tool. Exercised over
// real stdio MCP + HTTP. The timeout floor is lowered to 1s via
// VISUAL_CHAT_REVIEW_MIN_S so the timeout path runs fast. Covers approval,
// anchored-question, timeout (nothing lost), cross-artifact isolation,
// concurrency, and the SSE review banner lifecycle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Anchor } from "../src/shared/artifacts.js";
import {
  bearer,
  httpRequest,
  openSse,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

let server: SpawnedServer;

beforeAll(async () => {
  server = await spawnServer({ env: { VISUAL_CHAT_REVIEW_MIN_S: "1" } });
}, 30_000);

afterAll(async () => {
  await server?.close();
});

async function publishDoc(title: string): Promise<string> {
  const result = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "document",
        title,
        blocks: [{ kind: "paragraph", text: "review me please" }],
      },
    }),
  );
  return result.artifact_id as string;
}

function requestReview(
  artifactId: string,
  timeoutS: number,
): Promise<Record<string, unknown>> {
  return server.client
    .callTool({
      name: "request_review",
      arguments: { artifact_id: artifactId, timeout_s: timeoutS },
    })
    .then((r) => toolJson(r));
}

function postAskback(
  anchor: Anchor,
  question: string,
  kind?: "question" | "approval",
): Promise<{ status: number }> {
  return httpRequest({
    port: server.port,
    path: "/api/askbacks",
    method: "POST",
    headers: { ...bearer(server.token()), "Content-Type": "application/json" },
    body: JSON.stringify(kind ? { anchor, question, kind } : { anchor, question }),
  });
}

/** Drain the queue so each test inspects a clean slate. */
async function drain(): Promise<void> {
  await server.client.callTool({ name: "check_askbacks", arguments: {} });
}

function matchesArtifact(id: string) {
  return (f: { data: unknown }) =>
    (f.data as { artifact_id: string }).artifact_id === id;
}

describe("request_review", () => {
  test("approve click resolves the blocked call with {approved:true}", async () => {
    await drain();
    const id = await publishDoc("Approve me");
    const sse = await openSse(server.port, server.token());
    try {
      const pending = requestReview(id, 10);
      await sse.waitFor("review_requested", 3000, matchesArtifact(id));

      const t0 = Date.now();
      const posted = await postAskback(
        { artifact_id: id, version: 1, block_index: null, quote: "Approve me" },
        "",
        "approval",
      );
      expect(posted.status).toBe(201);

      const result = await pending;
      expect(result).toEqual({ approved: true });
      expect(Date.now() - t0).toBeLessThan(1000);

      await sse.waitFor("review_resolved", 3000, matchesArtifact(id));

      // The approval was consumed — it does not resurface via check_askbacks.
      const check = toolJson(
        await server.client.callTool({ name: "check_askbacks", arguments: {} }),
      ) as { askbacks: Array<{ anchor: Anchor }> };
      expect(check.askbacks.some((a) => a.anchor.artifact_id === id)).toBe(false);
    } finally {
      sse.close();
    }
  }, 20_000);

  test("anchored question resolves with the question + anchor; marked delivered", async () => {
    await drain();
    const id = await publishDoc("Question me");
    const sse = await openSse(server.port, server.token());
    try {
      const pending = requestReview(id, 10);
      await sse.waitFor("review_requested", 3000, matchesArtifact(id));

      await postAskback(
        {
          artifact_id: id,
          version: 1,
          block_index: 0,
          char_start: 0,
          char_end: 6,
          quote: "review",
        },
        "should this be bolder?",
      );

      const result = (await pending) as {
        askback?: { question: string; quote: string; anchor: Anchor };
      };
      expect(result.askback?.question).toBe("should this be bolder?");
      expect(result.askback?.quote).toBe("review");
      expect(result.askback?.anchor.artifact_id).toBe(id);
      expect(result.askback?.anchor.block_index).toBe(0);

      // Marked delivered: check_askbacks does not return it again.
      const check = toolJson(
        await server.client.callTool({ name: "check_askbacks", arguments: {} }),
      ) as { askbacks: Array<{ anchor: Anchor }> };
      expect(check.askbacks.some((a) => a.anchor.artifact_id === id)).toBe(false);
    } finally {
      sse.close();
    }
  }, 20_000);

  test("timeout returns {timed_out:true}; later feedback still reaches check_askbacks", async () => {
    await drain();
    const id = await publishDoc("Nobody answers");
    const sse = await openSse(server.port, server.token());
    try {
      const result = await requestReview(id, 1);
      expect(result.timed_out).toBe(true);
      expect(typeof result.hint).toBe("string");

      // Banner cleared on timeout too.
      await sse.waitFor("review_resolved", 3000, matchesArtifact(id));

      // Feedback submitted AFTER the timeout is not lost.
      await postAskback(
        { artifact_id: id, version: 1, block_index: null, quote: "Nobody answers" },
        "late but here",
      );
      const check = toolJson(
        await server.client.callTool({ name: "check_askbacks", arguments: {} }),
      ) as { askbacks: Array<{ question: string; anchor: Anchor }> };
      expect(
        check.askbacks.find((a) => a.anchor.artifact_id === id)?.question,
      ).toBe("late but here");
    } finally {
      sse.close();
    }
  }, 20_000);

  test("an ask-back on a DIFFERENT artifact does not resolve the wait (stays queued)", async () => {
    await drain();
    const target = await publishDoc("Waiting target");
    const other = await publishDoc("Unrelated");
    const sse = await openSse(server.port, server.token());
    try {
      const pending = requestReview(target, 1);
      await sse.waitFor("review_requested", 3000, matchesArtifact(target));

      // Feedback lands on the OTHER artifact — must not resolve `target`.
      await postAskback(
        { artifact_id: other, version: 1, block_index: null, quote: "Unrelated" },
        "about the other one",
      );

      const result = await pending;
      expect(result.timed_out).toBe(true);

      // The unrelated ask-back is still queued for the next check_askbacks.
      const check = toolJson(
        await server.client.callTool({ name: "check_askbacks", arguments: {} }),
      ) as { askbacks: Array<{ question: string; anchor: Anchor }> };
      expect(
        check.askbacks.find((a) => a.anchor.artifact_id === other)?.question,
      ).toBe("about the other one");
    } finally {
      sse.close();
    }
  }, 20_000);

  test("two concurrent request_reviews on different artifacts resolve independently", async () => {
    await drain();
    const a = await publishDoc("Concurrent A");
    const b = await publishDoc("Concurrent B");
    const sse = await openSse(server.port, server.token());
    try {
      const pa = requestReview(a, 10);
      const pb = requestReview(b, 10);
      await sse.waitFor("review_requested", 3000, matchesArtifact(a));
      await sse.waitFor("review_requested", 3000, matchesArtifact(b));

      // Approve A; send an anchored question to B.
      await postAskback(
        { artifact_id: a, version: 1, block_index: null, quote: "Concurrent A" },
        "",
        "approval",
      );
      await postAskback(
        { artifact_id: b, version: 1, block_index: null, quote: "Concurrent B" },
        "tighten B?",
      );

      const [ra, rb] = await Promise.all([pa, pb]);
      expect(ra).toEqual({ approved: true });
      const rbTyped = rb as { askback?: { question: string; anchor: Anchor } };
      expect(rbTyped.askback?.question).toBe("tighten B?");
      expect(rbTyped.askback?.anchor.artifact_id).toBe(b);
    } finally {
      sse.close();
    }
  }, 20_000);

  test("banner lifecycle: review_requested then review_resolved both carry the artifact_id", async () => {
    await drain();
    const id = await publishDoc("Banner artifact");
    const sse = await openSse(server.port, server.token());
    try {
      const pending = requestReview(id, 10);
      const requested = await sse.waitFor(
        "review_requested",
        3000,
        matchesArtifact(id),
      );
      expect((requested.data as { artifact_id: string }).artifact_id).toBe(id);

      await postAskback(
        { artifact_id: id, version: 1, block_index: null, quote: "Banner artifact" },
        "",
        "approval",
      );
      await pending;

      const resolved = await sse.waitFor(
        "review_resolved",
        3000,
        matchesArtifact(id),
      );
      expect((resolved.data as { artifact_id: string }).artifact_id).toBe(id);
    } finally {
      sse.close();
    }
  }, 20_000);
});
