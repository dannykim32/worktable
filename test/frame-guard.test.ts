// Issue 25 security review — Finding 1: the HTML hatch must REJECT no-click
// network-egress constructs at INGEST (reject-not-drop), because the regex strip
// was bypassable. These fixtures include the two verified bypass payloads plus
// the quoting/entity/case tricks that defeat a naive matcher; each must be
// REJECTED, both by the scanner and through validateArtifactContent (the
// publish AND update path both flow through it).
import { describe, expect, test } from "bun:test";
import { scanHtmlForEgress } from "../src/server/frameGuard.js";
import {
  validateArtifactContent,
  ValidationError,
} from "../src/server/validate.js";

function rejects(html: string): void {
  expect(scanHtmlForEgress(html).length).toBeGreaterThan(0);
  expect(() =>
    validateArtifactContent({ type: "html", title: "t", html }),
  ).toThrow(ValidationError);
}

function allows(html: string): void {
  expect(scanHtmlForEgress(html)).toEqual([]);
  expect(
    validateArtifactContent({ type: "html", title: "t", html }),
  ).toBeTruthy();
}

describe("frameGuard — REJECTS no-click egress", () => {
  test("bypass #1: `>` inside a quoted value before http-equiv", () => {
    rejects(
      '<meta name="x>" http-equiv="refresh" content="0;url=https://evil.example/">',
    );
  });

  test("bypass #2: entity-encoded refresh keyword", () => {
    rejects(
      '<meta http-equiv="&#82;efresh" content="0;url=https://evil.example/">',
    );
  });

  test("content attribute before http-equiv", () => {
    rejects('<meta content="0;url=https://evil.example/" http-equiv="refresh">');
  });

  test("single-quoted `>` inside a value", () => {
    rejects("<meta name='a>b' http-equiv='refresh' content='0'>");
  });

  test("mixed-case attribute name and value", () => {
    rejects('<meta HTTP-EQUIV="ReFrEsh" content="0">');
  });

  test("whitespace around the equals sign", () => {
    rejects('<meta http-equiv = "refresh" content = "0">');
  });

  test("any http-equiv (not only refresh) is rejected", () => {
    rejects('<meta http-equiv="x-ua-compatible" content="IE=edge">');
  });

  test("<link rel=dns-prefetch>", () => {
    rejects('<link rel="dns-prefetch" href="//evil.example">');
  });

  test("<link rel=preconnect> (no href)", () => {
    rejects('<link rel="preconnect">');
  });

  test("entity-encoded rel hint", () => {
    rejects('<link rel="dns-pref&#101;tch">');
  });

  test("<link> with an external stylesheet href", () => {
    rejects('<link rel="stylesheet" href="https://evil.example/x.css">');
  });

  test("<link> with a protocol-relative href", () => {
    rejects('<link rel="icon" href="//evil.example/f.ico">');
  });

  test("fail-closed: an unterminated <meta http-equiv is rejected", () => {
    rejects('<p>ok</p><meta http-equiv="refresh" content="0');
  });
});

// Second-round review: the comment skip must match the HTML tokenizer's EARLY
// closes, or a `<!-->`/`<!--->`/`--!>` re-opens the data state and the following
// <meta>/<link> is LIVE while the scanner (naive indexOf("-->")) skips to EOF.
// Each payload below was confirmed LIVE by parse5 and must be REJECTED.
describe("frameGuard — comment abrupt-close bypasses (parse5-confirmed live)", () => {
  test("abrupt empty comment <!--> exposes a live meta refresh", () => {
    rejects('<!--><meta http-equiv="refresh" content="0;url=https://evil/">');
  });

  test("<!--> exposes a live hint link", () => {
    rejects('<!--><link rel="preconnect" href="https://evil/">');
  });

  test("abrupt close after one dash <!---> exposes a live meta", () => {
    rejects('<!---><meta http-equiv="refresh" content="0;url=https://evil/">');
  });

  test("comment-end-bang --!> (hides inside a normal-looking comment)", () => {
    rejects('<!--nothing to see--!><meta http-equiv="refresh" content="0">');
  });

  test("--!> with empty comment body", () => {
    rejects('<!----!><link rel="dns-prefetch" href="//evil/">');
  });

  test("a properly closed comment before real content still scans it", () => {
    rejects('<!-- ok --><meta http-equiv="refresh" content="0">');
  });

  test("a normal empty comment <!----> does not disable later scanning", () => {
    rejects('<!----><p>x</p><meta http-equiv="refresh" content="0">');
  });
});

describe("frameGuard — ALLOWS benign static HTML", () => {
  test("plain rich content", () => {
    allows("<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>a</li></ul>");
  });

  test("charset / viewport meta (no http-equiv)", () => {
    allows('<meta charset="utf-8"><meta name="viewport" content="width=device-width">');
  });

  test("relative same-origin link (CSP-blocked anyway, but not egress)", () => {
    allows('<link rel="stylesheet" href="styles.css"><p>x</p>');
  });

  test("anchors with external href are fine (user-click nav is accepted)", () => {
    allows('<a href="https://ok.example/page">a link</a>');
  });

  // Clickable external references: an <a href> is CLICK-gated, not no-click
  // egress — the frame prelude intercepts the click and the parent bridge opens
  // it (openlink verb). These lock in that ingest keeps passing them.
  test("clickable reference: <a href=https://…> (with child span) passes ingest", () => {
    allows(
      '<p>Tracked in <a href="https://issues.example/browse/PROJ-123">' +
        "<span>PROJ-123</span></a></p>",
    );
  });

  test("clickable reference: in-page <a href=#local> passes ingest", () => {
    allows('<a href="#local">jump</a><h2 id="local">Local section</h2>');
  });

  test("a `>` and a meta-looking string inside another tag's quoted value", () => {
    allows('<div data-note="<meta http-equiv=refresh>">safe</div>');
  });

  test("a commented-out meta refresh is not a live tag", () => {
    allows('<!-- <meta http-equiv="refresh" content="0"> --><p>hi</p>');
  });
});
