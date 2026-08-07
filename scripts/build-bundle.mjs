// Build the COMMITTED bundle/ that makes the Claude Code plugin self-contained
// after a plain `git clone` (dist/ is gitignored, so the plugin can't ship from
// it). bundle/ mirrors the runnable subset of dist/ EXACTLY — same bytes — so the
// plugin and the firewall tarball run identical code each version.
//
//   node scripts/build-bundle.mjs         build dist/ (standalone), then sync bundle/
//   import { syncBundle } from "..."       reuse an already-built dist/ (package:release)
//
// The server resolves its canvas + listener CLI as SIBLINGS of its own dir
// (src/server/index.ts), so this layout — bundle/server, bundle/hooks,
// bundle/canvas — works untouched: from bundle/server/index.js, ../canvas and
// ../hooks resolve inside bundle/.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The runnable subset the plugin needs, mirroring the dist/ layout.
const BUNDLE_FILES = [
  ["server/index.js", "file"],
  ["hooks/askback-hook.js", "file"],
  ["hooks/await-askback.js", "file"],
  ["canvas", "dir"],
];

/** Copy the runnable subset of dist/ into a fresh bundle/ (same bytes). Assumes
 *  dist/ is already built. Returns the bundle dir path. */
export function syncBundle(root = repoRoot) {
  const dist = join(root, "dist");
  const bundle = join(root, "bundle");
  for (const [rel] of BUNDLE_FILES) {
    if (!existsSync(join(dist, rel))) {
      throw new Error(
        `build-bundle: dist/${rel} is missing — run the standalone build first`,
      );
    }
  }
  // From scratch so a since-deleted file never lingers in the committed bundle.
  rmSync(bundle, { recursive: true, force: true });
  for (const [rel, kind] of BUNDLE_FILES) {
    const dest = join(bundle, rel);
    mkdirSync(kind === "dir" ? dest : dirname(dest), { recursive: true });
    cpSync(join(dist, rel), dest, { recursive: kind === "dir" });
  }
  return bundle;
}

function main() {
  process.stdout.write("\n$ node scripts/build-standalone.mjs\n");
  const r = spawnSync("node", [join(repoRoot, "scripts", "build-standalone.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    process.stderr.write("build-bundle: standalone build failed\n");
    process.exit(r.status ?? 1);
  }
  const bundle = syncBundle();
  process.stdout.write(`\n✓ committed bundle/ synced from dist/ → ${bundle}\n`);
}

// Run the full build only when invoked directly, not when imported for syncBundle.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main();
}
