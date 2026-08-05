# 01 — Scaffold: package + TS/Vite/bun-test toolchain

Status: done
Type: task
Milestone: M1

## Context

Greenfield repo (docs only). Everything downstream needs a build/test skeleton that
matches the settled stack: Node 20+ runtime, TypeScript, Vite-built vanilla-TS canvas,
bun as dev runner. Placeholder name "visual-chat" — private, never published.

## Proposed Change

Create:

| File | Purpose |
|------|---------|
| `package.json` | `"name": "visual-chat"`, `"private": true`, scripts below |
| `tsconfig.json` | strict, NodeNext modules, target ES2022 |
| `src/server/index.ts` | entry stub: prints version, exits 0 |
| `src/canvas/index.html` + `src/canvas/main.ts` | Vite root stub rendering "canvas up" |
| `src/canvas/vite.config.ts` | build → `dist/canvas/` |
| `src/sanitizer/` | empty dir with `.gitkeep` (issue 09 fills it) |
| `test/smoke.test.ts` | asserts true; proves bun test wiring |
| `.gitignore` | `node_modules/`, `dist/`, `.visual-chat/` (defense-in-depth) |

Scripts: `dev` (vite dev for canvas), `build` (tsc server + vite build canvas),
`test` (bun test), `start` (node dist/server/index.js).

Dependencies: `@modelcontextprotocol/sdk` (runtime); `typescript`, `vite`,
`@types/node` (dev). Nothing else. No linter in v1.

## Acceptance Criteria

1. `bun install && bun run build` exits 0 and produces `dist/server/` + `dist/canvas/`.
2. `bun test` runs and passes the smoke test.
3. `node dist/server/index.js` prints a version string and exits 0.
4. `package.json` has `"private": true` and placeholder name.
5. Dependency list is exactly as specified above (no extras).

## Effort

~1.5h total: 1h config + stubs, 0.5h verifying build outputs.

## Out of Scope

Any server logic (02), any real canvas rendering (04), linting/CI.

## Comments

Built as specified: package.json (private, placeholder name, exact dep list), strict
NodeNext tsconfig, server stub (version banner to stderr — stdout stays reserved for
the MCP transport), Vite canvas stub, sanitizer .gitkeep, smoke test. Two small
additions: `src/canvas/tsconfig.json` (noEmit, DOM lib) so the canvas code typechecks
in `build` — cross-cutting criterion 5 requires zero TS errors and Vite alone never
typechecks; and `.gstack/` in .gitignore (approved deviation, local tool state).
Verified: build produces dist/server + dist/canvas, stub prints version and exits 0,
bun test green.
