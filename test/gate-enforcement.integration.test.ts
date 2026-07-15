// Gate enforcement + bounded repair round (issue 12, ADR-0007). Proves that in
// "enforce" mode a finding-laden SVG is NOT stored but returns its verbatim
// coordinate findings; a fix publishes normally and clears the context; a
// second failure becomes an Honest Absence; the context survives a restart and
// expires; report mode is unchanged; and NO MCP tool can arm the gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepairRegistry } from "../src/server/repair.js";
import { shouldEnforce } from "../src/server/config.js";
import {
  bearer,
  ensureCanvasBuilt,
  httpRequest,
  spawnServer,
  toolJson,
  type SpawnedServer,
} from "./helpers.js";

// Illegible AND clipped: an 8px caption in a 1600-wide viewBox (rendered ~4px)
// that also overruns the right edge — the gate flags it deterministically.
const ILLEGIBLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 200">' +
  '<text x="1450" y="100" font-size="8">this caption is far too small and also overruns</text>' +
  "</svg>";

const CLEAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
  '<rect x="20" y="20" width="160" height="60" fill="none" stroke="black"/>' +
  '<text x="100" y="56" font-size="14" text-anchor="middle">Legible</text></svg>';

function artifactCount(server: SpawnedServer): number {
  const dir = join(server.stateDir, "artifacts");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

interface GateFailed {
  gate: "failed";
  findings: Array<{ check: string; elements: string[]; bbox: { x: number }; message: string }>;
  repair_hint: string;
  repair_token?: string;
}

describe("enforce mode — first failure returns findings, stores nothing (AC2)", () => {
  let server: SpawnedServer;
  beforeAll(async () => {
    ensureCanvasBuilt();
    server = await spawnServer({ gate: "enforce" });
  }, 30_000);
  afterAll(async () => await server?.close());

  test("failing svg → gate:failed with verbatim coordinate findings, nothing stored", async () => {
    const before = artifactCount(server);
    const res = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Too small", svg: ILLEGIBLE },
      }),
    ) as unknown as GateFailed;

    expect(res.gate).toBe("failed");
    expect(res.repair_token).toMatch(/^rt_/);
    expect(res.repair_hint).toContain("ONLY");
    // Findings are the gate's real coordinate-bearing output.
    const checks = res.findings.map((f) => f.check);
    expect(checks).toContain("sub-legible");
    expect(checks).toContain("clipped");
    for (const f of res.findings) {
      expect(typeof f.bbox.x).toBe("number");
      expect(f.elements.length).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(0);
    }
    // NOTHING stored: no new artifact directory.
    expect(artifactCount(server)).toBe(before);
  });
});

describe("enforce mode — a fix publishes normally and clears the context (AC3)", () => {
  let server: SpawnedServer;
  beforeAll(async () => {
    ensureCanvasBuilt();
    server = await spawnServer({ gate: "enforce" });
  }, 30_000);
  afterAll(async () => await server?.close());

  test("resubmission fixing the findings publishes; the context is cleared", async () => {
    const fail = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Fixable", svg: ILLEGIBLE },
      }),
    ) as unknown as GateFailed;
    const token = fail.repair_token!;

    // Fix ONLY the geometry (submit a legible version) with the token.
    const ok = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Fixable",
          svg: CLEAN,
          repair_token: token,
        },
      }),
    );
    expect(ok.version).toBe(1);
    expect(typeof ok.artifact_id).toBe("string");

    // The context is cleared: re-failing under the now-dead token starts a
    // FRESH round (gate:failed), not an immediate absence.
    const again = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Fixable",
          svg: ILLEGIBLE,
          repair_token: token,
        },
      }),
    ) as unknown as GateFailed;
    expect(again.gate).toBe("failed");
    expect(again.repair_token).not.toBe(token);
  });
});

describe("enforce mode — second failure becomes an Honest Absence (AC4)", () => {
  let server: SpawnedServer;
  beforeAll(async () => {
    ensureCanvasBuilt();
    server = await spawnServer({ gate: "enforce" });
  }, 30_000);
  afterAll(async () => await server?.close());

  test("a second failing submission publishes an absence, labelled honest, not an error", async () => {
    const fail = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Doomed diagram", svg: ILLEGIBLE },
      }),
    ) as unknown as GateFailed;
    const token = fail.repair_token!;

    // Still failing on the second try → the server converts it to absence.
    const absence = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Doomed diagram",
          svg: ILLEGIBLE,
          repair_token: token,
        },
      }),
    );
    expect(absence.outcome).toBe("honest_absence");
    expect(String(absence.message).toLowerCase()).toContain("not an error");
    expect(String(absence.reason)).toContain("Failed the legibility gate twice");
    // The stored artifact really is an absence with the title preserved.
    const got = JSON.parse(
      (
        await httpRequest({
          port: server.port,
          path: `/api/artifacts/${absence.artifact_id}`,
          headers: bearer(server.token()),
        })
      ).body,
    ) as { type: string; title: string; content: { type: string; reason: string } };
    expect(got.type).toBe("absence");
    expect(got.title).toBe("Doomed diagram");
    expect(got.content.reason).toContain("Failed the legibility gate twice");
    expect(got.content.reason).toContain("sub-legible");
  });

  test("update enforce: second failing update becomes a NEW absence; the svg is untouched", async () => {
    // Seed a good svg artifact to update.
    const seed = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Editable", svg: CLEAN },
      }),
    );
    const id = seed.artifact_id as string;

    // First failing update → findings back, no new version.
    const f1 = toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: { artifact_id: id, type: "svg", title: "Editable", svg: ILLEGIBLE },
      }),
    ) as unknown as GateFailed;
    expect(f1.gate).toBe("failed");
    // Still only v1 on disk (findings + version), no v2.
    expect(readdirSync(join(server.stateDir, "artifacts", id)).sort()).toEqual([
      "meta.json",
      "v1.findings.json",
      "v1.json",
    ]);

    // Second failing update → a NEW absence artifact; the svg keeps v1.
    const f2 = toolJson(
      await server.client.callTool({
        name: "update_artifact",
        arguments: { artifact_id: id, type: "svg", title: "Editable", svg: ILLEGIBLE },
      }),
    );
    expect(f2.outcome).toBe("honest_absence");
    expect(f2.artifact_id).not.toBe(id); // a distinct absence artifact
    // The original svg artifact was NOT mutated to absence (type stability).
    const meta = JSON.parse(
      readFileSync(join(server.stateDir, "artifacts", id, "meta.json"), "utf8"),
    ) as { type: string; latest: number };
    expect(meta.type).toBe("svg");
    expect(meta.latest).toBe(1);
  });
});

describe("enforce mode — a repair context survives restart and expires (AC5)", () => {
  test("restart: the second failure across a restart still becomes an absence", async () => {
    ensureCanvasBuilt();
    const home = mkdtempSync(join(tmpdir(), "visual-chat-restart-"));
    let server = await spawnServer({ home, gate: "enforce" });

    const fail = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Persist", svg: ILLEGIBLE },
      }),
    ) as unknown as GateFailed;
    const token = fail.repair_token!;
    // The context was persisted to disk.
    expect(existsSync(join(server.stateDir, "repair-contexts.json"))).toBe(true);
    await server.close();

    // Restart against the SAME home — config.json (enforce) and the repair
    // context both persist.
    server = await spawnServer({ home });
    const absence = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: {
          type: "svg",
          title: "Persist",
          svg: ILLEGIBLE,
          repair_token: token,
        },
      }),
    );
    expect(absence.outcome).toBe("honest_absence");
    await server.close();
  }, 30_000);

  test("RepairRegistry: a context expires after one hour", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-unit-"));
    let now = 1_000_000;
    const reg = new RepairRegistry(dir, () => now);

    expect(reg.recordFailure("pub:x").secondFailure).toBe(false); // opens context
    now += 61 * 60 * 1000; // advance past the 1h TTL
    // The stale context is purged: this reads as a FRESH first failure, never a
    // second one — a stale context must not turn an unrelated retry into absence.
    expect(reg.has("pub:x")).toBe(false);
    expect(reg.recordFailure("pub:x").secondFailure).toBe(false);
  });

  test("RepairRegistry: a second failure within the hour is spent; a pass clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-unit2-"));
    let now = 5_000_000;
    const reg = new RepairRegistry(dir, () => now);
    expect(reg.recordFailure("k").secondFailure).toBe(false);
    now += 10 * 60 * 1000;
    expect(reg.recordFailure("k").secondFailure).toBe(true); // spent
    reg.clear("k");
    expect(reg.has("k")).toBe(false);
    expect(reg.recordFailure("k").secondFailure).toBe(false); // fresh again
  });
});

describe("report mode is unchanged (AC1)", () => {
  let server: SpawnedServer;
  beforeAll(async () => {
    ensureCanvasBuilt();
    server = await spawnServer(); // default: report
  }, 30_000);
  afterAll(async () => await server?.close());

  test("a finding-laden svg still publishes and stores its findings (no enforcement)", async () => {
    const res = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Report only", svg: ILLEGIBLE },
      }),
    );
    // Published normally — no gate:"failed", no absence.
    expect(res.version).toBe(1);
    expect(res.gate).toBeUndefined();
    const id = res.artifact_id as string;
    const findings = JSON.parse(
      readFileSync(join(server.stateDir, "artifacts", id, "v1.findings.json"), "utf8"),
    ) as unknown[];
    expect(findings.length).toBeGreaterThan(0);
    // Report mode never writes a repair context.
    expect(existsSync(join(server.stateDir, "repair-contexts.json"))).toBe(false);
  });
});

describe("no MCP tool can change the gate mode (AC6, security invariant)", () => {
  let server: SpawnedServer;
  beforeAll(async () => {
    ensureCanvasBuilt();
    server = await spawnServer(); // report mode, no config.json
  }, 30_000);
  afterAll(async () => await server?.close());

  test("listTools() SUCCEEDS and returns exactly the closed tool set (regression)", async () => {
    // A spec-compliant host must be able to enumerate our tools: the SDK's
    // ListTools result parser rejects an inputSchema without a top-level
    // type:"object" (was latent since M1 — publish/update used a bare oneOf).
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_askbacks", "open_canvas", "publish_artifact", "rotate_token", "update_artifact"].sort(),
    );
  });

  test("no REAL tool can mutate gate/config/mode, and none changes it on disk", async () => {
    // Enumerate the ACTUAL advertised tools so a future gate-mutator addition is
    // caught here, not by a stale hardcoded list.
    const { tools } = await server.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.name).not.toMatch(/gate|config|mode|enforce/i);
    }

    // Report mode ⇒ no config.json. The agent must not be able to create it.
    const configPath = join(server.stateDir, "config.json");
    expect(existsSync(configPath)).toBe(false);

    for (const t of tools) {
      await server.client
        .callTool({
          name: t.name,
          // Smuggle gate-mutation-shaped args into each tool.
          arguments: { gate: "enforce", mode: "enforce", config: { gate: "enforce" } },
        })
        .catch(() => {});
    }
    // An unknown tool name cannot arm it either.
    await server.client
      .callTool({ name: "set_gate_mode", arguments: { gate: "enforce" } })
      .catch(() => {});

    expect(existsSync(configPath)).toBe(false);
  });
});

describe("shouldEnforce — enforcement acts on findings only, never a gate crash", () => {
  const F = [{ check: "clipped" }];
  test("enforce + svg + real findings → engages", () => {
    expect(shouldEnforce({ mode: "enforce", type: "svg", findings: F })).toBe(true);
  });
  test("a gate crash degrades to [] findings → never engages (fail-open)", () => {
    // runGateSafe returns [] on a throw, so this is exactly the crash case.
    expect(shouldEnforce({ mode: "enforce", type: "svg", findings: [] })).toBe(false);
  });
  test("report mode never engages, even with findings", () => {
    expect(shouldEnforce({ mode: "report", type: "svg", findings: F })).toBe(false);
  });
  test("non-svg never engages", () => {
    expect(shouldEnforce({ mode: "enforce", type: "document", findings: F })).toBe(false);
  });
});
