// Package a firewall-friendly release: build the self-contained bundle and tar the
// runnable subset (dist/ + register helper + docs) so a machine with NO npm/bun can
// download, extract, and run with only `node`. Plain Node ESM, zero deps.
//   node scripts/package-release.mjs   →   dist-release/visual-chat-<version>.tar.gz
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const root = `visual-chat-${version}`;
const outDir = join(repo, "dist-release");
const stage = join(outDir, root);
const tarball = join(outDir, `${root}.tar.gz`);

console.log(`Packaging visual-chat v${version}…`);

// 1. Build the self-contained bundle (server+version inlined, canvas, hook).
console.log("  building standalone bundle…");
execFileSync("node", [join(repo, "scripts", "build-standalone.mjs")], { cwd: repo, stdio: "inherit" });
if (!existsSync(join(repo, "dist", "server", "index.js"))) throw new Error("build produced no dist/server/index.js");

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
// a dead-simple quickstart at the root of the tarball
const quickstart = `# visual-chat v${version} — install (no npm needed)

Runtime: just \`node\`. This tarball is the self-contained bundle.

1. Extract it anywhere:  tar xzf ${root}.tar.gz
2. Register into a project (writes its .mcp.json, no network):
     node ${root}/scripts/register.mjs /path/to/your/project --guidance
   (add --hook for Claude Code ask-back auto-inject; --print-codex for the Codex snippet)
3. Or register for EVERY Claude Code session (user scope):
     claude mcp add -s user visual-chat -- node "$(pwd)/${root}/dist/server/index.js"
4. Restart Claude Code. See docs/install.md for the full walkthrough.
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
