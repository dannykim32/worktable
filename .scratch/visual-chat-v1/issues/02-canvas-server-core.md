# 02 — Canvas Server core: MCP stdio + authed 127.0.0.1 HTTP

Status: done
Type: task
Milestone: M1
Blocked by: 01

## Context

ADR-0003: one MCP server owns both the typed tools and the local HTTP server the
browser talks to. ADR-0005: every browser endpoint requires a per-workspace capability
token; 127.0.0.1 bind + Host allowlist.

## Implementation Details

**Workspace identity.** `workspaceId = sha256(realpath(cwd)).slice(0, 12)`. State dir:
`~/.visual-chat/<workspaceId>/`, created 0700. Token: 32 random bytes (crypto),
base64url, stored at `<dir>/token` 0600; loaded if present (per-workspace persistence,
ADR-0005). A `rotate_token` MCP tool regenerates it.

**MCP server (stdio).** `@modelcontextprotocol/sdk` Server named `visual-chat`.
Tools in this issue: `open_canvas` (returns + OS-opens the tokened URL via `open`
on darwin, `xdg-open` on linux) and `rotate_token`. Artifact tools land in 03.

**HTTP server.** `node:http`, bind `127.0.0.1`, default port 8787; if taken, scan up
to 8887 and record the chosen port in `<dir>/port`. Middleware order:
1. Host allowlist: `Host` must be `127.0.0.1[:port]` or `localhost[:port]` → else 403.
2. Auth: `GET /` accepts `?token=` (the openable URL); the served page keeps the token
   in JS memory and sends `Authorization: Bearer <token>` for everything else. All
   other routes require the bearer header → else 401. Constant-time comparison.
3. Security headers on every response, including CSP:
   `default-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self';
   style-src 'self' 'unsafe-inline'` (inline styles are ours; no remote anything).

Routes in this issue: `GET /` (serves built canvas from `dist/canvas/`),
`GET /api/health` (authed, returns `{workspaceId, version}`).

**Lifecycle.** HTTP server starts when the MCP server starts, stops on stdio close.
Log to stderr only (stdout is the MCP transport).

## Acceptance Criteria

1. `curl http://127.0.0.1:8787/api/health` → 401; with wrong token → 401; with correct
   bearer → 200 JSON.
2. `curl -H "Host: evil.test" …` with valid token → 403 (DNS-rebinding defense).
3. Binding is 127.0.0.1 only: connecting via the machine's LAN IP fails.
4. `~/.visual-chat/<id>/` is 0700; `token` is 0600 (asserted in a test via fs.stat).
5. `GET /?token=<correct>` serves the canvas HTML; `GET /` without → 401.
6. `open_canvas` returns a URL that loads in a browser; `rotate_token` invalidates the
   old token (old bearer → 401 immediately).
7. Port collision test: with 8787 occupied, server binds 8788 and health passes.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | token mint/load/rotate, workspaceId derivation, host allowlist fn | +4 |
| Integration | spawn server, run criteria 1–3, 5–7 over real HTTP | +6 |

## Effort

~4h: 1.5h MCP+HTTP plumbing, 1h auth middleware + headers, 1.5h tests.

## Out of Scope

Artifacts/SSE (03), any UI beyond the served stub (04).

## Comments

Implemented workspace identity/token (src/server/workspace.ts), authed HTTP surface
(src/server/http.ts), MCP plumbing + open_canvas/rotate_token (src/server/mcp.ts,
index.ts). All 7 criteria covered: 6 unit + 6 integration tests over real HTTP/stdio.
One forced clarification: the exact CSP (`script-src 'self'`) forbids inline scripts,
so the built canvas JS loads as a subresource — which cannot carry a bearer header.
Canvas static assets therefore also accept `?token=` (server injects it into asset
URLs when serving index.html); /api/* remains bearer-only. Same capability posture as
`GET /?token=`, verified 401 without it. open_canvas also honors VISUAL_CHAT_NO_OPEN=1
so tests never launch a browser.
