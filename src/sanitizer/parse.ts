// Hand-rolled XML tokenizer/parser for the SVG subset (issue 09). The server
// has no DOM and this module takes no dependencies, so the parser is our own:
// small, strict, single-pass. Anything outside the narrow grammar below is a
// violation — reject-not-drop, never repair, never guess.
//
// Grammar accepted (everything else violates):
//   document := ws? element ws?
//   element  := "<" name (ws attribute)* ws? ("/>" | ">" content "</" name ">")
//   attribute:= name ws? "=" ws? quoted-value          (quotes are mandatory)
//   content  := (text | element)*
//   text     := chars with only the five entities &amp; &lt; &gt; &quot;
//               &apos; (or their numeric forms) as escapes
// Comments, CDATA sections, processing instructions, and DOCTYPE are each a
// named violation, never skipped silently into acceptance.
import type { SvgAttribute, SvgElement, Violation } from "./ast.js";

// Hard caps. The input byte cap is enforced by sanitizeSvg() before this
// parser runs; the structural caps below are enforced the moment they are
// exceeded. Exceeding a cap is a violation, never a truncation.
export const SVG_INPUT_MAX_BYTES = 256 * 1024;
export const SVG_ELEMENT_MAX = 5000;
export const SVG_DEPTH_MAX = 32;
/** Cap on the raw (source) length of a single attribute value, in chars. */
export const SVG_ATTR_VALUE_MAX = 4096;

/** The only entities the subset admits, by name and by codepoint. */
const ENTITY_NAMES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const ENTITY_CODEPOINTS = new Set([38, 60, 62, 34, 39]); // & < > " '

export interface ParseOutcome {
  /** null when parsing failed structurally (violations explain why). */
  root: SvgElement | null;
  violations: Violation[];
}

export function parseSvg(input: string): ParseOutcome {
  return new Parser(input).parse();
}

/** Characters that terminate a tag or attribute name. Everything else —
 *  including non-ASCII homoglyphs — is read into the name so the allowlist
 *  stage can reject it with the exact offending name in the detail. */
function isNameEnd(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "/" ||
    ch === ">" ||
    ch === "=" ||
    ch === '"' ||
    ch === "'" ||
    ch === "<"
  );
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function clip(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Parser {
  private pos = 0;
  private line = 1;
  private elementCount = 0;
  private readonly violations: Violation[] = [];

  constructor(private readonly src: string) {}

  parse(): ParseOutcome {
    if (this.src.charCodeAt(0) === 0xfeff) this.pos = 1; // tolerate one BOM
    if (!this.skipTopLevelMisc()) return this.outcome(null);
    if (this.pos >= this.src.length) {
      this.violate("malformed-xml", "/", `line ${this.line}: no root element`);
      return this.outcome(null);
    }
    const root = this.parseElement("", 0, 1);
    if (root === null) return this.outcome(null);
    if (!this.skipTopLevelMisc()) return this.outcome(root);
    if (this.pos < this.src.length) {
      this.violate(
        "malformed-xml",
        "/",
        `line ${this.line}: content after the root element`,
      );
    }
    return this.outcome(root);
  }

  private outcome(root: SvgElement | null): ParseOutcome {
    return { root, violations: this.violations };
  }

  private violate(code: string, path: string, detail: string): void {
    this.violations.push({ code, path, detail });
  }

  /** Advance `n` chars, keeping the line counter honest. */
  private advance(n: number): void {
    const end = this.pos + n;
    for (let i = this.pos; i < end; i++) {
      if (this.src.charCodeAt(i) === 10) this.line++;
    }
    this.pos = end;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && isWhitespace(this.src[this.pos]!)) {
      this.advance(1);
    }
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.src.length && !isNameEnd(this.src[this.pos]!)) {
      this.advance(1);
    }
    return this.src.slice(start, this.pos);
  }

  /** Record a violation for a bracketed construct (comment / CDATA / PI) and
   *  skip past its terminator so later violations can still be collected.
   *  Returns false (fatal) when the terminator never appears. */
  private violateAndSkip(
    code: string,
    path: string,
    what: string,
    opener: string,
    terminator: string,
  ): boolean {
    this.violate(code, path, `line ${this.line}: ${what}`);
    const end = this.src.indexOf(terminator, this.pos + opener.length);
    if (end === -1) {
      this.violate(
        "malformed-xml",
        path,
        `line ${this.line}: unterminated ${what}`,
      );
      this.pos = this.src.length;
      return false;
    }
    this.advance(end + terminator.length - this.pos);
    return true;
  }

  /** Handles `<!--`, `<![CDATA[`, `<?`, `<!` at the current position.
   *  Returns "handled" | "fatal" | "none". */
  private handleForbiddenConstruct(path: string): "handled" | "fatal" | "none" {
    if (this.src.startsWith("<!--", this.pos)) {
      return this.violateAndSkip("comment-not-allowed", path, "XML comment", "<!--", "-->")
        ? "handled"
        : "fatal";
    }
    if (this.src.startsWith("<![CDATA[", this.pos)) {
      return this.violateAndSkip("cdata-not-allowed", path, "CDATA section", "<![CDATA[", "]]>")
        ? "handled"
        : "fatal";
    }
    if (this.src.startsWith("<?", this.pos)) {
      return this.violateAndSkip(
        "processing-instruction-not-allowed",
        path,
        "processing instruction (including the <?xml…?> declaration)",
        "<?",
        "?>",
      )
        ? "handled"
        : "fatal";
    }
    if (this.src.startsWith("<!", this.pos)) {
      // DOCTYPE (or any other <!…> declaration). Fatal: a DOCTYPE can define
      // entities, so nothing after it can be interpreted safely.
      this.violate(
        "doctype-not-allowed",
        path,
        `line ${this.line}: DOCTYPE/markup declarations are forbidden ` +
          "(this also closes the door on entity-expansion attacks)",
      );
      return "fatal";
    }
    return "none";
  }

  /** Whitespace / forbidden constructs before and after the root element.
   *  Returns false on fatal. */
  private skipTopLevelMisc(): boolean {
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) return true;
      if (this.src[this.pos] === "<") {
        const handled = this.handleForbiddenConstruct("/");
        if (handled === "fatal") return false;
        if (handled === "handled") continue;
        return true; // a real tag — caller takes over
      }
      this.violate(
        "malformed-xml",
        "/",
        `line ${this.line}: text content outside the root element`,
      );
      const next = this.src.indexOf("<", this.pos);
      this.advance((next === -1 ? this.src.length : next) - this.pos);
    }
    return true;
  }

  /** Parse one element; `this.pos` sits on its "<". Returns null on fatal
   *  (a violation has always been recorded first). */
  private parseElement(
    parentPath: string,
    index: number,
    depth: number,
  ): SvgElement | null {
    const line = this.line;
    this.advance(1); // consume "<"
    const name = this.readName();
    const herePath = parentPath === "" ? "/" : parentPath;
    if (name === "") {
      this.violate(
        "malformed-xml",
        herePath,
        `line ${line}: "<" is not followed by a tag name`,
      );
      return null;
    }
    const path =
      parentPath === "" ? `/${name}` : `${parentPath}/${name}[${index}]`;

    this.elementCount++;
    if (this.elementCount > SVG_ELEMENT_MAX) {
      this.violate(
        "too-many-elements",
        path,
        `line ${line}: more than ${SVG_ELEMENT_MAX} elements`,
      );
      return null;
    }
    if (depth > SVG_DEPTH_MAX) {
      this.violate(
        "depth-exceeded",
        path,
        `line ${line}: elements nested deeper than ${SVG_DEPTH_MAX}`,
      );
      return null;
    }

    const attributes = this.readAttributes(path);
    if (attributes === null) return null;

    const element: SvgElement = {
      kind: "element",
      name,
      attributes,
      children: [],
      path,
      line,
    };

    if (this.src.startsWith("/>", this.pos)) {
      this.advance(2);
      return element;
    }
    if (this.src[this.pos] === ">") {
      this.advance(1);
      if (!this.parseChildren(element, depth)) return null;
      return element;
    }
    this.violate(
      "malformed-xml",
      path,
      `line ${this.line}: unterminated start tag <${clip(name)}>`,
    );
    return null;
  }

  /** Read the attribute list of a start tag. On success `this.pos` sits on
   *  ">" or "/>". Returns null on fatal. */
  private readAttributes(path: string): SvgAttribute[] | null {
    const attributes: SvgAttribute[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) {
        this.violate(
          "malformed-xml",
          path,
          `line ${this.line}: unterminated start tag`,
        );
        return null;
      }
      const ch = this.src[this.pos]!;
      if (ch === ">" || this.src.startsWith("/>", this.pos)) return attributes;
      if (ch === "/") {
        this.violate(
          "malformed-xml",
          path,
          `line ${this.line}: stray "/" inside a start tag`,
        );
        return null;
      }

      const attrLine = this.line;
      const name = this.readName();
      if (name === "") {
        this.violate(
          "malformed-xml",
          path,
          `line ${attrLine}: expected an attribute name, ` +
            `found ${clip(JSON.stringify(this.src[this.pos]))}`,
        );
        return null;
      }
      const attrPath = `${path}/@${name}`;
      this.skipWhitespace();
      if (this.src[this.pos] !== "=") {
        this.violate(
          "malformed-xml",
          attrPath,
          `line ${attrLine}: attribute "${clip(name)}" has no value ` +
            "(bare attributes are not XML)",
        );
        return null;
      }
      this.advance(1);
      this.skipWhitespace();
      const quote = this.src[this.pos];
      if (quote !== '"' && quote !== "'") {
        this.violate(
          "malformed-xml",
          attrPath,
          `line ${this.line}: attribute value must be quoted with " or ' ` +
            "(unquoted values are a parsing-differential attack surface)",
        );
        return null;
      }
      this.advance(1);
      const valueEnd = this.src.indexOf(quote, this.pos);
      if (valueEnd === -1) {
        this.violate(
          "malformed-xml",
          attrPath,
          `line ${this.line}: unterminated attribute value`,
        );
        return null;
      }
      const raw = this.src.slice(this.pos, valueEnd);
      if (raw.length > SVG_ATTR_VALUE_MAX) {
        this.violate(
          "attr-value-too-long",
          attrPath,
          `line ${attrLine}: attribute value is ${raw.length} chars; ` +
            `the cap is ${SVG_ATTR_VALUE_MAX}`,
        );
        return null;
      }
      if (raw.includes("<")) {
        this.violate(
          "malformed-xml",
          attrPath,
          `line ${attrLine}: "<" inside an attribute value`,
        );
        return null;
      }
      this.advance(valueEnd + 1 - this.pos);

      const value = this.decodeEntities(raw, attrPath, attrLine);
      this.checkControlChars(value, attrPath, attrLine);
      if (seen.has(name)) {
        this.violate(
          "duplicate-attribute",
          attrPath,
          `line ${attrLine}: attribute "${clip(name)}" appears more than once`,
        );
        continue; // first occurrence wins in the AST; the doc fails anyway
      }
      seen.add(name);
      attributes.push({ name, value, line: attrLine });
    }
  }

  /** Parse content until the matching close tag. Returns false on fatal. */
  private parseChildren(parent: SvgElement, depth: number): boolean {
    let elementIndex = 0;
    let rawText = "";
    let textLine = this.line;

    const flushText = (): void => {
      if (rawText === "") return;
      const value = this.decodeEntities(rawText, parent.path, textLine);
      this.checkControlChars(value, parent.path, textLine);
      parent.children.push({ kind: "text", value, line: textLine });
      rawText = "";
    };

    for (;;) {
      if (this.pos >= this.src.length) {
        this.violate(
          "malformed-xml",
          parent.path,
          `line ${this.line}: missing </${parent.name}>`,
        );
        return false;
      }
      if (this.src[this.pos] !== "<") {
        if (rawText === "") textLine = this.line;
        const next = this.src.indexOf("<", this.pos);
        const end = next === -1 ? this.src.length : next;
        rawText += this.src.slice(this.pos, end);
        this.advance(end - this.pos);
        continue;
      }

      const handled = this.handleForbiddenConstruct(parent.path);
      if (handled === "fatal") return false;
      if (handled === "handled") {
        flushText();
        continue;
      }

      if (this.src.startsWith("</", this.pos)) {
        flushText();
        const closeLine = this.line;
        this.advance(2);
        const name = this.readName();
        this.skipWhitespace();
        if (this.src[this.pos] !== ">") {
          this.violate(
            "malformed-xml",
            parent.path,
            `line ${this.line}: malformed close tag </${clip(name)}`,
          );
          return false;
        }
        this.advance(1);
        if (name !== parent.name) {
          this.violate(
            "malformed-xml",
            parent.path,
            `line ${closeLine}: </${clip(name)}> does not match <${parent.name}>`,
          );
          return false;
        }
        return true;
      }

      flushText();
      const child = this.parseElement(parent.path, elementIndex, depth + 1);
      if (child === null) return false;
      elementIndex++;
      parent.children.push(child);
    }
  }

  /** Decode the five allowed entities (named or numeric). Anything else —
   *  unknown names, other codepoints, a bare "&" — is a violation; decoding
   *  continues so further violations can still be collected. */
  private decodeEntities(raw: string, path: string, line: number): string {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch !== "&") {
        out += ch;
        i++;
        continue;
      }
      const semi = raw.indexOf(";", i + 1);
      const body =
        semi !== -1 && semi - i <= 12 ? raw.slice(i + 1, semi) : null;
      const decoded = body === null ? null : decodeEntityBody(body);
      if (decoded === null) {
        this.violate(
          "entity-not-allowed",
          path,
          `line ${line}: ${clip(raw.slice(i, i + 12))} — only ` +
            "&amp; &lt; &gt; &quot; &apos; (and their numeric forms) are allowed",
        );
        i++;
        continue;
      }
      out += decoded;
      i = semi + 1;
    }
    return out;
  }

  private checkControlChars(value: string, path: string, line: number): void {
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp === 0x7f) {
        this.violate(
          "control-character",
          path,
          `line ${line}: control character U+${cp
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")} is not allowed`,
        );
        return;
      }
    }
  }
}

/** null unless `body` names one of the five allowed characters. */
function decodeEntityBody(body: string): string | null {
  const named = ENTITY_NAMES[body];
  if (named !== undefined) return named;
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = body.slice(hex ? 2 : 1);
    if (digits.length === 0 || digits.length > 7) return null;
    if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
    const cp = parseInt(digits, hex ? 16 : 10);
    if (!ENTITY_CODEPOINTS.has(cp)) return null;
    return String.fromCodePoint(cp);
  }
  return null;
}
