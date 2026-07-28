// Gate-mode settings endpoints (issue 20, ADR-0011): the token-gated HUMAN
// surface for report/enforce, applied LIVE (the server resolves gate mode per
// publish, so a flip takes effect on the next artifact with NO restart). Proves
// the live flip, that each scope writes the right file (0600, keys preserved),
// the 401s, strict validation, and — the security invariant — that the write
// path is reachable ONLY via the capability token, never any MCP tool.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

// Illegible AND clipped: an 8px caption in a 1600-wide viewBox that overruns the
// right edge — the gate flags it deterministically (same fixture as issue 12).
const ILLEGIBLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 200">' +
  '<text x="1450" y="100" font-size="8">this caption is far too small and also overruns</text>' +
  "</svg>";

let server: SpawnedServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function postSettings(
  s: SpawnedServer,
  body: unknown,
  headers?: Record<string, string>,
) {
  return httpRequest({
    port: s.port,
    path: "/api/settings",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? bearer(s.token())),
    },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings reports the effective mode + source", () => {
  test("a fresh (unconfigured) workspace reports report / default", async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const res = await httpRequest({
      port: server.port,
      path: "/api/settings",
      headers: bearer(server.token()),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      gate: { effective: "report", source: "default" },
    });
  });
});

describe("LIVE flip: report → enforce takes effect with no restart (AC2)", () => {
  test("after POST enforce, the very next finding-laden publish is enforced", async () => {
    ensureCanvasBuilt();
    server = await spawnServer(); // report default

    // Report mode: the illegible svg publishes normally.
    const first = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Before", svg: ILLEGIBLE },
      }),
    );
    expect(first.version).toBe(1);
    expect(first.gate).toBeUndefined();

    // Flip to enforce via the human endpoint — no restart.
    const flip = await postSettings(server, {
      gate: "enforce",
      scope: "workspace",
    });
    expect(flip.status).toBe(200);
    expect(JSON.parse(flip.body)).toEqual({
      gate: { effective: "enforce", source: "workspace" },
    });

    // The next publish of the same illegible svg is now ENFORCED.
    const after = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "After", svg: ILLEGIBLE },
      }),
    );
    expect(after.gate).toBe("failed");
    expect(String(after.repair_token)).toMatch(/^rt_/);

    // And flipping back to report is equally live: it publishes again.
    await postSettings(server, { gate: "report", scope: "workspace" });
    const back = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Back", svg: ILLEGIBLE },
      }),
    );
    expect(back.version).toBe(1);
    expect(back.gate).toBeUndefined();
  }, 30_000);
});

describe("scope writes the right file, 0600, other keys preserved (AC3)", () => {
  test('scope:"workspace" writes <stateDir>/config.json', async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    await postSettings(server, { gate: "enforce", scope: "workspace" });
    const path = join(server.stateDir, "config.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).gate).toBe("enforce");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('scope:"user" writes ~/.visual-chat/config.json and preserves other keys', async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const userPath = join(server.home, ".visual-chat", "config.json");
    // Seed an unrelated key to prove it survives the write.
    writeFileSync(userPath, JSON.stringify({ theme: "vanilla" }), {
      mode: 0o600,
    });
    const res = await postSettings(server, { gate: "enforce", scope: "user" });
    expect(JSON.parse(res.body)).toEqual({
      gate: { effective: "enforce", source: "user" },
    });
    expect(JSON.parse(readFileSync(userPath, "utf8"))).toEqual({
      theme: "vanilla",
      gate: "enforce",
    });
    expect(statSync(userPath).mode & 0o777).toBe(0o600);
    // The workspace file was NOT written (user scope only).
    expect(existsSync(join(server.stateDir, "config.json"))).toBe(false);
  });
});

describe("auth: /api/settings is bearer-gated (AC4)", () => {
  test("GET without the token → 401", async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const res = await httpRequest({ port: server.port, path: "/api/settings" });
    expect(res.status).toBe(401);
  });

  test("POST without the token → 401 and nothing is written", async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const res = await postSettings(
      server,
      { gate: "enforce", scope: "workspace" },
      { "Content-Type": "application/json" }, // no Authorization
    );
    expect(res.status).toBe(401);
    expect(existsSync(join(server.stateDir, "config.json"))).toBe(false);
  });
});

describe("validation: unknown gate/scope → 400, nothing written (AC5)", () => {
  test("unknown gate → 400, no config file", async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const res = await postSettings(server, {
      gate: "loud",
      scope: "workspace",
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(server.stateDir, "config.json"))).toBe(false);
  });

  test("unknown scope → 400, no config file", async () => {
    ensureCanvasBuilt();
    server = await spawnServer();
    const res = await postSettings(server, {
      gate: "enforce",
      scope: "global",
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(server.stateDir, "config.json"))).toBe(false);
  });
});

describe("no-self-grant EXTENDED: the write path is token-only (AC6)", () => {
  test("no MCP tool writes config.json, but the tokened endpoint does", async () => {
    ensureCanvasBuilt();
    server = await spawnServer(); // report, no config.json
    const configPath = join(server.stateDir, "config.json");

    // The full advertised tool set stays closed at exactly seven — no
    // gate/config/mode mutator (answer_askback, issue 22, is agent→browser and
    // does not match the pattern below), and no drift to an 8th tool.
    const { tools } = await server.client.listTools();
    expect(tools).toHaveLength(7);
    for (const t of tools) {
      expect(t.name).not.toMatch(/gate|config|mode|enforce|setting/i);
      await server.client
        .callTool({
          name: t.name,
          arguments: {
            gate: "enforce",
            mode: "enforce",
            scope: "user",
            config: { gate: "enforce" },
          },
        })
        .catch(() => {});
    }
    // An invented settings tool cannot arm it either.
    await server.client
      .callTool({
        name: "set_gate_mode",
        arguments: { gate: "enforce", scope: "user" },
      })
      .catch(() => {});
    // Nor can an UNAUTHENTICATED POST to the endpoint.
    await postSettings(
      server,
      { gate: "enforce", scope: "workspace" },
      { "Content-Type": "application/json" },
    );
    expect(existsSync(configPath)).toBe(false);

    // Only the token-bearing human POST arms it.
    const ok = await postSettings(server, {
      gate: "enforce",
      scope: "workspace",
    });
    expect(ok.status).toBe(200);
    expect(existsSync(configPath)).toBe(true);
  }, 30_000);
});
