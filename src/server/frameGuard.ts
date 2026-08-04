// Ingest guard for the free-form HTML hatch (issue 25). The frame is served with
// sandbox="allow-scripts", so a `<meta http-equiv=refresh>` FIRES with no click
// and no script, and the header CSP does NOT govern top-level navigation — that
// is a no-click network-egress hole. Connection-hint `<link>`s are the same
// class (no-click DNS/TCP). Regex stripping proved BYPASSABLE (a `>` inside a
// quoted attribute value, or an entity-encoded keyword), and silently altering
// the artifact violates reject-not-drop. So we REJECT at ingest instead, with a
// small ZERO-DEP scanner that parses tags the way a browser does on the two axes
// that broke the regex: quote-aware tag termination + entity-decoded values.
//
// Fail closed: a `<meta>`/`<link>` that cannot be confidently parsed is rejected.
// Conservative false-positives are acceptable — the agent re-authors.

export interface FrameGuardViolation {
  code: string;
  detail: string;
}

/** rel keywords that trigger no-click network egress. */
const HINT_RELS = new Set([
  "dns-prefetch",
  "preconnect",
  "prefetch",
  "prerender",
  "preload",
  "modulepreload",
]);

/** A small named-entity table — enough to catch the characters an attacker would
 *  use to obfuscate a keyword or a URL scheme. Numeric/hex entities are decoded
 *  generally below; over-decoding only makes rejection MORE likely (conservative). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  semi: ";",
  num: "#",
  period: ".",
  lpar: "(",
  rpar: ")",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
};

/** Decode HTML character references (numeric `&#dd;`, hex `&#xhh;`, and the named
 *  set above). Permissive by design: decoding MORE than a given browser would
 *  can only widen what we reject. */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = body.slice(isHex ? 2 : 1);
        const code = parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? whole;
    },
  );
}

const WS = new Set([" ", "\t", "\n", "\f", "\r"]);

interface ParsedTag {
  attrs: Map<string, string>;
  /** Index just past the tag's closing `>` (or end-of-input on failure). */
  end: number;
  /** True when the tag could not be confidently parsed (unterminated quote or
   *  no closing `>`) → fail closed. */
  failed: boolean;
}

/** Parse a start tag's attributes from `from` (just after the tag name),
 *  QUOTE-AWARE: a `>` inside a single/double quoted value does NOT end the tag. */
function parseTag(html: string, from: number): ParsedTag {
  const attrs = new Map<string, string>();
  const n = html.length;
  let i = from;
  while (i < n) {
    while (i < n && WS.has(html[i]!)) i++;
    if (i >= n) return { attrs, end: n, failed: true };
    const ch = html[i]!;
    if (ch === ">") return { attrs, end: i + 1, failed: false };
    if (ch === "/") {
      if (html[i + 1] === ">") return { attrs, end: i + 2, failed: false };
      i++; // stray slash acts as an attribute separator
      continue;
    }
    // Attribute name.
    const nameStart = i;
    while (
      i < n &&
      !WS.has(html[i]!) &&
      html[i] !== "=" &&
      html[i] !== ">" &&
      html[i] !== "/"
    ) {
      i++;
    }
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < n && WS.has(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && WS.has(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close === -1) return { attrs, end: n, failed: true }; // unterminated
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valStart = i;
        while (i < n && !WS.has(html[i]!) && html[i] !== ">") i++;
        value = html.slice(valStart, i);
      }
    }
    if (name) attrs.set(name, value);
  }
  return { attrs, end: n, failed: true };
}

/** An href is "external" when — after entity-decoding and stripping control/space
 *  chars (which browsers ignore in URLs) — it carries a scheme or is
 *  protocol-relative. Same-document (`#…`) and relative paths are allowed
 *  (external subresources are CSP-blocked anyway, so a legit page needs none). */
function isExternalHref(raw: string): boolean {
  const decoded = decodeEntities(raw)
    .replace(/[\u0000-\u0020]/g, "")
    .toLowerCase();
  return /^[a-z][a-z0-9+.-]*:/.test(decoded) || decoded.startsWith("//");
}

function checkMeta(attrs: Map<string, string>, out: FrameGuardViolation[]): void {
  // Reject ANY http-equiv (refresh, and there is no legitimate need — the shell
  // supplies charset + viewport). Attribute NAMES are not entity-decoded by
  // browsers, so matching the literal (lowercased) name is sound.
  if (attrs.has("http-equiv")) {
    out.push({
      code: "meta-http-equiv",
      detail:
        "<meta http-equiv=…> is not allowed — it enables no-click navigation " +
        "(refresh) that would break the no-network guarantee. The frame shell " +
        "already provides charset and viewport.",
    });
  }
}

function checkLink(attrs: Map<string, string>, out: FrameGuardViolation[]): void {
  const rel = attrs.get("rel");
  if (rel !== undefined) {
    const tokens = decodeEntities(rel).toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (HINT_RELS.has(t)) {
        out.push({
          code: "link-rel-hint",
          detail: `<link rel="${t}"> performs no-click network egress and is not allowed.`,
        });
        break;
      }
    }
  }
  const href = attrs.get("href");
  if (href !== undefined && isExternalHref(href)) {
    out.push({
      code: "link-external-href",
      detail:
        "<link> with an external href is not allowed — external subresources " +
        "are CSP-blocked and unnecessary; drop the link.",
    });
  }
}

/**
 * Scan model HTML for no-click network-egress constructs. Returns the violations
 * (empty ⇒ clean). Quote-aware tag walking + entity-decoded values close the two
 * bypass classes that defeated regex stripping.
 */
export function scanHtmlForEgress(html: string): FrameGuardViolation[] {
  const out: FrameGuardViolation[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (i >= n) break;
    const c = html[i]!;
    // Comments / declarations / PIs — skip (their contents are not tags).
    if (c === "!") {
      if (html.startsWith("!--", i)) {
        const close = html.indexOf("-->", i + 3);
        i = close === -1 ? n : close + 3;
      } else {
        const gt = html.indexOf(">", i);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (c === "/" || c === "?") {
      const gt = html.indexOf(">", i);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(c)) continue; // `<` not opening a tag
    let j = i;
    while (j < n && /[a-zA-Z0-9]/.test(html[j]!)) j++;
    const name = html.slice(i, j).toLowerCase();
    const isMeta = name === "meta";
    const isLink = name === "link";
    // Every start tag is parsed quote-aware so a `>` inside another tag's quoted
    // value can never be mistaken for a tag boundary.
    const tag = parseTag(html, j);
    if (isMeta || isLink) {
      if (tag.failed) {
        out.push({
          code: isMeta ? "meta-unparseable" : "link-unparseable",
          detail: `<${name}> could not be safely parsed and is rejected (fail-closed).`,
        });
      } else if (isMeta) {
        checkMeta(tag.attrs, out);
      } else {
        checkLink(tag.attrs, out);
      }
    }
    i = tag.end;
  }
  return out;
}
