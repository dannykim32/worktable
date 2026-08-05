// Issue 21: the network-free register helper (scripts/register.mjs). Every case
// runs the script under PLAIN `node` (not bun) against a scratch target dir — the
// same way a firewalled user would — and asserts what it wrote.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "register.mjs");
const distServer = join(repoRoot, "dist", "server", "index.js");
const distHook = join(repoRoot, "dist", "hooks", "askback-hook.js");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "vc-register-"));
}

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("register.mjs", () => {
  test("fresh write produces a valid .mcp.json with the absolute bundle path", () => {
    const target = scratch();
    const r = run(target);
    expect(r.status).toBe(0);
    const mcp = readJson(join(target, ".mcp.json"));
    expect(mcp.mcpServers["worktable"]).toEqual({
      command: "node",
      args: [distServer],
    });
  });

  test("idempotent: a second run does not duplicate the entry", () => {
    const target = scratch();
    run(target);
    run(target);
    const mcp = readJson(join(target, ".mcp.json"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["worktable"]);
    expect(mcp.mcpServers["worktable"].args).toEqual([distServer]);
  });

  test("preserves an existing unrelated server entry", () => {
    const target = scratch();
    writeFileSync(
      join(target, ".mcp.json"),
      JSON.stringify({
        mcpServers: { other: { command: "foo", args: ["bar"] } },
      }),
    );
    run(target);
    const mcp = readJson(join(target, ".mcp.json"));
    expect(mcp.mcpServers.other).toEqual({ command: "foo", args: ["bar"] });
    expect(mcp.mcpServers["worktable"].command).toBe("node");
  });

  test("--guidance appends the snippet once (marker makes re-run a no-op)", () => {
    const target = scratch();
    run(target, "--guidance");
    run(target, "--guidance");
    const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
    // Exactly one marker block, one heading — the marker guards against dupes.
    expect(agents.match(/<!-- worktable-guidance -->/g)?.length).toBe(1);
    expect(agents.match(/## Worktable/g)?.length).toBe(1);
    expect(agents).toContain("check_askbacks");
    // No stray prose leaked in ahead of the marker.
    expect(agents.startsWith("<!-- worktable-guidance -->")).toBe(true);
  });

  test("--guidance appends to an existing CLAUDE.md when no AGENTS.md exists", () => {
    const target = scratch();
    writeFileSync(join(target, "CLAUDE.md"), "# Existing\n\nkeep me\n");
    run(target, "--guidance");
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    const claude = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claude).toContain("keep me");
    expect(claude).toContain("<!-- worktable-guidance -->");
  });

  test("--hook writes a valid settings.json block and preserves other hooks", () => {
    const target = scratch();
    const dir = join(target, ".claude");
    require("node:fs").mkdirSync(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    run(target, "--hook");
    const settings = readJson(join(dir, "settings.json"));
    // Existing unrelated hook preserved.
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo hi");
    // Our UserPromptSubmit block added, pointing at the bundled hook.
    const inner = settings.hooks.UserPromptSubmit[0].hooks[0];
    expect(inner.type).toBe("command");
    expect(inner.command).toBe(`node ${distHook}`);
    expect(inner.timeout).toBe(5);
  });

  test("--hook is idempotent (updates in place, no duplicate entries)", () => {
    const target = scratch();
    run(target, "--hook");
    run(target, "--hook");
    const settings = readJson(join(target, ".claude", "settings.json"));
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
  });

  test("--print-codex prints a config.toml snippet and writes no codex file", () => {
    const target = scratch();
    const r = run(target, "--print-codex");
    expect(r.stdout).toContain("[mcp_servers.worktable]");
    expect(r.stdout).toContain('command = "node"');
    expect(r.stdout).toContain(distServer);
    // It only ever writes .mcp.json into the target; nothing codex-related.
    expect(existsSync(join(target, "config.toml"))).toBe(false);
  });

  test("bad target: refuses gracefully with a non-zero exit", () => {
    const r = run(join(tmpdir(), "vc-does-not-exist-xyz"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("register:");
  });

  test("bad target: a file (not a dir) is rejected", () => {
    const target = scratch();
    const file = join(target, "afile");
    writeFileSync(file, "x");
    const r = run(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not a directory");
  });
});
