# Distribution options: making Worktable easy to install

**Research date:** 2026-08-06. Facts are grounded in official docs (Claude Code, the
MCP registry, Homebrew) current as of that date; each claim links its primary source.
**Location note:** follows the `docs/research/` convention set by
[`local-canvas-landscape.md`](./local-canvas-landscape.md).

**The question:** Worktable is a *local* MCP stdio server (Node 20+) plus two
Claude-Code-native side pieces — a `UserPromptSubmit` ask-back hook and an
agent-guidance block. Today it ships as a self-contained tarball on GitHub Releases
with an `install.sh` that does three things: (1) `claude mcp add -s user worktable`,
(2) writes guidance into `~/.claude/CLAUDE.md`, (3) merges the ask-back hook into
`~/.claude/settings.json`. What is the best way to make that *easy to install and
discoverable* for other people in 2026?

**The load-bearing constraint:** Worktable is not one artifact, it's **three** — a
server, a hook, and guidance — that must land in the right places together. Any
distribution path that only ships the *server* leaves two-thirds of the product
uninstalled, and the ask-back loop (the whole point) doesn't work. This single fact
decides the ranking.

## Verdict

**Ship Worktable as a Claude Code plugin, distributed through a self-hosted GitHub
marketplace.** It is the only option that bundles all three pieces into one install,
it eliminates the absolute-path bookkeeping `install.sh` and `register.mjs` do by
hand (via `${CLAUDE_PLUGIN_ROOT}`), it gives versioned auto-updates for free, and it
is native to the exact audience — people already inside Claude Code. Everything else
is either a discoverability add-on (registries), a server-only partial (npm, the MCP
registry), or a delivery mechanism that still needs a separate register step
(Homebrew). The one honest tradeoff is documented below: plugins can't inject
`CLAUDE.md`, so the guidance block becomes a **skill**, which changes it from
always-on to model-invoked.

End-user install, the whole product in two lines inside Claude Code:

```text
/plugin marketplace add dannykim32/worktable
/plugin install worktable@worktable
```

---

## Option 1 — Claude Code plugin + self-hosted marketplace  ★ recommended

**Fit: excellent — the only path that carries all three pieces.** Worktable is
Claude-Code-native, and a plugin is Claude Code's native unit for exactly "an MCP
server + hooks + agent instructions."

### Can a plugin bundle all three? Yes.

Per the [plugins reference](https://code.claude.com/docs/en/plugins-reference), a
plugin is a directory with an optional `.claude-plugin/plugin.json` manifest and
component folders. Worktable's three pieces map cleanly:

| Worktable piece | Plugin mechanism | Notes |
| :-- | :-- | :-- |
| MCP stdio server | `.mcp.json` (or inline `mcpServers` in `plugin.json`) | `{ "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server/index.js"] }`. Starts automatically when the plugin is enabled. |
| `UserPromptSubmit` ask-back hook | `hooks/hooks.json` (or inline `hooks`) | `UserPromptSubmit` is a supported event; command `node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/askback-hook.js"`. |
| Agent guidance | a **skill** (`skills/worktable/SKILL.md`) | See the caveat below — guidance can NOT ship as `CLAUDE.md`. |

**The `${CLAUDE_PLUGIN_ROOT}` win.** The single biggest source of complexity in the
current install — `register.mjs` resolving and writing absolute paths into every
user's `.mcp.json` / `settings.json`, then re-resolving on move/update — disappears.
The manifest references `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes in MCP
`command`/`args`/`env` and hook commands
([env vars](https://code.claude.com/docs/en/plugins-reference#environment-variables)).
No absolute paths, no re-registration on update.

**The one real caveat — guidance becomes a skill, not `CLAUDE.md`.** The reference is
explicit: *"A `CLAUDE.md` file at the plugin root is not loaded as project context.
Plugins contribute context through skills, agents, and hooks rather than CLAUDE.md. To
ship instructions that load into Claude's context, put them in a skill."*
([plugins-reference](https://code.claude.com/docs/en/plugins-reference)). So the block
that `install.sh` writes into `~/.claude/CLAUDE.md` today must become
`skills/worktable/SKILL.md`. This is a **behavior change to weigh, not a blocker**:
today the guidance is always in context; as a skill it is model-invoked when the
description matches (e.g. "when the user asks to see/visualize/walk through something").
For a "nudge the model to use the canvas" instruction that is arguably *better*
(no permanent context tax), but it is a genuine semantics shift and should be QA'd —
the always-on nudge is part of why the canvas gets used proactively. Mitigation: the
ask-back **hook** stays always-on regardless (it's a hook, not a skill), so the
return half of the loop never depends on skill invocation.

**Node 20+ is still required.** A plugin bundles config and code, not a runtime. The
`SessionStart`-hook `node_modules` pattern in the docs isn't even needed here since
the server is already built to a dependency-inlined `dist/` — ship `dist/` in the
plugin and point `command: node` at it.

### Publishing / getting listed

A marketplace is just a git repo with `.claude-plugin/marketplace.json` at its root
listing plugins by `name` + `source`
([plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)). The
Worktable repo can *be* its own single-plugin marketplace — the plugin lives at the
repo root (or `./plugins/worktable`), and `marketplace.json` points at it. Push to
GitHub; users add it by `owner/repo`. Bump `version` in `plugin.json` to ship an
update; users get it via `/plugin marketplace update` (or automatically, depending on
their settings).

Minimal `marketplace.json`:

```json
{
  "name": "worktable",
  "owner": { "name": "Danny Kim" },
  "plugins": [
    { "name": "worktable", "source": "./", "description": "Local browser canvas for terminal coding agents — the model renders its work as a page you can see and ask about." }
  ]
}
```

### End-user install UX

```text
# inside Claude Code:
/plugin marketplace add dannykim32/worktable      # owner/repo; also accepts full git/SSH URLs and #ref pins
/plugin install worktable@worktable
# then restart or /reload-plugins
```

`/plugin marketplace add` reuses the user's existing git credentials, and installs
copy the plugin into `~/.claude/plugins/cache`
([discover-plugins](https://code.claude.com/docs/en/discover-plugins)).

- **Effort: M.** Restructure the repo into the plugin layout, write two small
  manifests, and convert the guidance block into a `SKILL.md`. The build already
  produces the `dist/` the plugin needs.
- **Maintenance: low.** Bump `version` on release; the marketplace does discovery,
  version tracking, and updates. No absolute-path fixups ever again.
- **Discoverability: self-hosted is invisible until shared** — see Option 1b for the
  official directory.

### Option 1b — get into Anthropic's official marketplace (discoverability)

`anthropics/claude-plugins-official` is Anthropic's curated marketplace, surfaced in
the `/plugin` **Discover** tab. Listing is **submission + review**, not a pull
request: submit via the [plugin directory submission
form](https://clau.de/plugin-directory-submission); Anthropic reviews against quality
and security standards, and plugin names are immutable once published
([repo](https://github.com/anthropics/claude-plugins-official)). This is the same
plugin from Option 1 — zero extra build — so it's a "submit and wait" step layered on
top, not a separate track. **This is the discoverability play for the native
audience.**

---

## Option 2 — Official MCP registry + community registries (mcp.so / Smithery / Glama)

**Fit: partial — discoverability only, and server-only.** Every registry here catalogs
*servers*. None can install Worktable's hook or guidance, so none delivers the ask-back
loop. They are SEO, not an install path for the whole product.

### Official MCP registry (`registry.modelcontextprotocol.io`)

- **What it takes:** a `server.json` and the `mcp-publisher` CLI (`make publisher`),
  authenticated by **GitHub OAuth** for the reverse-DNS namespace
  `io.github.dannykim32/worktable`
  ([registry](https://github.com/modelcontextprotocol/registry),
  [server.json spec](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)).
- **Local stdio is supported:** `"transport": { "type": "stdio" }`. But the package
  must live on a supported registry — `"registryType": "npm"` (so **Option 3 is a
  prerequisite**) — or be an MCPB bundle (`"registryType": "mcpb"`) that references a
  GitHub Release URL.
- **The catch:** the registry is *an API clients query* ("like an app store"), **not**
  an auto-installer. Listing there does not put Worktable into anyone's Claude Code;
  install is still `claude mcp add` / a plugin. And it carries only the server.
- **Effort: S–M** (needs npm first). **Maintenance: low.** **Value: discovery.**

### Community catalogs

- **Glama** auto-indexes public GitHub MCP repos with no submission — Worktable likely
  gets listed passively; *claiming* the entry improves ranking
  ([methodology](https://glama.ai/mcp/methodology)). Nearly free discoverability.
- **mcp.so** and **Smithery** are catalog/submission sites. Smithery is stdio-first
  for local use but leans toward hosted/remote deploys (`smithery.yaml`); it assumes an
  `npx`-installable or hosted server. All three are server-only.

**Flag:** these registries are built around the assumption that a "server" is the unit
of distribution. Worktable's value is a *loop*, not a server, so treat registries as
billboards that point back to the plugin/README, not as the install mechanism.

---

## Option 3 — npm + npx

**Fit: good for the server, incomplete for the product — but high-leverage as an
enabler.** Publishing `worktable` to npm makes the server one `npx` away and unlocks
Options 1 and 2, but `npx` installs *nothing* about the hook or guidance.

### What it takes

Add to `package.json`: a `bin` entry (`"worktable": "dist/server/index.js"` with a
`#!/usr/bin/env node` shebang), a `files` allowlist (ship `dist/`, not source), and
`publishConfig.access` if scoped. The current `bun build --target=node` inlined bundle
works as-is — `bin` just points at it. Then `npm publish`.

### End-user UX

```sh
# server only:
claude mcp add -s user worktable -- npx -y worktable
# or run directly:
npx worktable
```

- **Composition with the hook/guidance:** **it doesn't.** `npx` gives the server; the
  ask-back hook and guidance still need a separate step. So npm composes as *"npx for
  the server + a slimmed `install.sh` that only does the hook + guidance."* That's two
  moving parts where the plugin is one.
- **Tradeoff vs. today's firewall story:** `npx` needs network at run time, which is
  the exact thing `docs/install.md` was built to avoid. Keep the tarball path for
  firewalled installs; npm is for the connected majority.
- **Effort: S.** **Maintenance: npm version bumps.** **Strategic value: high** — it's
  the prerequisite for the official MCP registry and simplifies the plugin's server
  command (`npx worktable` instead of a bundled `dist/`), and it's the idiom most MCP
  install tooling (e.g. `add-mcp`) expects.

---

## Option 4 — Homebrew tap + `curl | bash`

**Fit: partial (Homebrew) to full-but-with-a-smell (curl|bash).** Both are *delivery*
mechanisms; only the server-plus-register logic that already lives in `install.sh`
makes them complete.

### Homebrew tap

Create a `homebrew-worktable` repo with `Formula/worktable.rb`: `depends_on "node"`,
`url` → the GitHub Release tarball, plus its `sha256`
([Homebrew tap docs](https://brew.sh/2020/11/18/homebrew-tap-with-bottles-uploaded-to-github-releases/)).

```sh
brew tap dannykim32/worktable
brew install worktable
```

- **The catch:** `brew install` puts the binary on `PATH` but **cannot** run
  `claude mcp add`, write the hook, or drop guidance. The formula's `caveats` would
  have to tell the user to run a follow-up `worktable install`. So Homebrew is the
  server delivery, not the product install — same shape as npm, minus the registry
  unlocks, plus a tap to maintain.
- **Effort: M** (formula + tap repo + SHA updates each release, optionally bottles).
  **Maintenance: real** — every release needs a formula bump. **Reach:** macOS/Linux
  only. **Verdict: nice-to-have, not first.**

### `curl | bash` one-liner

Host the existing `install.sh` on GitHub Releases and document:

```sh
curl -fsSL https://github.com/dannykim32/worktable/releases/latest/download/install.sh | bash
```

- **This is the current install, made one line.** `install.sh` *already* does all
  three pieces, so unlike Homebrew/npm this path delivers the whole product with no
  follow-up step. It still assumes the tarball is fetched/extracted (the script
  expects `dist/` beside it), so the one-liner would need to fetch+extract the tarball
  too, or be a thin bootstrap that downloads the release and runs the bundled
  `install.sh`.
- **Trust tradeoff:** `curl | bash` asks users to pipe a remote script straight to a
  shell. For a tool whose pitch is "don't trust the wall of text, look at it," that's
  an ironic ask. Acceptable as a documented fallback; not the headline.
- **Effort: S.** **Maintenance: low** (it's what exists). **Fit: full install, weak
  trust optics.**

---

## Ranked recommendation

1. **First — ship as a Claude Code plugin + self-hosted GitHub marketplace
   (Option 1).** It's the only path that installs the whole product in one step,
   deletes the absolute-path machinery, and auto-updates. This is the highest-leverage
   move: one repo restructure collapses the three-part install into
   `/plugin marketplace add dannykim32/worktable` + `/plugin install worktable`. Do
   the guidance-→-skill conversion carefully and QA that the canvas still gets used
   proactively.
2. **Second — submit that same plugin to Anthropic's official marketplace
   (Option 1b).** Zero extra build; it's the discoverability channel for the native
   audience via the `/plugin` Discover tab. Submit the form, keep shipping.
3. **Third, in parallel and cheap — publish to npm (Option 3).** Low effort, and it
   pays for itself twice: it simplifies the plugin's server command to `npx worktable`
   and it's the prerequisite that unlocks the official MCP registry and clean Glama /
   mcp.so listings (Option 2) for passive discovery. Keep the existing
   tarball + `curl | bash` as the firewall/non-plugin fallback — it already does the
   full install.
4. **Later / optional — Homebrew (Option 4) and the MCP registries as billboards
   (Option 2).** Homebrew is a maintenance cost for macOS/Linux delivery that still
   needs a register step; the registries are server-only catalogs that can't carry the
   loop. List for SEO once npm exists; don't rely on either as the install path.

**Single highest-leverage move:** convert the repo into a Claude Code plugin with a
self-hosted marketplace manifest. One PR turns a three-artifact, absolute-path,
tarball-and-`install.sh` procedure into two slash commands with versioned
auto-updates — and it's exactly where the people who'd want Worktable already are.

## Sources

- Claude Code — [Plugins reference](https://code.claude.com/docs/en/plugins-reference) (manifest schema, MCP/hook/skill declaration, `${CLAUDE_PLUGIN_ROOT}`, "CLAUDE.md not loaded")
- Claude Code — [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) (`marketplace.json`, self-hosting)
- Claude Code — [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins) (`/plugin marketplace add`, install UX)
- Anthropic — [official plugin marketplace repo](https://github.com/anthropics/claude-plugins-official) + [submission form](https://clau.de/plugin-directory-submission)
- MCP — [official registry](https://github.com/modelcontextprotocol/registry) and [server.json spec](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
- [Glama indexing methodology](https://glama.ai/mcp/methodology); [MCP registries overview](https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server)
- Homebrew — [tap with GitHub Releases](https://brew.sh/2020/11/18/homebrew-tap-with-bottles-uploaded-to-github-releases/)
