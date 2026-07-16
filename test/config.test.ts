// Unit coverage for the gate-mode resolver + settings-body validation
// (issue 20, ADR-0011). Precedence: workspace config.json > user
// ~/.visual-chat/config.json > "report"; malformed/missing degrades to the next
// level; the source is reported for the UI. Settings writes are validated
// strictly and preserve other keys.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGateMode,
  validateSettingsBody,
  writeGateSetting,
  SettingsValidationError,
} from "../src/server/config.js";

/** A ~/.visual-chat/<ws> layout: returns { root, workspaceDir }. */
function scaffold(): { root: string; workspaceDir: string } {
  const root = mkdtempSync(join(tmpdir(), "vc-config-"));
  const workspaceDir = join(root, "ws-abc123");
  mkdirSync(workspaceDir, { recursive: true });
  return { root, workspaceDir };
}

function writeConfig(dir: string, body: unknown): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(body), { mode: 0o600 });
}

describe("resolveGateMode precedence + degrade + source (AC1)", () => {
  test("workspace override wins over the user default", () => {
    const { root, workspaceDir } = scaffold();
    writeConfig(workspaceDir, { gate: "enforce" });
    writeConfig(root, { gate: "report" });
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "enforce",
      source: "workspace",
    });
  });

  test("an explicit workspace report overrides a user enforce (not treated as absent)", () => {
    const { root, workspaceDir } = scaffold();
    writeConfig(workspaceDir, { gate: "report" });
    writeConfig(root, { gate: "enforce" });
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "report",
      source: "workspace",
    });
  });

  test("user default applies when there is no workspace override", () => {
    const { root, workspaceDir } = scaffold();
    writeConfig(root, { gate: "enforce" });
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "enforce",
      source: "user",
    });
  });

  test("nothing set anywhere → report / default", () => {
    const { workspaceDir } = scaffold();
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "report",
      source: "default",
    });
  });

  test("malformed workspace config degrades to the user level", () => {
    const { root, workspaceDir } = scaffold();
    writeFileSync(join(workspaceDir, "config.json"), "{ not json ");
    writeConfig(root, { gate: "enforce" });
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "enforce",
      source: "user",
    });
  });

  test("unknown values at both levels degrade to the report default", () => {
    const { root, workspaceDir } = scaffold();
    writeConfig(workspaceDir, { gate: "loud" });
    writeConfig(root, { gate: 42 });
    expect(resolveGateMode(workspaceDir)).toEqual({
      mode: "report",
      source: "default",
    });
  });
});

describe("validateSettingsBody strict validation (AC5)", () => {
  test("accepts a well-formed body", () => {
    expect(validateSettingsBody({ gate: "enforce", scope: "user" })).toEqual({
      gate: "enforce",
      scope: "user",
    });
  });
  test("rejects an unknown gate", () => {
    expect(() => validateSettingsBody({ gate: "loud", scope: "user" })).toThrow(
      SettingsValidationError,
    );
  });
  test("rejects an unknown scope", () => {
    expect(() =>
      validateSettingsBody({ gate: "report", scope: "global" }),
    ).toThrow(SettingsValidationError);
  });
  test("rejects a non-object body", () => {
    expect(() => validateSettingsBody("enforce")).toThrow(
      SettingsValidationError,
    );
  });
});

describe("writeGateSetting: right file, 0600, preserves other keys (AC3)", () => {
  test("workspace scope writes <workspaceDir>/config.json, preserving other keys", () => {
    const { workspaceDir } = scaffold();
    writeConfig(workspaceDir, { other: "keep" });
    const res = writeGateSetting(workspaceDir, {
      gate: "enforce",
      scope: "workspace",
    });
    expect(res).toEqual({ mode: "enforce", source: "workspace" });
    const path = join(workspaceDir, "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      other: "keep",
      gate: "enforce",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("user scope writes the sibling ~/.visual-chat/config.json", () => {
    const { root, workspaceDir } = scaffold();
    const res = writeGateSetting(workspaceDir, {
      gate: "enforce",
      scope: "user",
    });
    expect(res).toEqual({ mode: "enforce", source: "user" });
    const path = join(root, "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ gate: "enforce" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
