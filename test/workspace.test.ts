import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostAllowed,
  injectTokenIntoCanvasHtml,
  parseBearerToken,
  tokensEqual,
} from "../src/server/http.js";
import { deriveWorkspaceId, openWorkspace } from "../src/server/workspace.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "worktable-ws-"));
}

describe("workspace identity", () => {
  test("workspaceId is 12 hex chars, deterministic, and realpath-based", () => {
    const dir = tmp();
    const id = deriveWorkspaceId(dir);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(deriveWorkspaceId(dir)).toBe(id);
    expect(deriveWorkspaceId(tmp())).not.toBe(id);
    // A symlink to the same directory resolves to the same workspace.
    const link = join(tmp(), "link");
    symlinkSync(dir, link);
    expect(deriveWorkspaceId(link)).toBe(id);
  });
});

describe("capability token lifecycle", () => {
  test("token is minted once and loaded on reopen (per-workspace persistence)", () => {
    const home = tmp();
    const cwd = tmp();
    const ws1 = openWorkspace({ cwd, home });
    expect(ws1.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    const ws2 = openWorkspace({ cwd, home });
    expect(ws2.token).toBe(ws1.token);
  });

  test("rotate_token mints a new token and persists it", () => {
    const home = tmp();
    const cwd = tmp();
    const ws = openWorkspace({ cwd, home });
    const before = ws.token;
    const after = ws.rotateToken();
    expect(after).not.toBe(before);
    expect(ws.token).toBe(after);
    expect(openWorkspace({ cwd, home }).token).toBe(after);
  });

  test("state dir is 0700 and token file is 0600 (fs.stat asserted)", () => {
    const home = tmp();
    const ws = openWorkspace({ cwd: tmp(), home });
    expect(statSync(ws.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".worktable")).mode & 0o777).toBe(0o700);
    expect(statSync(join(ws.dir, "token")).mode & 0o777).toBe(0o600);
    ws.recordPort(8787);
    expect(statSync(join(ws.dir, "port")).mode & 0o777).toBe(0o600);
  });
});

describe("host allowlist", () => {
  test("allows loopback names, rejects everything else", () => {
    expect(hostAllowed("127.0.0.1", 8787)).toBe(true);
    expect(hostAllowed("127.0.0.1:8787", 8787)).toBe(true);
    expect(hostAllowed("localhost", 8787)).toBe(true);
    expect(hostAllowed("localhost:8787", 8787)).toBe(true);
    expect(hostAllowed("localhost:9999", 8787)).toBe(false); // wrong port
    expect(hostAllowed("evil.test", 8787)).toBe(false);
    expect(hostAllowed("evil.test:8787", 8787)).toBe(false);
    expect(hostAllowed("127.0.0.1.evil.test", 8787)).toBe(false);
    expect(hostAllowed("sub.localhost", 8787)).toBe(false);
    expect(hostAllowed(undefined, 8787)).toBe(false);
    expect(hostAllowed("", 8787)).toBe(false);
  });

  describe("parseBearerToken", () => {
    test("extracts the token, tolerating whitespace like the old regex", () => {
      expect(parseBearerToken("Bearer abc123")).toBe("abc123");
      expect(parseBearerToken("Bearer   abc123")).toBe("abc123"); // many spaces
      expect(parseBearerToken("Bearer\tabc123")).toBe("abc123"); // tab delimiter
      expect(parseBearerToken("Bearer abc 123")).toBe("abc 123"); // inner space kept
    });

    test("rejects malformed / missing headers", () => {
      expect(parseBearerToken(undefined)).toBeNull();
      expect(parseBearerToken("")).toBeNull();
      expect(parseBearerToken("Bearer")).toBeNull(); // no delimiter, no token
      expect(parseBearerToken("Bearer ")).toBeNull(); // delimiter, empty token
      expect(parseBearerToken("Bearerabc")).toBeNull(); // no whitespace delimiter
      expect(parseBearerToken("Basic abc123")).toBeNull(); // wrong scheme
    });

    test("no polynomial backtracking on a hostile all-whitespace header", () => {
      // The old /^Bearer\s+(.+)$/ backtracked quadratically here. This value has
      // no non-whitespace token, so the parser returns null in linear time.
      const hostile = "Bearer" + " ".repeat(200_000);
      const start = performance.now();
      expect(parseBearerToken(hostile)).toBeNull();
      expect(performance.now() - start).toBeLessThan(50); // milliseconds, not seconds
    });
  });

  test("token injection touches only /assets/ URLs and keeps query strings", () => {
    const html =
      '<script src="/assets/index-abc.js"></script>' +
      '<link href="/assets/index-def.css?v=2">' +
      '<a href="/api/health">health</a>' +
      '<img src="/logo.png">' +
      '<a href="https://example.test/assets/x.js">remote</a>';
    const out = injectTokenIntoCanvasHtml(html, "TOK");
    expect(out).toContain('src="/assets/index-abc.js?token=TOK"');
    expect(out).toContain('href="/assets/index-def.css?v=2&token=TOK"');
    expect(out).toContain('href="/api/health"'); // untouched
    expect(out).toContain('src="/logo.png"'); // untouched
    expect(out).toContain('href="https://example.test/assets/x.js"'); // untouched
  });

  test("tokensEqual compares without length leaks and matches exactly", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("short", "much-longer-token")).toBe(false);
    expect(tokensEqual("", "x")).toBe(false);
  });
});
