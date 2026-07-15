// Legibility Gate wiring + calibration ledger over real MCP + HTTP (issue 11).
// Proves the gate is REPORT-ONLY: a finding-laden SVG still publishes and
// still renders; findings are stored per version; updating re-runs the gate;
// and calibration rulings persist with a precision summary that reflects them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { CalibrationLedger } from "../src/server/calibration.js";
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

// A deliberately illegible SVG: an 8px label in a 1600-wide viewBox, which the
// canvas shrinks to 836px (~0.52× display scale) → ~4px rendered (sub-legible,
// issue 16), and it also runs off the right edge of the viewBox (clipped).
// Sanitizes fine — the gate's job is readability, not safety.
const ILLEGIBLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 200">' +
  '<text x="1450" y="100" font-size="8">this caption is far too small and also overruns</text>' +
  "</svg>";

const CLEAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
  '<rect x="20" y="20" width="160" height="60" fill="none" stroke="black"/>' +
  '<text x="100" y="56" font-size="14" text-anchor="middle">Legible</text></svg>';

function findingsPath(id: string, v: number): string {
  return join(server.stateDir, "artifacts", id, `v${v}.findings.json`);
}

describe("gate is report-only on the publish path (AC2, AC3)", () => {
  test("a finding-laden SVG still publishes; findings stored in v1.findings.json", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Illegible", svg: ILLEGIBLE },
      }),
    );
    const id = published.artifact_id as string;
    // Publish succeeded despite findings — report-only proven.
    expect(published.version).toBe(1);

    // The artifact renders like any other (GET returns the sanitized svg).
    const got = await httpRequest({
      port: server.port,
      path: `/api/artifacts/${id}`,
      headers: bearer(server.token()),
    });
    expect(got.status).toBe(200);

    // Findings are stored alongside the version, coordinate-bearing.
    expect(existsSync(findingsPath(id, 1))).toBe(true);
    const findings = JSON.parse(readFileSync(findingsPath(id, 1), "utf8")) as Array<{
      check: string;
      bbox: { x: number; y: number; w: number; h: number };
      elements: string[];
      message: string;
    }>;
    const checks = findings.map((f) => f.check);
    expect(checks).toContain("sub-legible");
    expect(checks).toContain("clipped");
    for (const f of findings) {
      expect(typeof f.bbox.x).toBe("number");
      expect(f.elements.length).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  test("a clean SVG stores an empty findings array", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Clean", svg: CLEAN },
      }),
    );
    const id = published.artifact_id as string;
    expect(JSON.parse(readFileSync(findingsPath(id, 1), "utf8"))).toEqual([]);
  });

  test("updating an artifact re-runs the gate for the new version (AC2)", async () => {
    const published = toolJson(
      await server.client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: "Editable", svg: CLEAN },
      }),
    );
    const id = published.artifact_id as string;
    expect(JSON.parse(readFileSync(findingsPath(id, 1), "utf8"))).toEqual([]);

    await server.client.callTool({
      name: "update_artifact",
      arguments: { artifact_id: id, type: "svg", title: "Editable", svg: ILLEGIBLE },
    });
    // v2 got its own fresh findings; v1 is untouched.
    expect(existsSync(findingsPath(id, 2))).toBe(true);
    const v2 = JSON.parse(readFileSync(findingsPath(id, 2), "utf8")) as unknown[];
    expect(v2.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(findingsPath(id, 1), "utf8"))).toEqual([]);
  });
});

describe("calibration gallery + rulings (AC4)", () => {
  test("the gallery endpoint returns svg versions with their findings", async () => {
    const res = await httpRequest({
      port: server.port,
      path: "/api/calibration/gallery",
      headers: bearer(server.token()),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      items: Array<{ artifact_id: string; version: number; findings: unknown[] }>;
      summary: { perCheck: unknown[] };
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.summary.perCheck.length).toBe(4);
  });

  test("posting a ruling persists it and the precision summary reflects it", async () => {
    // Find an item with a finding to rule on.
    const gallery = JSON.parse(
      (
        await httpRequest({
          port: server.port,
          path: "/api/calibration/gallery",
          headers: bearer(server.token()),
        })
      ).body,
    ) as {
      items: Array<{
        artifact_id: string;
        version: number;
        findings: Array<{ check: string }>;
      }>;
    };
    const item = gallery.items.find((i) => i.findings.length > 0)!;
    const finding = item.findings[0]!;

    const post = await httpRequest({
      port: server.port,
      path: "/api/calibration",
      method: "POST",
      headers: { ...bearer(server.token()), "Content-Type": "application/json" },
      body: JSON.stringify({
        artifact_id: item.artifact_id,
        version: item.version,
        finding_index: 0,
        check: finding.check,
        verdict: "correct",
      }),
    });
    expect(post.status).toBe(201);

    // The ledger file exists and the summary reflects the ruling.
    expect(existsSync(join(server.stateDir, "calibration.jsonl"))).toBe(true);
    const cal = JSON.parse(
      (
        await httpRequest({
          port: server.port,
          path: "/api/calibration",
          headers: bearer(server.token()),
        })
      ).body,
    ) as {
      summary: { perCheck: Array<{ check: string; correct: number; precision: number | null }> };
      rulings: unknown[];
    };
    expect(cal.rulings.length).toBeGreaterThan(0);
    const ruled = cal.summary.perCheck.find((c) => c.check === finding.check)!;
    expect(ruled.correct).toBeGreaterThanOrEqual(1);
    expect(ruled.precision).toBe(1);
  });

  test("built canvas entries are self-contained (no token-less cross-chunk imports)", () => {
    // The capability model injects the token into HTML-referenced asset URLs,
    // but a cross-chunk ESM `import "./shared.js"` carries no token and 401s —
    // silently breaking the whole app. Each entry must be one standalone file.
    const assetsDir = join(
      fileURLToPath(new URL("..", import.meta.url)),
      "dist",
      "canvas",
      "assets",
    );
    for (const file of readdirSync(assetsDir).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(join(assetsDir, file), "utf8");
      const crossChunk = [...src.matchAll(/\bimport\s*\(?["'](\.\/[^"']+\.js)["']/g)];
      expect(crossChunk.map((m) => m[1]), `${file} imports a sibling chunk`).toEqual([]);
    }
  });

  test("the /calibration page is an authed canvas route (cross-cutting AC2)", async () => {
    const ok = await httpRequest({
      port: server.port,
      path: `/calibration?token=${server.token()}`,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/html");
    expect(ok.body).toContain("Legibility Calibration");
    // The page's asset URLs carry the token (subresources cannot send a bearer).
    expect(ok.body).toMatch(/\/assets\/[^"]*\?token=/);

    const noToken = await httpRequest({ port: server.port, path: "/calibration" });
    expect(noToken.status).toBe(401);

    const noBearer = await httpRequest({
      port: server.port,
      path: "/api/calibration/gallery",
    });
    expect(noBearer.status).toBe(401);
  });

  test("an invalid ruling is rejected with 400 and nothing is appended", async () => {
    const before = existsSync(join(server.stateDir, "calibration.jsonl"))
      ? readFileSync(join(server.stateDir, "calibration.jsonl"), "utf8")
      : "";
    const res = await httpRequest({
      port: server.port,
      path: "/api/calibration",
      method: "POST",
      headers: { ...bearer(server.token()), "Content-Type": "application/json" },
      body: JSON.stringify({ artifact_id: "x", version: 1, finding_index: 0, check: "bogus", verdict: "correct" }),
    });
    expect(res.status).toBe(400);
    const after = existsSync(join(server.stateDir, "calibration.jsonl"))
      ? readFileSync(join(server.stateDir, "calibration.jsonl"), "utf8")
      : "";
    expect(after).toBe(before);
  });
});

// Ledger unit: precision keeps the LATEST ruling per finding (a re-vote fixes
// a misclick), and counts precision as correct ÷ ruled per check.
describe("CalibrationLedger precision math", () => {
  test("latest ruling per finding wins; precision is per check", () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-unit-"));
    const ledger = new CalibrationLedger(dir);
    ledger.append({ artifact_id: "a_1", version: 1, finding_index: 0, check: "clipped", verdict: "false-positive" });
    // Re-vote the SAME finding — the correction must override.
    ledger.append({ artifact_id: "a_1", version: 1, finding_index: 0, check: "clipped", verdict: "correct" });
    ledger.append({ artifact_id: "a_1", version: 1, finding_index: 1, check: "clipped", verdict: "false-positive" });
    ledger.append({ artifact_id: "a_2", version: 1, finding_index: 0, check: "text-overlap", verdict: "correct" });

    const s = ledger.summary();
    expect(s.totalRulings).toBe(3); // three distinct findings
    const clipped = s.perCheck.find((c) => c.check === "clipped")!;
    expect(clipped.correct).toBe(1);
    expect(clipped.falsePositive).toBe(1);
    expect(clipped.precision).toBe(0.5);
    const overlap = s.perCheck.find((c) => c.check === "text-overlap")!;
    expect(overlap.precision).toBe(1);
    const straddle = s.perCheck.find((c) => c.check === "edge-straddle")!;
    expect(straddle.precision).toBeNull();
  });
});
