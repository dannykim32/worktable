# 09 — SVG sanitizer: zero-dep, re-serializing, reject-not-drop

Status: ready-for-agent
Type: task
Milestone: M3
Blocked by: 02

## Context

The single last boundary before the browser (CONTEXT.md: Canvas Server). Prior-project
doctrine, carried forward intact: allowlist a strict subset, re-serialize (never pass
input through), reject the whole artifact on anything unknown (a silently-stripped
artifact can tell an untrue story), char-allowlist every attribute value. Zero runtime
dependencies — this module is hand-audited.

## Implementation Details

`src/sanitizer/` — API:

```ts
sanitizeSvg(input: string): { ok: true, svg: string }
                          | { ok: false, violations: { code: string, path: string,
                                                       detail: string }[] }
```

**Parser:** own minimal XML tokenizer/parser for the SVG subset (no DOMParser — the
server has no DOM; no dependency). Hard caps first: input ≤256KB, ≤5,000 elements,
depth ≤32, attr value ≤4KB — exceeding any is a violation, not a truncation.

**Element allowlist:** `svg g rect circle ellipse line polyline polygon path text
tspan defs marker title desc`. Everything else — including `foreignObject`, `use`,
`image`, `style`, `script`, `animate*`, `filter` — is a violation.

**Attribute allowlist per element** (shared geometry/paint set): `x y x1 y1 x2 y2 cx
cy r rx ry width height points d transform viewBox fill stroke stroke-width
stroke-dasharray stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity
font-size font-family font-weight font-style text-anchor dominant-baseline
marker-end marker-start id` (id: `[a-zA-Z][\w-]{0,63}`). NO `style`, NO `href`/
`xlink:href`, NO event attributes (`on*` is a violation by prefix), NO `class`.

**Value char-allowlists (regex per attribute family):**
- numbers/lists (`points`, coords, sizes): `[0-9eE+\-., ]`
- `d`: `[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., ]`
- `transform`: `translate|rotate|scale|matrix` forms with numeric args only
- paint (`fill`, `stroke`): `none`, `#hex{3,6,8}`, `rgb()/rgba()` numeric, or a
  16-name color allowlist. NO `url(…)` anywhere (kills beacon/reference smuggling).
- `font-family`: `[a-zA-Z0-9 ,-]` (no quotes needed post-normalization)

**Content:** text nodes allowed only inside `text/tspan/title/desc`; entity forms
allowed: `&amp; &lt; &gt; &quot; &apos;` + numeric for those five only. CDATA,
comments, processing instructions, DOCTYPE → violations.

**Re-serialization:** emit from the AST with our own writer — canonical attribute
order, all text re-escaped. Input bytes never reach output.

**Hostile fixture suite** `test/fixtures/hostile/*.svg` — the spine, one file per
attack, each asserted `ok: false` (or provably inert where neutralization is the
claim): script element; onload/onclick; foreignObject+iframe; javascript: and data:
href; `use` recursion; entity expansion (billion laughs); CDATA script smuggle;
CSS url() beacon in fill/style; style element @import; animate-based attribute
injection; oversized (size/element/depth bombs); nested svg with xlink; comment-split
tokens; UTF-8 homoglyph element names; missing-quote attribute parsing tricks.
Plus a benign suite (the prototype's flowchart SVG must pass unchanged in meaning).

## Acceptance Criteria

1. Every hostile fixture → `ok: false` with a violation naming code + path.
2. Benign suite passes; output renders visually identical (manual check once).
3. Idempotence: `sanitize(sanitize(x).svg)` byte-equals `sanitize(x).svg` for the
   benign suite.
4. Property test: output never contains `<script`, `on[a-z]+=`, `url(`, `href`,
   case-insensitively, for 10k random mutations of benign fixtures (fuzz smoke).
5. `src/sanitizer/` imports nothing outside node builtins used for types; zero
   `package.json` runtime deps added.
6. Violations are precise enough for an agent to fix: include line/element path.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | tokenizer, each allowlist family, caps | +15 |
| Fixtures | hostile suite (≥15 files) + benign suite (≥5) | +20 |
| Fuzz | mutation smoke (criterion 4) | +1 |

## Effort

~10h: 3h parser, 2h allowlists + writer, 4h fixture suite, 1h fuzz harness. The
largest single issue — it is the security spine and is budgeted accordingly.

## Out of Scope

Rendering (10), legibility analysis (11), gradients/filters/animations (not in v1's
expressive subset — add via allowlist extension + fixtures if the pilot gallery
demands them).
