# PRD: Visual Chat v1

Status: ready-for-agent
Type: epic
Filed: 2026-07-14

## Context

Terminal LLM agents emit only text. The design phase (docs/adr/0001–0010, CONTEXT.md,
docs/research/local-canvas-landscape.md, judged prototype in prototype/canvas-vocabulary/)
defined a companion browser canvas: the agent publishes versioned visual artifacts via an
MCP server; the human reads them at a capability URL and sends selection-anchored
ask-backs home to the terminal conversation. The niche is unclaimed (closest: open-design,
whose comments feed its own agents; MCP Apps, specced but unhosted in terminals).

This repo is greenfield: no src/ exists. Every design decision is settled in the ADRs;
the issues below leave zero design decisions to the implementer.

## Definition of Done (v1)

1. Walking-skeleton demo passes end-to-end: agent publishes a Document artifact via MCP
   tool → renders in the browser at the tokened URL → user selects a paragraph and asks
   a question → agent receives it, with anchor, via check_askbacks next turn.
2. Dashboard, Compare, and sanitized SVG artifacts render.
3. Legibility gate runs report-only with a calibration gallery; enforcement + one bounded
   repair round activate only after human calibration sign-off.
4. Claude Code hook and request_review blocking mode work.
5. All issue-level acceptance criteria below green; `bun test` green throughout.

## Stack (settled 2026-07-14)

TypeScript + @modelcontextprotocol/sdk on Node 20+ (bun for dev/test). Canvas: vanilla
TS + Vite — components are pure render functions over artifact JSON, kept behind a
render-function interface so a dedicated visual library can replace internals later if
homegrown rendering proves insufficient. State: ~/.visual-chat/<workspace-id>/ (0700,
token 0600). Single package; "visual-chat" is a PLACEHOLDER name — do not publish to npm.

## Child Issues

| # | Title | Milestone | Blocked by |
|---|-------|-----------|------------|
| 01 | Scaffold: package + TS/Vite/bun-test toolchain | M1 | — |
| 02 | Canvas Server core: MCP stdio + authed 127.0.0.1 HTTP | M1 | 01 |
| 03 | Artifact store + publish/update tools + SSE | M1 | 02 |
| 04 | Document component renderer + gallery shell | M1 | 03 |
| 05 | Ask-back queue, anchors, composer, check_askbacks | M1 | 04 |
| 06 | Walking-skeleton E2E + Claude Code registration | M1 | 05 |
| 07 | Dashboard component | M2 | 04 |
| 08 | Compare component | M2 | 04 |
| 09 | SVG sanitizer (zero-dep, reject-not-drop, hostile fixtures) | M3 | 02 |
| 10 | SVG artifact type via image isolation | M3 | 09 |
| 11 | Legibility gate, report-only + calibration gallery | M4 | 10 |
| 12 | Gate enforcement + bounded repair round | M5 | 11 |
| 13 | Claude Code UserPromptSubmit hook | M6 | 05 |
| 14 | request_review blocking tool + review banner | M6 | 05 |

## Dependency Graph

```
01 → 02 → 03 → 04 → 05 → 06
           │     ├─→ 07
           │     └─→ 08
           02 → 09 → 10 → 11 → 12
                 05 ├─→ 13
                    └─→ 14
```

## Sequencing Rationale

M1 proves the full loop before any breadth — each M1 issue is unusable alone; together
they are the demo. Components (M2) precede SVG (M3) because they are additive renderers
with no new security surface. The sanitizer (09) precedes any SVG rendering (10) by
definition — it IS the boundary. The gate ships report-only (11) before it gains power
(12), per the calibrate-before-enforce doctrine (ADR-0007). Host-specific niceties (M6)
come last because the portable core must work without them.

## Out of Scope (v1)

Free-form HTML (ADR-0002), structured Diagram component (ADR-0007), native MCP Apps
hosting (ADR-0008), sketch aesthetic register (ADR-0009), interaction telemetry
(ADR-0010), browser chat client (ADR-0001), npm publishing, multi-user, remote access.

## Cross-Cutting Acceptance Criteria (apply to every issue)

1. All workspace state 0700 dirs / 0600 files.
2. Every browser-facing endpoint returns 401 without the capability token and 403 on
   non-allowlisted Host header (ADR-0005).
3. Zero runtime dependencies in the sanitizer module (ADR + prior doctrine).
4. Canvas page renders all artifact text via textContent/createElement — never innerHTML
   of model-influenced strings.
5. `bun test` green; no TypeScript errors.
