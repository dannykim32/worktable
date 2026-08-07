// Regression tests for two lifecycle defects:
//   1. update_artifact was a visual no-op when the human had closed the tab
//      (broadcast to zero SSE clients) — nothing showed on session resume.
//   2. the local HTTP servers only tore down on stdin EOF, so a signalled /
//      orphaned process left "localhost still up" after the session ended.
import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSse,
  repoRoot,
  serverEntry,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

const HTML = { type: "html", title: "T", html: "<p>hi</p>" };

function opensLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wt-opens-")), "opens.log");
}
function openCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
}

describe("canvas auto-open lifecycle", () => {
  let server: SpawnedServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("auto-opens on publish AND on update when no tab is watching", async () => {
    // The resume bug: with the tab closed there are zero SSE clients, so before
    // the fix an update broadcast reached no one. Now both publish and update
    // open the canvas when the room is empty. Debounce 0 so the two opens count.
    const log = opensLogPath();
    server = await spawnServer({
      env: { WORKTABLE_OPEN_LOG: log, WORKTABLE_AUTO_OPEN_DEBOUNCE_MS: "0" },
    });

    const pub = toolJson(
      await server.client.callTool({ name: "publish_artifact", arguments: HTML }),
    );
    expect(openCount(log)).toBe(1); // first publish opened into an empty room

    const upd = toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: { artifact_id: pub.artifact_id, ...HTML },
      }),
    );
    expect(upd.version).toBe(2); // update actually applied
    expect(openCount(log)).toBe(2); // update re-opened — the regression
  });

  it("does NOT open when a tab is already connected", async () => {
    const log = opensLogPath();
    server = await spawnServer({
      env: { WORKTABLE_OPEN_LOG: log, WORKTABLE_AUTO_OPEN_DEBOUNCE_MS: "0" },
    });
    const sse = await openSse(server.port, server.token()); // clientCount -> 1
    try {
      const pub = toolJson(
        await server.client.callTool({
          name: "publish_artifact",
          arguments: HTML,
        }),
      );
      await server.client.callTool({
        name: "update_artifact",
        arguments: { artifact_id: pub.artifact_id, ...HTML },
      });
      // A live tab reconnects and receives the SSE events itself — no new tab.
      expect(openCount(log)).toBe(0);
    } finally {
      sse.close();
    }
  });
});

describe("server teardown on signal", () => {
  it("shuts down gracefully on SIGTERM (frees the local ports)", async () => {
    const home = mkdtempSync(join(tmpdir(), "wt-sig-"));
    const child = spawn("bun", [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WORKTABLE_NO_OPEN: "1" },
      stdio: ["pipe", "ignore", "ignore"],
    });

    // Wait for boot: the server writes <home>/.worktable/<id>/port once bound.
    const wsRoot = join(home, ".worktable");
    const booted = await Promise.race([
      (async () => {
        for (;;) {
          if (existsSync(wsRoot)) {
            const ids = readdirSync(wsRoot);
            if (ids[0] && existsSync(join(wsRoot, ids[0], "port"))) return true;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      })(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
    ]);
    expect(booted).toBe(true);

    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<{ code: number | null; signal: string | null }>((r) =>
        setTimeout(() => r({ code: -1, signal: "timeout" }), 5000),
      ),
    ]);

    // The graceful handler runs process.exit(0). Without it, the default SIGTERM
    // action would kill the process with signal "SIGTERM" and a null exit code.
    expect(result.code).toBe(0);
  });
});
