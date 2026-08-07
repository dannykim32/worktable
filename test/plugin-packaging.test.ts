// Guards the Claude Code plugin packaging (self-hosted marketplace + committed
// bundle/) and the load-bearing name-agnostic path resolution that lets the ONE
// server file run identically from the tarball `dist/` and the plugin `bundle/`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

describe("name-agnostic sibling path resolution", () => {
  // The server resolves its canvas + listener CLI as SIBLINGS of its own dir.
  // From `<root>/server/index.js`, `../canvas` and `../hooks/...` must land in
  // `<root>/…` for ANY root name — proven here for both `dist` and `bundle`.
  for (const root of ["dist", "bundle"]) {
    test(`resolves canvas + await-cli as siblings under ${root}/`, () => {
      const server = `file:///anywhere/${root}/server/index.js`;
      expect(fileURLToPath(new URL("../canvas", server))).toBe(
        `/anywhere/${root}/canvas`,
      );
      expect(fileURLToPath(new URL("../hooks/await-askback.js", server))).toBe(
        `/anywhere/${root}/hooks/await-askback.js`,
      );
    });
  }

  test("index.ts uses sibling-relative URLs, never a hardcoded top-level dir", () => {
    const src = read("src/server/index.ts");
    expect(src).toContain('new URL("../hooks/await-askback.js", import.meta.url)');
    expect(src).toContain('new URL("../canvas", import.meta.url)');
    // The old dist-hardcoded form must be gone (would break the bundle layout).
    expect(src).not.toContain("../../dist/hooks/await-askback.js");
    expect(src).not.toContain("../../dist/canvas");
  });
});

describe("plugin manifest (.claude-plugin/plugin.json)", () => {
  const manifest = readJson(".claude-plugin/plugin.json");

  test("has the required identity fields", () => {
    expect(manifest.name).toBe("worktable");
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
  });

  test("version matches package.json", () => {
    expect(manifest.version).toBe(readJson("package.json").version);
  });

  test("declares the worktable MCP server pointing at the bundle via CLAUDE_PLUGIN_ROOT", () => {
    const servers = manifest.mcpServers as Record<
      string,
      { command: string; args: string[] }
    >;
    expect(servers.worktable.command).toBe("node");
    expect(servers.worktable.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/bundle/server/index.js",
    ]);
  });

  test("declares a UserPromptSubmit hook running the ask-back hook from the bundle", () => {
    const hooks = manifest.hooks as {
      UserPromptSubmit: Array<{ hooks: Array<{ type: string; command: string }> }>;
    };
    const inner = hooks.UserPromptSubmit[0]!.hooks[0]!;
    expect(inner.type).toBe("command");
    expect(inner.command).toContain("${CLAUDE_PLUGIN_ROOT}/bundle/hooks/askback-hook.js");
    expect(inner.command).toContain("node");
  });
});

describe("marketplace manifest (.claude-plugin/marketplace.json)", () => {
  const market = readJson(".claude-plugin/marketplace.json");

  test("has name, owner.name, and a plugins array", () => {
    expect(market.name).toBe("worktable");
    expect((market.owner as { name: string }).name).toBeTruthy();
    expect(Array.isArray(market.plugins)).toBe(true);
  });

  test("lists the worktable plugin sourced from this repo", () => {
    const entry = (market.plugins as Array<{ name: string; source: string }>)[0]!;
    expect(entry.name).toBe("worktable");
    // Same-repo relative source must start with "./" (resolves to marketplace root).
    expect(entry.source.startsWith("./")).toBe(true);
  });
});

describe("guidance skill (skills/worktable/SKILL.md)", () => {
  const raw = read("skills/worktable/SKILL.md");

  test("exists with YAML frontmatter carrying name + description", () => {
    expect(raw.startsWith("---\n")).toBe(true);
    const fm = raw.slice(4, raw.indexOf("\n---", 4));
    expect(fm).toMatch(/^name:\s*worktable\s*$/m);
    expect(fm).toMatch(/^description:\s*\S/m);
  });
});

describe("committed plugin bundle/", () => {
  for (const rel of [
    "bundle/server/index.js",
    "bundle/hooks/askback-hook.js",
    "bundle/hooks/await-askback.js",
    "bundle/canvas/index.html",
  ]) {
    test(`ships ${rel}`, () => {
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    });
  }
});
