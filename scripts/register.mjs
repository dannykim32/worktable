// Network-free register helper (issue 21). Plain Node ESM, ZERO dependencies,
// NO network — it only reads this repo and writes into a target repo, so it runs
// on a firewalled machine with just `node`.
//
//   node scripts/register.mjs <target-repo> [--guidance] [--hook] [--print-codex]
//
// It resolves THIS repo's absolute dist/server/index.js, writes/merges the
// target's .mcp.json (idempotent, preserves other servers), and optionally
// appends the agent-guidance snippet, merges the Claude Code ask-back hook, and
// prints a Codex config.toml snippet.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- worktable-guidance -->";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const distServer = join(repoRoot, "dist", "server", "index.js");
const distHook = join(repoRoot, "dist", "hooks", "askback-hook.js");
const guidanceDoc = join(repoRoot, "docs", "agent-guidance.md");

function fail(message) {
  process.stderr.write(`register: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { guidance: false, hook: false, printCodex: false };
  const positionals = [];
  for (const arg of argv) {
    switch (arg) {
      case "--guidance":
        flags.guidance = true;
        break;
      case "--hook":
        flags.hook = true;
        break;
      case "--print-codex":
        flags.printCodex = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      default:
        if (arg.startsWith("--")) fail(`unknown flag: ${arg}`);
        positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function usage() {
  return (
    "Usage: node scripts/register.mjs <target-repo> " +
    "[--guidance] [--hook] [--print-codex]\n\n" +
    "  <target-repo>   directory of the project to register worktable into\n" +
    "  --guidance      append the agent-guidance snippet to AGENTS.md/CLAUDE.md\n" +
    "  --hook          merge the Claude Code UserPromptSubmit ask-back hook\n" +
    "  --print-codex   print a Codex ~/.codex/config.toml snippet (writes nothing)\n"
  );
}

/** Read a JSON file, or return `fallback` if it is absent. Never clobbers on a
 *  parse error — it aborts so an existing file is preserved. */
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
  if (raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    fail(
      `${path} exists but is not valid JSON — refusing to overwrite it. ` +
        "Fix or remove it and retry.",
    );
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Merge the worktable entry into <target>/.mcp.json, preserving every other
 *  server. Idempotent: an existing worktable entry has its path updated. */
function mergeMcpJson(target, summary) {
  const path = join(target, ".mcp.json");
  const config = readJson(path, {});
  if (
    config.mcpServers != null &&
    (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))
  ) {
    fail(`${path} has a non-object "mcpServers" — refusing to overwrite.`);
  }
  const servers = config.mcpServers ?? {};
  const existed = Object.prototype.hasOwnProperty.call(servers, "worktable");
  servers["worktable"] = {
    command: "node",
    args: [distServer],
  };
  config.mcpServers = servers;
  writeJson(path, config);
  summary.push(
    `${existed ? "updated" : "added"} worktable in ${path}\n` +
      `    → node ${distServer}`,
  );
}

/** Return the guidance payload (marker block, inclusive) from the repo doc.
 *  Matches the markers as WHOLE LINES so a marker quoted in the doc's own prose
 *  (e.g. inside backticks) cannot be mistaken for the payload boundary. */
function guidancePayload() {
  if (!existsSync(guidanceDoc)) {
    fail(`missing guidance source: ${guidanceDoc}`);
  }
  const endMarker = "<!-- /worktable-guidance -->";
  const lines = readFileSync(guidanceDoc, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === MARKER);
  const end = lines.findIndex((l) => l.trim() === endMarker);
  if (start === -1 || end === -1 || end < start) {
    fail(`guidance markers not found (as whole lines) in ${guidanceDoc}`);
  }
  return lines
    .slice(start, end + 1)
    .join("\n")
    .trimEnd()
    // The snippet references the listener CLI by absolute path; the doc keeps a
    // placeholder so one canonical copy serves every install location.
    .replaceAll("<abs-path-to-worktable>", repoRoot);
}

/** Append the guidance snippet to AGENTS.md (preferred), else CLAUDE.md, else a
 *  new AGENTS.md. Idempotent via the marker. */
function appendGuidance(target, summary) {
  const agents = join(target, "AGENTS.md");
  const claude = join(target, "CLAUDE.md");
  const path = existsSync(agents)
    ? agents
    : existsSync(claude)
      ? claude
      : agents;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(MARKER)) {
    summary.push(`guidance already present in ${path} (no-op)`);
    return;
  }
  const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, existing + sep + guidancePayload() + "\n");
  summary.push(`appended guidance snippet to ${path}`);
}

/** Merge the Claude Code UserPromptSubmit ask-back hook into
 *  <target>/.claude/settings.json, preserving any existing hooks. Idempotent:
 *  an existing askback-hook entry has its command updated in place. */
function mergeHook(target, summary) {
  const dir = join(target, ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  const settings = readJson(path, {});
  const command = `node ${distHook}`;

  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    fail(`${path} has a non-object "hooks" — refusing to overwrite.`);
  }
  const list = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit
    : [];

  // Idempotency: find any existing entry whose inner hook references our hook
  // file and update its command in place, rather than appending a duplicate.
  let updated = false;
  for (const entry of list) {
    const inner = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const h of inner) {
      if (
        h &&
        typeof h.command === "string" &&
        h.command.includes("askback-hook.js")
      ) {
        h.command = command;
        h.type = "command";
        updated = true;
      }
    }
  }
  if (!updated) {
    list.push({ hooks: [{ type: "command", command, timeout: 5 }] });
  }

  hooks.UserPromptSubmit = list;
  settings.hooks = hooks;
  writeJson(path, settings);
  summary.push(
    `${updated ? "updated" : "merged"} UserPromptSubmit hook in ${path}\n` +
      `    → ${command}`,
  );
}

/** Print (never write) a Codex config.toml snippet for the user to paste. */
function printCodex() {
  const argsToml = `["${distServer}"]`;
  process.stdout.write(
    "\nCodex — paste into ~/.codex/config.toml (nothing was written):\n\n" +
      "  [mcp_servers.worktable]\n" +
      '  command = "node"\n' +
      `  args = ${argsToml}\n\n`,
  );
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals.length === 0) {
    process.stdout.write(usage());
    process.exit(flags.help ? 0 : 1);
  }
  if (positionals.length > 1) {
    fail(`expected one target directory, got ${positionals.length}`);
  }
  const target = resolve(positionals[0]);
  let st;
  try {
    st = statSync(target);
  } catch {
    fail(`target does not exist: ${target}`);
  }
  if (!st.isDirectory()) {
    fail(`target is not a directory: ${target}`);
  }

  if (!existsSync(distServer)) {
    process.stderr.write(
      `register: warning — ${distServer} does not exist yet. Run ` +
        "`bun run build:standalone` on a networked machine and copy dist/ over " +
        "before starting the agent host.\n",
    );
  }

  const summary = [];
  mergeMcpJson(target, summary);
  if (flags.guidance) appendGuidance(target, summary);
  if (flags.hook) mergeHook(target, summary);

  process.stdout.write("\nworktable registered:\n");
  for (const line of summary) process.stdout.write(`  • ${line}\n`);

  if (flags.printCodex) printCodex();

  process.stdout.write(
    "\nNext: restart Claude Code in " +
      `${target} so it picks up the new .mcp.json` +
      (flags.hook ? " and the ask-back hook" : "") +
      ".\n",
  );
  if (!flags.guidance) {
    process.stdout.write(
      "  Tip: re-run with --guidance to teach the agent to use the canvas " +
        "proactively.\n",
    );
  }
}

main();
