// Issue 21, AC-1: the firewall proof, done the truly-self-contained way. Build
// the standalone bundle, then copy ONLY dist/ into a scratch dir that has NO
// package.json, NO node_modules and NO source — the exact firewalled-transfer
// shape — and run `node dist/server/index.js` there. A /api/health 200 proves
// the bundle needs nothing but `node`: not node_modules, not package.json.
//
// This catches the regression class where the server reads package.json (or any
// repo file) at runtime — from a dist-only copy that file is absent, so such a
// read would ENOENT before serving. The repo's own node_modules is never touched.
import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "dist");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Always rebuild the bundle so the test proves THIS commit's dist, never a stale
// pre-fix bundle sitting on disk.
function buildStandalone(): void {
  const r = spawnSync("bun", ["run", "build:standalone"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (r.status !== 0) throw new Error("build:standalone failed in test setup");
}

test(
  "bundle runs from a dist-only copy — no package.json, no node_modules",
  async () => {
    buildStandalone();

    // The firewalled transfer: a scratch dir containing ONLY dist/.
    const scratch = mkdtempSync(join(tmpdir(), "vc-distonly-"));
    const home = mkdtempSync(join(tmpdir(), "vc-smoke-home-"));
    cpSync(distDir, join(scratch, "dist"), { recursive: true });

    // Prove the scratch really lacks the things a firewalled machine won't have.
    expect(existsSync(join(scratch, "package.json"))).toBe(false);
    expect(existsSync(join(scratch, "node_modules"))).toBe(false);
    expect(existsSync(join(scratch, "src"))).toBe(false);
    expect(existsSync(join(scratch, "dist", "server", "index.js"))).toBe(true);

    let child: ChildProcess | undefined;
    try {
      // cwd = scratch: node resolves module lookups from here, where no
      // node_modules exists (nor in any parent within the temp tree). stdin is a
      // live pipe we never close — an EOF would trip the server's shutdown.
      child = spawn("node", ["dist/server/index.js"], {
        cwd: scratch,
        env: { ...process.env, HOME: home, WORKTABLE_NO_OPEN: "1" },
        stdio: ["pipe", "ignore", "pipe"],
      });

      const wsRoot = join(home, ".worktable");
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
      // Version came from the build-time define, not a package.json read.
      const parsed = JSON.parse(body) as { version?: string };
      expect(parsed.version).toBe(
        JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
      );
    } finally {
      child?.kill();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  120000,
);
