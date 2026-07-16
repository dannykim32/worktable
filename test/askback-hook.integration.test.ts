// Issue 13: the Claude Code UserPromptSubmit hook, exercised as a real
// subprocess against a live Canvas Server. Asserts the four scenarios
// (pending / empty / server-down / missing-files) and the hard invariant that
// the hook is a READ-ONLY peek — running it N times never marks an ask-back
// delivered (only check_askbacks does).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "../src/shared/artifacts.js";
import {
  bearer,
  httpRequest,
  repoRoot,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

const hookEntry = join(repoRoot, "hooks", "askback-hook.ts");

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run the hook exactly as Claude Code would: a fresh subprocess whose cwd is
 *  the workspace (repoRoot here, so its id matches the spawned server) and whose
 *  HOME points at the isolated state dir. */
function runHook(home: string, cwd: string = repoRoot): HookRun {
  const start = Date.now();
  const r = spawnSync("bun", [hookEntry], {
    cwd,
    env: { ...(process.env as Record<string, string>), HOME: home },
    encoding: "utf8",
  });
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ms: Date.now() - start,
  };
}

async function publishDoc(
  server: SpawnedServer,
  title: string,
  text: string,
): Promise<string> {
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

function postAskback(
  server: SpawnedServer,
  anchor: Anchor,
  question: string,
): Promise<{ status: number }> {
  return httpRequest({
    port: server.port,
    path: "/api/askbacks",
    method: "POST",
    headers: { ...bearer(server.token()), "Content-Type": "application/json" },
    body: JSON.stringify({ anchor, question }),
  });
}

let server: SpawnedServer;

beforeAll(async () => {
  server = await spawnServer();
  // Warm bun's transpile cache so the <400ms server-down measurement below
  // reflects the hook's real cost, not a one-time cold compile.
  runHook(mkdtempSync(join(tmpdir(), "vc-hook-warm-")));
}, 30_000);

afterAll(async () => {
  await server?.close();
});

describe("askback hook", () => {
  test("pending ask-backs → additionalContext with question + quote + title", async () => {
    const id = await publishDoc(server, "Hook Doc", "select me and ask");
    const posted = await postAskback(
      server,
      {
        artifact_id: id,
        version: 1,
        block_index: 0,
        char_start: 0,
        char_end: 9,
        quote: "select me",
      },
      "what does this mean?",
    );
    expect(posted.status).toBe(201);

    const run = runHook(server.home);
    expect(run.code).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx = payload.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("what does this mean?");
    expect(ctx).toContain("select me");
    expect(ctx).toContain("Hook Doc");
    expect(ctx).toContain("check_askbacks");

    // Leave the queue clean for the next tests (this marks it delivered).
    await server.client.callTool({ name: "check_askbacks", arguments: {} });
  });

  test("read-only peek: 10 hook runs never mark an ask-back delivered", async () => {
    const id = await publishDoc(server, "Peek Doc", "still pending after peeks");
    await postAskback(
      server,
      { artifact_id: id, version: 1, block_index: null, quote: "Peek Doc" },
      "am I still here?",
    );

    for (let i = 0; i < 10; i++) {
      const run = runHook(server.home);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("am I still here?");
      // The peek route must still report it pending after every run.
      const peek = await httpRequest({
        port: server.port,
        path: "/api/askbacks/pending",
        headers: bearer(server.token()),
      });
      const pending = (JSON.parse(peek.body) as { askbacks: unknown[] }).askbacks;
      expect(pending.length).toBeGreaterThanOrEqual(1);
    }

    // Only check_askbacks marks delivery — proof the peeks were non-destructive.
    const drained = toolJson(
      await server.client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as { askbacks: Array<{ question: string }> };
    expect(drained.askbacks.some((a) => a.question === "am I still here?")).toBe(
      true,
    );
    // And now it is gone.
    const after = await httpRequest({
      port: server.port,
      path: "/api/askbacks/pending",
      headers: bearer(server.token()),
    });
    expect((JSON.parse(after.body) as { askbacks: unknown[] }).askbacks).toHaveLength(
      0,
    );
  });

  test("no pending ask-backs → empty output, exit 0", () => {
    const run = runHook(server.home);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("");
  });

  test("server down (files present) → exit 0, empty output, <400ms", async () => {
    // Fresh server so closing it does not disturb the shared one.
    const doomed = await spawnServer();
    const home = doomed.home;
    await doomed.close();
    // port + token files remain, but nothing is listening.
    const run = runHook(home);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("");
    expect(run.ms).toBeLessThan(400);
  }, 20_000);

  test("missing port/token files → exit 0 silently", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "vc-hook-empty-"));
    const run = runHook(emptyHome);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("");
  });
});
