# Landscape: local browser canvas for terminal coding agents

**Research date:** 2026-07-14. Star counts and activity retrieved from the GitHub API or repo pages on that date.
**Location note:** this repo had no existing docs convention; `docs/research/` is the chosen home for research notes.

**The question:** does a popular open-source tool already give a terminal LLM coding agent (Claude Code et al.) a local browser "canvas" for publishing rich visual artifacts, with selection-anchored ask-backs from the browser landing back in the agent's conversation?

**Evaluation axes** (the core loop of the proposed project):

- **(a)** agent publishes structured artifacts to a local canvas for the human
- **(b)** safe rendering boundary for model-authored content
- **(c)** selection-anchored ask-backs from the browser back into the agent conversation
- **(d)** works as a plugin to an *existing* terminal agent rather than replacing it

## Summary

**Verdict: partially filled — heavily, by three near-solvers, but the exact loop is unclaimed.**

1. **[nexu-io/open-design](https://github.com/nexu-io/open-design)** (~78k stars, Apache-2.0, very active) is the closest thing that exists. Local-first, works with 22+ agent CLIs, sandboxed localhost preview, and it *does* have element-anchored comments on artifact previews. But its comment loop runs through its own daemon, which **spawns and drives the agent CLI as a subprocess via "agent adapters"** — comments become fresh, constrained agent invocations, not messages into *your* live terminal session. And it is scoped to design deliverables (prototypes, decks, dashboards, images, video).
2. **[Claude Code Artifacts](https://code.claude.com/docs/en/artifacts)** (official Anthropic feature, Pro/Max/Team/Enterprise) covers agent-published, live-updating, sandboxed artifact pages natively from the terminal — but pages are **hosted on claude.ai, not locally**, it requires claude.ai auth (not API-key/Bedrock/Vertex sessions), and there is **no ask-back channel**: the docs' own workaround is a "Copy as prompt" button the page implements itself, pasted back manually.
3. **[MCP Apps / mcp-ui](https://github.com/modelcontextprotocol/ext-apps)** (SEP-1865, stable in the MCP spec as of 2026-01-26) standardizes exactly (a) and (b) — UI resources in tool results, sandboxed iframes, a bidirectional UI↔host JSON-RPC channel that is a plausible (c) substrate. But **every shipping host is a GUI chat app** (Claude web/desktop, ChatGPT, Goose, VS Code, LibreChat…). No terminal host — not Claude Code, Codex CLI, or Gemini CLI — renders MCP Apps today.

Everything else is either tiny (direct attempts at this idea exist with 0–9 stars), one-directional (diagram-canvas MCPs with no ask-backs; feedback MCPs with no canvas), or a different product (session-manager GUIs, web chat UIs that replace the terminal, browser-automation MCPs pointed the other way).

The unclaimed sliver: **a local canvas + selection-anchored ask-backs that land in the user's own existing terminal conversation, general-purpose (docs/diagrams/dashboards, not just design), as a plain MCP plugin.** Each half of that loop is proven separately in popular tools; no one has shipped the combination.

---

## Tier 1: near-solvers

### nexu-io/open-design — the 90% competitor

- **Repo:** [github.com/nexu-io/open-design](https://github.com/nexu-io/open-design) — **78,073 stars**, 9k forks, pushed 2026-07-14 (same day as this research). Apache-2.0. Latest release v0.14.1 (2026-07-10).
- **What it is:** "The open-source Claude Design alternative. Local-first desktop app. Your coding agent becomes the design engine: prototypes, landing pages, dashboards, slides, images & video — real files, HTML/PDF/PPTX/MP4 export. Claude Code / Codex / Cursor / Gemini / OpenCode / Qwen & 20+ CLIs via BYOK" ([README](https://github.com/nexu-io/open-design)).
- **Architecture** ([docs/architecture.md](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md)): a web app plus a local daemon (localhost:7456). The daemon uses **agent adapters** that detect the target CLI on PATH and "spawn the CLI with a standardized wrapper prompt + skill context + design-system context." The desktop app "is a thin wrapper around the OD CLI" ([v0.8.0 release](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.8.0)). An `od mcp install <agent>` path also exists for MCP clients to "do real workspace work — write files, delete files, resolve the active project directory" (v0.9.0, [CHANGELOG](https://github.com/nexu-io/open-design/blob/main/CHANGELOG.md)).
- **Rendering boundary:** previews are "always an `<iframe sandbox="allow-scripts">` — no `allow-same-origin`," loaded via `srcdoc` ([architecture.md](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md)). Real (b).
- **Ask-backs:** yes, and element-anchored: in-context comments on the preview shipped in v0.7.0 (#1276), with a comment-attachment API in v0.9.0 ([CHANGELOG](https://github.com/nexu-io/open-design/blob/main/CHANGELOG.md)). Mechanism per architecture.md: "Click captures `[data-od-id]` on preview DOM, opens a popover, sends `{artifact_id, element_id, note}` to daemon → agent gets a surgical edit instruction." There is also an inspect/tweaks mode for direct per-element style edits without round-tripping through the agent.
- **Coverage:** (a) **yes** — within its design-artifact domain. (b) **yes**. (c) **yes, but into its own loop**: the daemon re-invokes an agent adapter with a constrained edit prompt; comments do not land in an external, user-owned terminal session, and the docs describe no notification mechanism for external agents. (d) **partial**: the MCP integration gives your terminal agent workspace tools, but the canvas + comment loop belongs to the daemon-orchestrated model — open-design owns the agent invocation, your terminal conversation doesn't.
- **Distinguishing line:** open-design is a *design studio that uses your agent CLI as an engine*. The proposed project is a *canvas that your live agent session uses as an output+input surface*. Same parts, inverted ownership.

### Claude Code Artifacts — the official feature (cloud, one-way)

- **Docs:** [code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts); announcement: [claude.com/blog/artifacts-in-claude-code](https://claude.com/blog/artifacts-in-claude-code) (launched in beta for Team/Enterprise June 2026, per the blog and [press coverage](https://www.techtimes.com/articles/318691/20260619/claude-code-artifacts-turns-ai-coding-sessions-live-shareable-browser-pages.htm); docs now list Pro/Max/Team/Enterprise).
- **What it is:** "An artifact is a live, interactive web page that Claude Code publishes from your session to a private URL on claude.ai. You open it in a browser, and it updates in place as the session continues." Claude writes an HTML/Markdown file locally, then publishes; each publish is a version; viewers see updates live. Use cases named in the docs are precisely this project's: annotated PR walkthroughs, dashboards from session data, side-by-side design options, investigation timelines.
- **Rendering boundary:** strict CSP ("blocks scripts, stylesheets, fonts, and images loaded from any other host, along with fetch, XHR, and WebSocket calls"), served from a sandboxed `*.claudeusercontent.com` origin ([docs](https://code.claude.com/docs/en/artifacts)).
- **Not local:** "Artifact content is stored on Anthropic-operated infrastructure." Requires a claude.ai-authenticated session; "sessions using an API key, gateway token, or cloud-provider credential cannot publish"; unavailable on Bedrock/Vertex/Foundry and under CMEK/HIPAA/Zero-Data-Retention orgs ([Availability](https://code.claude.com/docs/en/artifacts#availability)).
- **No ask-back channel:** the docs' "Bring the result back to your session" section is explicit that the loop closes by hand — "Ask for an export control that produces text you can paste into the terminal," e.g. a "Copy as prompt" button. No selection-anchored comments, no push back into the conversation.
- **Coverage:** (a) yes (cloud, not local). (b) yes. (c) **no** (manual copy-paste pattern only). (d) yes — it *is* the terminal agent's own feature.
- **Also relevant:** [Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs) (Anthropic Labs, research preview) is the closed-source cloud product with conversation + inline comments + direct edits on visual work — it is what open-design clones. Not open-source, not local, not a terminal-agent plugin, but it validates demand for the comment-on-artifact loop.

### MCP Apps (SEP-1865) + mcp-ui — the standard without a terminal host

- **Extension repo:** [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) — 2,572 stars, pushed 2026-07-08. Proposed 2025-11-21 as **SEP-1865** ([announcement](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/), [spec PR #1865](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865)), co-developed by the mcp-ui creators with Anthropic and OpenAI; declared the first official MCP extension, **stable as of spec version 2026-01-26** ([blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/), [overview](https://modelcontextprotocol.io/extensions/apps/overview)). (Note: the research brief said "SEP-1300"; no primary source uses that number — it is SEP-1865 everywhere.)
- **SDK:** [MCP-UI-Org/mcp-ui](https://github.com/idosal/mcp-ui) (redirects from idosal/mcp-ui) — 5,007 stars, pushed 2026-07-08. Server SDKs emit UI resources (`ui://`, `text/html;profile=mcp-app`, Remote-DOM); tools link via `_meta.ui.resourceUri`; hosts render in sandboxed iframes with a consent-gated postMessage/JSON-RPC channel for the UI to call tools.
- **The decisive fact:** the official [supported-hosts matrix](https://mcpui.dev/guide/supported-hosts) lists Claude (web/desktop), VS Code, Postman, Goose, MCPJam, LibreChat, mcp-use, Smithery, ChatGPT, Nanobot, fast-agent. **No terminal host.** The [launch post](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) names Claude web/desktop, Goose, VS Code Insiders, ChatGPT. The [Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) contains no MCP Apps / UI-resource rendering entries. The [OpenAI Apps SDK](https://developers.openai.com/apps-sdk/) renders in ChatGPT web/mobile only.
- **Coverage:** (a) yes by design; (b) yes; (c) partial substrate (UI→host tool calls exist; no selection-anchored ask-back primitive); (d) **no terminal host implements the rendering side** — a terminal cannot host an iframe.
- **Strategic implication:** the proposed project is essentially "the missing MCP Apps-class rendering surface for terminal hosts, delivered as a local browser sidecar." Building *on* the MCP Apps resource format rather than inventing a new artifact schema would ride the standard.

---

## Tier 2: direct attempts at this exact idea (all tiny)

These prove people want this and that nobody has won.

| Project | Stars | What it does | Gaps vs. core loop |
|---|---|---|---|
| [saidmukhamad/serve-mcp](https://github.com/saidmukhamad/serve-mcp) | **1**, pushed 2026-07-11 | "Local, MCP-controlled artifact shelf": agents publish HTML/MD/JSON/CSV/folders to stable URLs on 127.0.0.1:7331; sandboxed iframes with `script-src 'none'` CSP ([Glama listing](https://glama.ai/mcp/servers/saidmukhamad/serve-mcp)) | (a)(b)(d) yes; (c) none — one-way shelf |
| [minhajuddin/htmlrenderermcp](https://github.com/minhajuddin/htmlrenderermcp) | **0**, pushed 2026-03-14 | `render_html` MCP tool → serves at localhost:8080, auto-opens browser | No sandboxing documented, no feedback channel |
| [parkerhancock/browser-canvas](https://github.com/parkerhancock/browser-canvas) | **9**, pushed 2026-01-21 | Claude Code *skill*: Bun server watches `.claude/artifacts/`, hot-reloads React/HTML in browser; two-way state via `_state.json`, user events logged to `_log.jsonl` for the agent to read | Closest architecture to the proposed loop, incl. a crude (c) — but events are a poll-a-file log, not selection-anchored ask-backs into the conversation; no sandbox; ~zero adoption |
| [seanivore/mcp-file-preview](https://github.com/seanivore/mcp-file-preview) | trivial | Screenshots local HTML files for the agent | Agent-facing, not a human canvas |

## Tier 3: half the loop, popular

### Live diagram-canvas MCPs — (a)+(d) for diagrams, no (c)

- **[yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)** — **2,159 stars**, pushed 2026-07-06. MCP server + Claude Code skill; live Excalidraw canvas at 127.0.0.1:3000 with WebSocket sync; 26 tools (element CRUD, layout, `get_canvas_screenshot`, Mermaid conversion). Explicitly targets Claude Code/Codex/Cursor. **No mechanism for the human viewer to send feedback or selections back to the agent** (repo README). Diagrams only, not general artifacts.
- **[lgazo/drawio-mcp-server](https://github.com/lgazo/drawio-mcp-server)** — **1,315 stars**, pushed 2026-07-11. Same shape for draw.io.
- **[antvis/mcp-server-chart](https://github.com/antvis/mcp-server-chart)** — **4,234 stars**. Generates 25+ chart types, but returns rendered chart images/URLs into the chat — a rendering service, not a persistent local canvas, no feedback loop. (Same for [mcp-vegalite-server](https://github.com/isaacwasserman/mcp-vegalite-server), 101 stars.)

### Human-feedback MCPs — (c)+(d) without a canvas

- **[Minidoracat/mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced)** — **3,791 stars**, pushed 2026-05-02. Agent calls an MCP tool that blocks while the user responds in a local Web UI/desktop window; the response returns as the tool result, landing directly in the agent conversation. This proves the exact transport the proposed project needs for ask-backs — an MCP tool call as the return channel. But there is no artifact canvas and nothing selection-anchored: it's a text box.
- Same family: [noopstudios/interactive-feedback-mcp](https://github.com/noopstudios/interactive-feedback-mcp) (1,718 stars, dormant since 2025-05), [ttommyth/interactive-mcp](https://github.com/ttommyth/interactive-mcp) (352 stars), [XIADENGMA/ai-intervention-agent](https://github.com/XIADENGMA/ai-intervention-agent), [mrexodia/user-feedback-mcp](https://github.com/mrexodia/user-feedback-mcp) (52 stars).

### Session-manager GUIs — different product entirely

These wrap or orchestrate agent sessions; none is an artifact canvas.

- **[winfunc/opcode](https://github.com/winfunc/opcode)** (formerly Claudia) — **22,174 stars**, but pushed 2025-10-16 (stale ~9 months). Tauri desktop GUI for Claude Code: session management, custom agents, usage tracking.
- **[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)** — **27,374 stars**, pushed 2026-04-24. Kanban orchestration of many agent tasks.
- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (CloudCLI) — **12,630 stars**, active. Web/mobile remote control of Claude Code/Codex sessions — replaces the terminal view, doesn't add a canvas.
- Smaller: [asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck) (498 stars, tmux TUI session manager), [stravu/crystal](https://github.com/stravu/crystal) (3,100 stars, now Nimbalyst, parallel worktree sessions), [puritysb/AgentDeck](https://github.com/puritysb/AgentDeck) (128 stars, Stream Deck/hardware status surfaces), [adrirubio/claude-deck](https://github.com/adrirubio/claude-deck) (19 stars, config dashboard).

---

## Tier 4: adjacent-but-different (explicitly not it, and why)

Detail verified against each repo/docs 2026-07-14 (subagent sweep; axes = (a)(b)(c)(d)).

- **Browser-automation MCPs** — the browser as the *agent's* effector, not the human's display. [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) (35,069 stars): `browser_navigate`/`click`/`snapshot` tools over accessibility snapshots. [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (46,922 stars): "lets your coding agent control and inspect a live Chrome browser" — performance traces, network, console. Neither publishes anything to a human nor has an ask-back. Opposite direction of the loop.
- **Web chat UIs** — they replace the terminal; the chat *is* the interface. [Open WebUI](https://github.com/open-webui/open-webui) (145,396 stars) has a real Artifacts panel ([docs](https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/artifacts/)) rendered in a sandboxed `srcdoc` iframe with configurable CSP — good (a)+(b), but only inside its own chat; attaching Claude Code means re-hosting the agent loop via a community pipe ([tfriedel/openwebui-claude-code](https://github.com/tfriedel/openwebui-claude-code)), losing the terminal session. [LibreChat](https://github.com/danny-avila/LibreChat) (40,718 stars) has [artifacts via Sandpack](https://www.librechat.ai/docs/features/artifacts) and is an MCP Apps host — same story. [Chainlit](https://github.com/Chainlit/chainlit) (12,303 stars) is a build-your-own-chat-app framework; custom JSX elements run in the app's own React tree (no untrusted-content boundary).
- **Notebooks/canvas products** — human-driven document models, not publish targets for an external terminal agent. [JupyterLab](https://github.com/jupyterlab/jupyterlab) (15,230 stars; outputs execute with full page privileges), [marimo](https://github.com/marimo-team/marimo) (21,825 stars), [tldraw/make-real](https://github.com/tldraw/make-real) (5,437 stars, quiet since 2026-02; direction is human-sketch → model-HTML, one-shot).
- **Diagram renderers** — no agent loop at all: [mermaid-live-editor](https://github.com/mermaid-js/mermaid-live-editor) (6,677 stars), [Excalidraw](https://github.com/excalidraw/excalidraw) itself (127,452 stars, human whiteboard), [Kroki](https://github.com/yuzutech/kroki) (4,240 stars, stateless source→SVG HTTP service — a useful *component* of a canvas).
- **App frameworks** — developer-authored apps, not agent-published artifacts: [Streamlit](https://github.com/streamlit/streamlit) (45,230 stars), [Gradio](https://github.com/gradio-app/gradio) (43,130 stars). Gradio's [`mcp_server=True`](https://www.gradio.app/guides/building-mcp-server-with-gradio) exposes app functions *as tools to* the agent — the inverse direction.

---

## Gap analysis

**Status: PARTIALLY FILLED.** Not unfilled — three heavyweight players sit on top of this space — and not solved, because no tool closes the specific loop.

| Axis | Best existing coverage | What's missing |
|---|---|---|
| (a) local artifact canvas | open-design (78k★, localhost:7456, design artifacts); Claude Code Artifacts (official, but cloud-hosted); mcp_excalidraw (diagrams only); serve-mcp/browser-canvas (general, ~0★) | A *popular, general-purpose, local* one. Every popular option is either cloud, design-scoped, or diagram-scoped |
| (b) safe rendering boundary | Solved repeatedly: sandboxed `srcdoc`/`allow-scripts` iframes + CSP in open-design, Open WebUI, serve-mcp; MCP Apps standardizes it | Nothing — this is a known pattern to copy, and MCP Apps gives it a spec |
| (c) selection-anchored ask-backs | open-design: element-anchored comments (`[data-od-id]` → surgical edit instruction), **but routed to its own daemon-spawned agent**; mcp-feedback-enhanced (3.8k★): blocking-MCP-tool ask-backs into your real session, **but text-only, no canvas, no anchoring**; Claude Code Artifacts: manual "Copy as prompt" | The combination: an anchored selection on a rendered artifact that lands in the *user's live terminal conversation*. Nobody has both halves |
| (d) plugin to existing terminal agent | Feedback MCPs and diagram MCPs are true plugins; Claude Code Artifacts is native; MCP Apps defines the plugin protocol | A canvas that is a plugin. open-design inverts ownership (it drives the CLI); web UIs replace the terminal; MCP Apps has no terminal host |

**Honest assessment of the threat surface:**

- **open-design is one feature away.** If it routes preview comments into an externally owned agent session (e.g., via an MCP ask-back tool) instead of its own adapters, it covers the loop for design artifacts — and at 78k stars with daily pushes, it can ship that quickly. The defensible difference is scope (engineering communication artifacts: design docs, flowcharts, investigation dashboards, before/after diffs — not landing pages and decks) and ownership model (your session stays primary).
- **Anthropic is one feature away twice.** Claude Code Artifacts + a comment channel would close the loop cloud-side; and if Claude Code ever renders MCP Apps, the standard's UI→host channel arrives in the terminal natively. Both are plausible roadmap items. A local-first, provider-agnostic tool (works with API-key/Bedrock sessions where Artifacts is unavailable, works with Codex/Gemini CLIs) is the durable positioning.
- **The build path is de-risked by prior art:** MCP Apps resource format for artifacts (a, b), the mcp-feedback-enhanced blocking-tool pattern for the return channel (c), and open-design's `[data-od-id]` element-anchoring trick for selections. All three patterns are proven in tools with 2.5k–78k stars; the synthesis is what doesn't exist.

**One-line answer:** the niche is *partially filled from three directions but the exact intersection — local canvas, selection-anchored ask-backs into your own terminal session, as a plain MCP plugin — is open*, with the caveat that it sits in the expansion path of both open-design and Anthropic.

## Sources

Primary sources cited inline throughout. Key ones: [open-design repo](https://github.com/nexu-io/open-design) / [architecture.md](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md) / [CHANGELOG](https://github.com/nexu-io/open-design/blob/main/CHANGELOG.md); [Claude Code artifacts docs](https://code.claude.com/docs/en/artifacts) / [blog](https://claude.com/blog/artifacts-in-claude-code); [MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/) / [stable release](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) / [ext-apps repo](https://github.com/modelcontextprotocol/ext-apps) / [mcp-ui host matrix](https://mcpui.dev/guide/supported-hosts); [Claude Design announcement](https://www.anthropic.com/news/claude-design-anthropic-labs); GitHub API for all star/activity figures (2026-07-14).
