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

  test("a `>` and a meta-looking string inside another tag's quoted value", () => {
    allows('<div data-note="<meta http-equiv=refresh>">safe</div>');
  });

  test("a commented-out meta refresh is not a live tag", () => {
    allows('<!-- <meta http-equiv="refresh" content="0"> --><p>hi</p>');
  });
});
