# Installing worktable on a firewalled machine

worktable isn't published to npm — it's distributed as a self-contained bundle,
deliberately. It's built to install on a machine that cannot reach npm/npx (no
`bun install`, no `npx` at runtime). The model: build a self-contained bundle on a
networked machine, copy
the repo to the firewalled machine, and register it into a target repo with a
network-free helper. The only runtime requirement on the firewalled machine is
`node`.

## The two build scripts

| Script | Output | Use |
|--------|--------|-----|
| `bun run build` | tsc typecheck + vite + hook bundle | Development. Needs `node_modules`. |
| `bun run build:standalone` | `dist/` that runs on **`node` alone** | Shipping to a firewalled machine. |

`build:standalone` produces three things under `dist/`:

- `dist/server/index.js` — the Canvas Server, bundled with `bun build --target=node`
  so `@modelcontextprotocol/sdk` and every import are inlined; only `node:*`
  builtins stay external. The version is inlined at build time too, so the bundle
  reads no repo files at runtime — it runs with `node_modules` AND `package.json`
  completely absent (a dist-only copy is enough).
- `dist/hooks/askback-hook.js` — the Claude Code ask-back hook, bundled the same way.
- `dist/canvas/` — the built canvas static assets (vite).

## Step 1 — build the bundle (networked machine)

On a machine that can install dependencies:

```sh
bun install
bun run build:standalone
```

Verify locally if you like — `node dist/server/index.js` starts the server with no
`node_modules` needed (the automated smoke test proves exactly this by moving
`node_modules` aside).

## Step 2 — copy the repo INCLUDING dist/ (to the firewalled machine)

> **Caveat: `dist/` is gitignored.** A plain `git clone` / `git pull` will NOT
> carry the bundle — you would arrive with source but no runnable `dist/`, and no
> way to build it behind the firewall. You must transfer the built `dist/` too.

Pick whatever your environment allows:

```sh
# tar the repo with dist/ included (dist/ is ignored by git, not by tar)
tar czf worktable.tgz -C /path/to worktable && scp worktable.tgz host:

# or scp/rsync the directory directly (dist/ rides along)
rsync -a /path/to/worktable/ host:/path/to/worktable/

# or a git bundle for the source PLUS a separate copy of dist/
git bundle create worktable.bundle --all      # source only — dist/ is gitignored
# ...then also copy dist/ across by tar/scp/USB, since the bundle omits it
```

The essential invariant: on the firewalled machine, `dist/server/index.js` and
`dist/canvas/` must exist (plus `dist/hooks/askback-hook.js` if you use the Claude
Code hook). Everything else — source, `node_modules`, even `package.json` — is
optional at runtime; the bundle inlines its dependencies and its version, so a
dist-only copy runs.

## Step 3 — register into your project (firewalled machine, no network)

`scripts/register.mjs` is plain Node ESM with zero dependencies and no network. It
resolves this repo's absolute `dist/server/index.js` and wires it into your target
project:

```sh
node scripts/register.mjs /path/to/your/project --guidance
```

What it does:

- **`.mcp.json`** — merges a `worktable` server entry
  (`{ command: "node", args: ["<abs>/dist/server/index.js"] }`) into
  `<target>/.mcp.json`. Idempotent: existing servers are preserved, and re-running
  updates the path in place instead of duplicating.
- **`--guidance`** — appends the [agent-guidance snippet](./agent-guidance.md) to
  the target's `AGENTS.md` (or `CLAUDE.md` if that is what exists), so the agent
  uses the canvas proactively. Idempotent via the `<!-- worktable-guidance -->`
  marker.
- **`--hook`** — merges the Claude Code `UserPromptSubmit` ask-back hook into
  `<target>/.claude/settings.json`, pointing at `dist/hooks/askback-hook.js`.
  Existing hooks are preserved. (Claude Code only — see below.)
- **`--print-codex`** — prints (writes nothing) a Codex `~/.codex/config.toml`
  `[mcp_servers.worktable]` snippet for you to paste.

Add the flags you want, e.g. the full Claude Code setup:

```sh
node scripts/register.mjs /path/to/your/project --guidance --hook
```

## The one-command install (recommended)

Once you have the bundle on the target machine (download or transfer — see below),
it's a single command. The bundle carries an `install.sh` that checks node, registers
`worktable` for **every** Claude Code session (user scope), and optionally wires a
specific project:

```sh
tar xzf worktable-*.tar.gz
cd worktable-*
./install.sh                      # tools + guidance + ask-back hook, user-wide
./install.sh /path/to/your/repo   # ALSO drop a repo-local copy into that repo
```

The bare form is the whole install: it registers the MCP server for every
Claude Code session AND installs the agent guidance (`~/.claude/CLAUDE.md`) and
the ask-back hook (`~/.claude/settings.json`) user-wide — every repo gets the
canvas behavior with no per-repo setup, and re-running upgrades the guidance in
place. The repo argument is only for giving a specific repo its own committed
copy (e.g. for teammates) or migrating stale pre-rename blocks.

Then restart Claude Code and run `/mcp` — `worktable` should show connected. The only
requirement it can't carry is **node** (any recent version); `install.sh` fails clearly
if it's missing. Everything below is the manual breakdown of what that script does.

## The easy path — download a release bundle

Instead of building + copying yourself, grab a pre-built self-contained tarball from
the repo's GitHub Releases. This is the no-npm, firewall-friendly path (git /
github.com is usually reachable where npm is not):

```sh
# on any machine (needs only node + gh, or download the .tar.gz from the Releases page):
gh release download --repo dannykim32/worktable --pattern '*.tar.gz'
tar xzf worktable-*.tar.gz
# register into a project (no network):
node worktable-*/scripts/register.mjs /path/to/your/project --guidance   # + --hook for Claude Code
```

The tarball contains the runtime bundle (`dist/`), the register helper, and the docs —
no source, no `node_modules`. `INSTALL.txt` at its root has the quickstart. To cut a
new release from a networked machine: `bun run package:release` then
`gh release create v<version> dist-release/worktable-<version>.tar.gz`.

## Install for EVERY Claude Code session (user scope)

Per-repo `.mcp.json` (what `register.mjs` writes) scopes the server to one project.
To have the tools in **every** Claude Code session in any repo, register at user scope
once (point it at the extracted bundle's server):

```sh
claude mcp add -s user worktable -- node /abs/path/to/worktable-<version>/dist/server/index.js
```

The canvas still keys its workspace off the session's working directory, so each repo
gets its own artifacts and capability token.

## Step 4 — restart and verify

Restart Claude Code in the target project so it picks up the new `.mcp.json` (and
hook). Confirm `worktable` shows as connected under `/mcp`, then ask the agent to
"publish a short design note to the canvas" — the tokened canvas URL should open and
render it. The full walkthrough checklist lives in [setup.md](./setup.md).

## Codex (and other MCP hosts)

The ask-back **hook is Claude-Code-only**. On Codex — or any host without the hook —
the portable fallback is `check_askbacks`: the agent calls it at the start of each
turn (the guidance snippet instructs this) and you nudge the terminal to trigger it.
Register the server by pasting the `--print-codex` snippet:

```sh
node scripts/register.mjs /path/to/your/project --print-codex
```

```toml
# ~/.codex/config.toml
[mcp_servers.worktable]
command = "node"
args = ["/abs/path/to/worktable/dist/server/index.js"]
```

## Rebuilding after an update

When you pull new source, rebuild on a networked machine (`bun run
build:standalone`) and re-copy `dist/` — the gitignored-bundle caveat applies to
every update, not just the first install. The registered absolute path does not
change, so no re-registration is needed unless you move the repo.
