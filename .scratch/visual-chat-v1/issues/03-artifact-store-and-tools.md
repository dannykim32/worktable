# 03 — Artifact store + publish/update tools + SSE

Status: done
Type: task
Milestone: M1
Blocked by: 02

## Context

ADR-0006: artifacts are stable identities with versioned in-place updates, atomic,
persisted. Component Artifacts are the JSON arguments of typed MCP tools — schema
validation at the boundary IS the safety mechanism (ADR-0003). Honest absence is a
first-class artifact, not an error (CONTEXT.md).

## Implementation Details

**Schemas (JSON Schema, enforced via the SDK's tool inputSchema).**

`publish_artifact` input — one of:

```jsonc
// type: "document"
{ "type": "document", "title": "string (1..200)",
  "blocks": [ // 1..200 items
    { "kind": "heading",   "level": 1|2|3, "text": "string" },
    { "kind": "paragraph", "text": "string (plain text, no markup)" },
    { "kind": "callout",   "tone": "info"|"warn", "text": "string" },
    { "kind": "code",      "lang": "string?", "text": "string" },
    { "kind": "table",     "header": ["string"], "rows": [["string"]] },
    { "kind": "list",      "ordered": "boolean", "items": ["string"] } ] }
// type: "absence"  — honest refusal, first-class (never an error)
{ "type": "absence", "title": "string", "reason": "string (1..2000)" }
```

Returns `{ artifact_id, version: 1, url }`. `update_artifact` takes
`{ artifact_id, ...same content fields }`, returns `{ artifact_id, version: N }`.
`additionalProperties: false` everywhere; unknown kind/field → schema rejection with
the JSON path in the tool error (reject-not-drop applies to structure too).

**Storage.** `<dir>/artifacts/<artifact_id>/v<N>.json` (full content, atomic
tmp+rename) + `meta.json` `{ id, type, title, latest, created_at, updated_at }`.
`artifact_id = "a_" + 8 hex random`. Timestamps ISO-8601 UTC.

**HTTP routes (bearer-authed).**
- `GET /api/artifacts` → `[meta…]` sorted by updated_at desc
- `GET /api/artifacts/:id` → meta + latest content
- `GET /api/artifacts/:id/v/:n` → that version's content
- `GET /api/events` → SSE; on publish/update emit
  `event: artifact\ndata: {"artifact_id","version","type"}`

**First publish** auto-opens the canvas (same mechanism as `open_canvas`) unless env
`VISUAL_CHAT_NO_OPEN=1`.

## Acceptance Criteria

1. publish → v1 on disk; update → v2 on disk AND v1 still readable via `/v/1` (ADR-0006).
2. Invalid input (unknown block kind, extra field, empty title) → tool error naming the
   JSON path; nothing written to disk.
3. SSE client connected during update receives the event within 500ms.
4. `absence` publishes and lists like any artifact.
5. Kill -9 during publish leaves no torn `v<N>.json` (atomic rename verified by test
   that interrupts between tmp write and rename).
6. All routes 401 without bearer.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | schema validation cases (each block kind + 6 rejects), id gen, atomic write | +10 |
| Integration | publish→update→read-both-versions over MCP+HTTP; SSE delivery | +4 |

## Effort

~5h: 1.5h schemas/tools, 1.5h store, 1h SSE, 1h tests.

## Out of Scope

Rendering (04), dashboard/compare/svg types (07/08/10), inline text formatting
(plain text only in v1 — noted for future).

## Comments

Built src/server/{validate,store,sse}.ts + shared types, wired publish_artifact/
update_artifact tools and the four HTTP routes into index.ts. Validation is a
dependency-free structural checker mirroring the declared JSON Schemas (the SDK
declares but does not enforce inputSchema server-side); every rejection carries the
JSON path, e.g. `/blocks/1/kind`. Atomicity criterion 5 verified by an injected
interrupt at the commit point (between tmp write and rename) rather than a literal
kill -9 — same guarantee, deterministic. One tightening: update_artifact rejects a
type change (stable identity per ADR-0006). 11 unit + 5 integration tests added.

Review follow-ups (behavior changes): the type-stability rejection moved INTO
ArtifactStore.update (throws ArtifactTypeMismatchError; handler maps to a tool
error), and the first-publish auto-open is now an explicit, publish-only side effect
— updates never open a browser, matching this issue's "First publish auto-opens"
exactly (previously any first event after a restart, including an update, opened it).
