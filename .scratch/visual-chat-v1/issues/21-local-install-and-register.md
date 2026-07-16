# 21 — Local install: self-contained bundle + register helper + guidance snippet

Status: done
Type: task
Milestone: post-v1 (distribution)
Blocked by: 06

## Context

The project is `"private": true` and never published to npm (deliberate). It must
install on a FIREWALLED machine that cannot reach npm/npx (no `bun install`, no
`npx`). The install model: build a self-contained bundle on a networked machine
(deps already present), copy the repo to the firewalled machine, and register it
into a target repo with a network-free helper. Runtime = `node` only.

## Implementation

**1. Self-contained server bundle (the firewall requirement).**
Add a `build:standalone` script that produces a `dist/` runnable with ONLY `node`
(no `node_modules`, no bun at runtime):
- Bundle the server: `bun build src/server/index.ts --target=node --outfile
  dist/server/index.js` (inlines @modelcontextprotocol/sdk + all imports, like the
  issue-13 hook already does). Keep `node:*` builtins external (default for
  --target=node).
- Bundle the hook the same way (already done — keep it).
- Build the canvas with vite as today (static assets in dist/canvas/).
- The existing `build` (tsc typecheck + vite) stays for dev. `build:standalone` is
  the shippable one. Document both.
- VERIFY: with `node_modules` absent or renamed, `node dist/server/index.js` still
  starts and serves (a smoke test that moves node_modules aside, runs the bundled
  server, hits /api/health with the token, restores node_modules).

**2. Register helper — `scripts/register.mjs` (plain Node ESM, zero deps, no network).**
Run: `node scripts/register.mjs <target-repo-path> [--guidance] [--hook] [--print-codex]`
- Computes the ABSOLUTE path to THIS repo's `dist/server/index.js` (resolve from the
  script location).
- Writes/merges `<target>/.mcp.json` — adds a `visual-chat` server entry
  `{ command: "node", args: ["<abs>/dist/server/index.js"] }`. IDEMPOTENT: if
  `.mcp.json` exists, parse and merge (preserve other servers); if the visual-chat
  entry already exists, update the path in place, don't duplicate. Never clobber.
- `--guidance`: append the guidance snippet (see #3) to `<target>/AGENTS.md` (or
  `CLAUDE.md` if that's what exists; prefer AGENTS.md, else CLAUDE.md, else create
  AGENTS.md). Skip if the snippet's marker is already present (idempotent).
- `--hook`: write the Claude Code `UserPromptSubmit` hook block into
  `<target>/.claude/settings.json` (merge, idempotent) pointing at
  `<abs>/dist/hooks/askback-hook.js`. If settings.json has other hooks, preserve them.
- `--print-codex`: print (do not write) the Codex `~/.codex/config.toml`
  `[mcp_servers.visual-chat]` snippet for the user to paste.
- Print a clear summary of what it wrote and the "restart Claude Code" next step.
- Refuse gracefully (clear message, non-zero exit) if the target path isn't a dir.

**3. Guidance snippet — `docs/agent-guidance.md`.**
A standalone, copy-paste block a user drops into any repo's AGENTS.md/CLAUDE.md to get
PROACTIVE canvas use. Extract and generalize the "## Visual Chat" section already in
this repo's AGENTS.md (publish when structure beats prose; call check_askbacks each
turn; honest absence; bound large inputs). Wrap it in a stable marker comment
(`<!-- visual-chat-guidance -->`) so the register helper can detect idempotently.

**4. Docs — `docs/install.md` (new) + link from README + setup.md.**
The firewalled local-install path, end to end:
1. On a networked machine (or one with deps cached): `bun install && bun run
   build:standalone`.
2. Copy the repo (including `dist/`) to the firewalled machine (git bundle / scp /
   tar / USB — user's choice; note dist/ is gitignored so a plain `git clone` won't
   carry it — call this out).
3. On the firewalled machine: `node scripts/register.mjs /path/to/your/project
   --guidance` (add `--hook` for auto-inject on Claude Code).
4. Restart Claude Code in that project. Verify with the canvas.
Also document the Codex path (`--print-codex` → paste into config.toml; note the hook
is Claude-Code-only, `check_askbacks` is the portable fallback).

## Acceptance Criteria

1. `bun run build:standalone` produces a `dist/` where `node dist/server/index.js`
   starts and serves with `node_modules` MOVED ASIDE (smoke test proves it).
2. `register.mjs` on a scratch target dir writes a valid `.mcp.json` with the correct
   absolute path; run twice → no duplication (idempotent); an existing unrelated
   server entry is preserved.
3. `--guidance` appends the snippet once (second run is a no-op via the marker).
4. `--hook` writes a valid settings.json hook block, merging with existing hooks.
5. `--print-codex` prints a valid config.toml snippet, writes nothing.
6. The guidance snippet exists at docs/agent-guidance.md with the marker.
7. docs/install.md documents the firewalled path incl. the dist/-is-gitignored caveat.
8. `register.mjs` uses only Node builtins (no deps, no network); runs under plain
   `node`.
9. `bun test` green; existing tests unaffected.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit/integration | register.mjs: fresh write, idempotent re-run, preserve-existing-server, guidance marker, hook merge, bad-target | +6 |
| Smoke | build:standalone → node_modules-aside → node runs server → /api/health 200 | +1 |

## Out of Scope

Publishing to npm (stays private). A GUI installer. Auto-transferring the repo across
machines (user's choice of git/scp/tar). Changing the server/canvas behavior.

## Comments

Done. Packaging + tooling only — no server/canvas behavior changed.

**What shipped:**
- `build:standalone` script (package.json): vite canvas + `bun build
  src/server/index.ts --target=node` (inlines the SDK + all imports; node:*
  external) + the hook bundle. Existing `build` (tsc + vite) stays for dev.
- `scripts/register.mjs` — plain Node ESM, zero deps, no network. Merges
  `.mcp.json` (idempotent, preserves other servers, updates in place),
  `--guidance` (marker-idempotent append to AGENTS.md/CLAUDE.md), `--hook`
  (merges the UserPromptSubmit hook, preserves other hooks, updates in place),
  `--print-codex` (prints, writes nothing). Refuses a non-dir target with a
  non-zero exit. Also wired as `bun run register`.
- `docs/agent-guidance.md` (marker-wrapped, the `--guidance` source) and
  `docs/install.md` (firewalled path end-to-end incl. the dist/-is-gitignored
  caveat). install.md linked from README.md and docs/setup.md.

**Verification (all ACs pass):**
- AC-1 smoke test moves node_modules aside, runs `node dist/server/index.js`,
  hits `/api/health` with the token → 200 (401 without). node_modules always
  restored in a finally + an afterAll safety net.
- register.mjs tests: fresh write, idempotent re-run, preserve-existing-server,
  guidance marker (once), CLAUDE.md fallback, hook merge + idempotency,
  print-codex, bad-target (missing + file-not-dir). All under plain `node`.
- `bun test`: 293 pass / 0 fail (was 282; +11 new). Existing tests unaffected.

**Judgment calls:**
- The guidance doc's intro mentions the marker literally, so a naive
  `indexOf(MARKER)` slice leaked prose into the payload; fixed by matching the
  markers as whole lines. Caught before commit.
- Kept `"private": true`, the placeholder name, and did not prepare an npm
  publish, per the spec's hard rules.
