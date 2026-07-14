// Issue 02 acceptance criteria 1-3 and 5-7 over real HTTP + real stdio MCP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

let server: SpawnedServer;

beforeAll(async () => {
  ensureCanvasBuilt();
  server = await spawnServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

describe("canvas server core", () => {
  test("health requires the capability token: 401 / 401 / 200", async () => {
    const noAuth = await httpRequest({ port: server.port, path: "/api/health" });
    expect(noAuth.status).toBe(401);

    const wrong = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: bearer("wrong-token-entirely"),
    });
    expect(wrong.status).toBe(401);

    const ok = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: bearer(server.token()),
    });
    expect(ok.status).toBe(200);
    const payload = JSON.parse(ok.body) as {
      workspaceId: string;
      version: string;
    };
    expect(payload.workspaceId).toBe(server.workspaceId);
    expect(payload.version.length).toBeGreaterThan(0);
    expect(ok.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
  });

  test("non-allowlisted Host header is 403 even with a valid token", async () => {
    const res = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: { ...bearer(server.token()), Host: "evil.test" },
    });
    expect(res.status).toBe(403);
  });

  test("binding is 127.0.0.1 only: LAN IP connection fails", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no LAN interface on this machine — nothing to probe
    await expect(
      httpRequest({
        port: server.port,
        path: "/api/health",
        host: lan.address,
        headers: { ...bearer(server.token()), Host: `127.0.0.1:${server.port}` },
        timeoutMs: 1500,
      }),
    ).rejects.toThrow();
  });

  test("GET /?token serves the canvas HTML; GET / without token is 401", async () => {
    const withToken = await httpRequest({
      port: server.port,
      path: `/?token=${server.token()}`,
    });
    expect(withToken.status).toBe(200);
    expect(withToken.headers["content-type"]).toContain("text/html");
    expect(withToken.body).toContain("<!doctype html>");

    const without = await httpRequest({ port: server.port, path: "/" });
    expect(without.status).toBe(401);
  });

  test("open_canvas URL loads; rotate_token kills the old bearer immediately", async () => {
    const opened = toolJson(
      await server.client.callTool({ name: "open_canvas", arguments: {} }),
    );
    const url = new URL(opened.url as string);
    expect(url.hostname).toBe("127.0.0.1");
    const page = await httpRequest({
      port: Number(url.port),
      path: url.pathname + url.search,
    });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");

    const oldToken = server.token();
    toolJson(
      await server.client.callTool({ name: "rotate_token", arguments: {} }),
    );
    const stale = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: bearer(oldToken),
    });
    expect(stale.status).toBe(401);
    const fresh = await httpRequest({
      port: server.port,
      path: "/api/health",
      headers: bearer(server.token()),
    });
    expect(fresh.status).toBe(200);
    expect(server.token()).not.toBe(oldToken);
  });

  test("port collision: second server scans to the next port and is healthy", async () => {
    const second = await spawnServer();
    try {
      expect(second.port).not.toBe(server.port);
      expect(second.port).toBeGreaterThan(server.port);
      const health = await httpRequest({
        port: second.port,
        path: "/api/health",
        headers: bearer(second.token()),
      });
      expect(health.status).toBe(200);
    } finally {
      await second.close();
    }
  }, 20_000);
});
