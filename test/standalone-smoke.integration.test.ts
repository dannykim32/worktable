// Issue 21, AC-1: the firewall proof. Build the self-contained bundle, move
// node_modules ASIDE, run `node dist/server/index.js`, and hit /api/health with
// the capability token — a 200 proves the server needs only `node` at runtime.
//
// node_modules is ALWAYS restored (finally), even on failure — the rest of the
// suite depends on it. bun runs test files sequentially, so the brief window
// where node_modules is renamed never overlaps another test file.
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverJs = join(repoRoot, "dist", "server", "index.js");
const canvasIndex = join(repoRoot, "dist", "canvas", "index.html");
const nmPath = join(repoRoot, "node_modules");
const asidePath = join(repoRoot, "node_modules.smoke-aside");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ensureStandaloneBuilt(): void {
  if (existsSync(serverJs) && existsSync(canvasIndex)) return;
  const r = spawnSync("bun", ["run", "build:standalone"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (r.status !== 0) throw new Error("build:standalone failed in test setup");
}

// Safety net: if the process dies mid-test, put node_modules back.
afterAll(() => {
  if (existsSync(asidePath) && !existsSync(nmPath)) renameSync(asidePath, nmPath);
});

test(
  "bundled server runs under plain node with node_modules absent",
  async () => {
    ensureStandaloneBuilt();
    const home = mkdtempSync(join(tmpdir(), "vc-smoke-"));
    let child: ChildProcess | undefined;
    let moved = false;
    try {
      renameSync(nmPath, asidePath);
      moved = true;
      expect(existsSync(nmPath)).toBe(false); // truly absent

      // stdin is a live pipe we never close — the server ties its lifecycle to
      // stdin (MCP transport), so an EOF would shut it down immediately.
      child = spawn("node", [serverJs], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, VISUAL_CHAT_NO_OPEN: "1" },
        stdio: ["pipe", "ignore", "pipe"],
      });

      // Wait for the workspace state (port + token) to land on disk.
      const wsRoot = join(home, ".visual-chat");
      let port = "";
      let token = "";
      for (let i = 0; i < 100 && !port; i++) {
        if (existsSync(wsRoot)) {
          const ids = readdirSync(wsRoot);
          if (ids.length) {
            const dir = join(wsRoot, ids[0]!);
            const pf = join(dir, "port");
            const tf = join(dir, "token");
            if (existsSync(pf) && existsSync(tf)) {
              port = readFileSync(pf, "utf8").trim();
              token = readFileSync(tf, "utf8").trim();
            }
          }
        }
        if (!port) await sleep(50);
      }
      expect(port).toBeTruthy();

      // Hit /api/health with the bearer; retry while the listener comes up.
      let status = 0;
      let body = "";
      for (let i = 0; i < 40 && status !== 200; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          status = res.status;
          body = await res.text();
        } catch {
          /* listener not ready yet */
        }
        if (status !== 200) await sleep(50);
      }
      expect(status).toBe(200);
      expect(JSON.parse(body).version).toBeTruthy();
    } finally {
      child?.kill();
      if (moved && existsSync(asidePath) && !existsSync(nmPath)) {
        renameSync(asidePath, nmPath);
      }
    }
  },
  120000,
);
