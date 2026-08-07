// Package a firewall-friendly release: build the self-contained bundle and tar the
// runnable subset (dist/ + register helper + docs) so a machine with NO npm/bun can
// download, extract, and run with only `node`. Plain Node ESM, zero deps.
//   node scripts/package-release.mjs   →   dist-release/worktable-<version>.tar.gz
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBundle } from "./build-bundle.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const root = `worktable-${version}`;
const outDir = join(repo, "dist-release");
const stage = join(outDir, root);
const tarball = join(outDir, `${root}.tar.gz`);

console.log(`Packaging worktable v${version}…`);

// 1. Build the self-contained bundle (server+version inlined, canvas, hook).
console.log("  building standalone bundle…");
execFileSync("node", [join(repo, "scripts", "build-standalone.mjs")], { cwd: repo, stdio: "inherit" });
if (!existsSync(join(repo, "dist", "server", "index.js"))) throw new Error("build produced no dist/server/index.js");

// 1a. Refresh the COMMITTED plugin bundle/ from the SAME dist/ we just built, so
// the Claude Code plugin and this tarball ship byte-identical runtime each version.
// (Commit the updated bundle/ alongside the release.)
console.log("  syncing committed plugin bundle/…");
syncBundle(repo);

// 1b. Publish-smoke the built bundle over REAL MCP. A bundle can START cleanly
// yet reject artifacts (schema shape / validator drift — exactly the 0.2.1 bug,
// where a top-level oneOf made the model emit the wrong type). Catch that HERE,
// before a tarball ships. Publishes one of each free-form type the way a model
// would (type + its own field); any rejection aborts the release.
console.log("  smoke-testing publish over MCP…");
await (async () => {
  const srv = spawn("node", [join(repo, "dist", "server", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WORKTABLE_NO_OPEN: "1" },
  });
  let buf = "";
  const pending = [];
  srv.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { try { pending.push(JSON.parse(line)); } catch { /* non-JSON log */ } }
    }
  });
  const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
  const wait = (id, ms = 8000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        const m = pending.find((p) => p.id === id);
        if (m) { clearInterval(t); res(m); }
        else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`MCP timeout waiting for id ${id}`)); }
      }, 20);
    });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-smoke", version: "1" } } });
    await wait(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const cases = [
      { type: "html", title: "smoke", html: "<h1>ok</h1>" },
      { type: "prose", title: "smoke", markdown: "# ok" },
    ];
    let id = 2;
    for (const args of cases) {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "publish_artifact", arguments: args } });
      const r = await wait(id);
      const text = r.result?.content?.map((c) => c.text).join(" ") ?? JSON.stringify(r.result ?? r.error);
      if (r.result?.isError || !/artifact_id/.test(text)) {
        throw new Error(`publish smoke FAILED for type=${args.type}: ${String(text).slice(0, 200)}`);
      }
      id++;
    }
    console.log("    ✓ html, prose all publish through the bundle");
  } finally {
    srv.kill();
  }
})();

// 2. Stage the RUNTIME subset (what a firewalled machine needs — no source, no node_modules).
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(repo, "dist"), join(stage, "dist"), { recursive: true });
mkdirSync(join(stage, "scripts"), { recursive: true });
cpSync(join(repo, "scripts", "register.mjs"), join(stage, "scripts", "register.mjs"));
mkdirSync(join(stage, "docs"), { recursive: true });
for (const d of ["install.md", "agent-guidance.md"]) {
  const src = join(repo, "docs", d);
  if (existsSync(src)) cpSync(src, join(stage, "docs", d));
}
cpSync(join(repo, "README.md"), join(stage, "README.md"));
// One-command installer at the tarball root (executable).
cpSync(join(repo, "install.sh"), join(stage, "install.sh"));
const { chmodSync } = await import("node:fs");
chmodSync(join(stage, "install.sh"), 0o755);
// a dead-simple quickstart at the root of the tarball
const quickstart = `# worktable v${version} — install (no npm, no network needed)

Runtime: just \`node\`. This tarball is the self-contained bundle.

EASIEST — one command (registers for every Claude Code session):

  tar xzf ${root}.tar.gz
  cd ${root}
  ./install.sh                      # + a repo path to also wire that project:
  ./install.sh /path/to/your/repo   #   ./install.sh ~/code/myproject

Then restart Claude Code and run  /mcp  — 'worktable' should be connected.

Manual alternatives (if you prefer): see docs/install.md — per-repo
register.mjs, the raw \`claude mcp add\` command, and the Codex snippet.
`;
const { writeFileSync } = await import("node:fs");
writeFileSync(join(stage, "INSTALL.txt"), quickstart);

// 3. Tar it (system tar; this runs on the build machine, not the firewalled one).
console.log("  tarring…");
execFileSync("tar", ["czf", tarball, "-C", outDir, root], { cwd: repo, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

const bytes = readFileSync(tarball).length;
console.log(`\n  → ${tarball}  (${(bytes / 1024).toFixed(0)} KB)`);
console.log(`  runtime needs only node. Attach this to a GitHub release:`);
console.log(`    gh release create v${version} "${tarball}" --title "v${version}" --notes "Self-contained bundle; node-only runtime."`);
