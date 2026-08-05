// Build the self-contained dist/ that runs on `node` alone (issue 21).
// Orchestrated in Node so the version can be read from package.json and passed
// to `bun build --define` as a proper argv element — no shell-quoting games.
//
//   dist/canvas/      — vite build (static assets)
//   dist/server/index.js — server bundle; @modelcontextprotocol/sdk + all imports
//                          inlined, node:* external, VERSION inlined at build time
//                          so the bundle never reads package.json at runtime.
//   dist/hooks/askback-hook.js — the Claude Code ask-back hook, bundled the same way.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, args) {
  process.stdout.write(`\n$ ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`build:standalone failed at: ${cmd} ${args[0]}\n`);
    process.exit(r.status ?? 1);
  }
}

run("bun", ["x", "vite", "build", "--config", "src/canvas/vite.config.ts"]);
run("bun", [
  "build",
  "src/server/index.ts",
  "--target=node",
  // Inline the version as a JS string literal at build time.
  "--define",
  `WORKTABLE_VERSION="${version}"`,
  "--outfile=dist/server/index.js",
]);
run("bun", [
  "build",
  "hooks/askback-hook.ts",
  "--target=node",
  "--outfile=dist/hooks/askback-hook.js",
]);

process.stdout.write(`\n✓ standalone dist/ built (version ${version})\n`);
