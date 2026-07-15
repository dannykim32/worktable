# 09 — SVG sanitizer: zero-dep, re-serializing, reject-not-drop

Status: done
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
  16-name color allowlist. NO `url(…)` here (kills beacon/reference smuggling).
- `marker-start`/`marker-end` ONLY: a validated same-document fragment reference
  `url(#id)` — the sole `url(` form permitted anywhere in the subset. Fully
  `^url\(#id\)$`-anchored (id charset `[a-zA-Z][\w-]{0,63}`), must resolve to a
  real `<marker>` element, inert under Image Isolation. This exception is what
  lets arrow-headed diagrams (incl. the mandated prototype flowchart) render;
  ratified by the owner 2026-07-15. Every other `url(` form is rejected.
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
4. Property test: output never contains `<script`, `on[a-z]+=`, `href`, or any
   `url(` EXCEPT the anchored `url(#id)` marker form above (property:
   `url\((?!#[a-zA-Z])`), case-insensitively, over 10k random mutations of benign
   fixtures (fuzz smoke). Text-node content is escaped/inert and excluded from the
   markup checks (Image Isolation).
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

## Comments

Done. `src/sanitizer/` is a self-contained, zero-dependency module (parse.ts
tokenizer/parser, allowlist.ts element/attribute/value allowlists + tree
validation, write.ts canonical writer, ast.ts exported types for issue 11,
index.ts the `sanitizeSvg` entry with the input-byte cap gate). Reject-not-drop
throughout; the AST writer is the sole producer of output bytes, so input bytes
never pass through. Caps are checked before structural work; exceeding one is a
violation, never a truncation.

Test suite (`test/svg-sanitizer.test.ts`, 78 tests): 16 hostile fixtures +
in-test size/element bombs, 5 benign fixtures (incl. the prototype flowchart,
which passes with meaning intact), idempotence, re-serialization proof,
tokenizer/allowlist/caps units, the 10k-mutation fuzz smoke, and the
zero-dependency guard (reads package.json + greps sanitizer imports).

Allowlist judgment calls (flagged for security review):
1. **Same-document marker references** `url(#id)` are permitted on
   `marker-start`/`marker-end` only — the sole `url(` form in the subset. The
   issue lists those two attributes in the allowlist and the prototype flowchart
   depends on arrowheads, yet also says "NO url(…) anywhere". Reconciled by
   allowing ONLY the fragment form, validated to resolve to an actual `<marker>`
   id (charset `[a-zA-Z][\w-]{0,63}`); every external/other `url(` is rejected.
   Same-document refs cannot beacon and are inert under Image Isolation. The
   AC4 fuzz property is therefore `url\((?!#[a-zA-Z])` (external url only) run
   against markup with text-node payloads stripped.
2. **Fuzz checks target markup, not displayed text.** An escaped label reading
   "url(x)" or "href" is inert characters in an image, so the on*/url/href
   checks run after removing text-node content; `<script` is checked raw
   (writer escaping already neutralizes it in text).
3. **`xmlns` on the root `<svg>`** is accepted (value must equal the SVG
   namespace) and the writer always emits it — a data:-URL `<img>` ignores an
   un-namespaced SVG. Not in the shared attribute list; treated as root-only.
4. **`marker`-only geometry attributes** (`refX refY markerWidth markerHeight
   orient`) are accepted on `<marker>` only. Needed for arrowheads; all
   numeric/fixed-keyword, no reference or script surface.
5. **Extra keyword value sets** beyond the issue's examples — `font-style`
   (normal/italic/oblique), `font-weight` (normal/bold/100–900),
   `dominant-baseline`, `stroke-linecap/linejoin` — are constrained to fixed
   enumerations. All appear in the prototype or are trivially inert.
6. **DOCTYPE is fatal** (stops parsing) rather than a recoverable violation,
   because a DOCTYPE can declare entities — refusing to interpret anything after
   it is what forecloses billion-laughs expansion.
