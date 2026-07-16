// Server config (issue 12 / ADR-0011): the Legibility Gate's enforce/report mode
// is a first-class HUMAN setting, resolved by precedence over two files —
//
//     <workspaceDir>/config.json .gate  >  ~/.visual-chat/config.json .gate  >  "report"
//
// The workspace file overrides for that workspace; the user file is the default
// for every workspace; and when nothing is set anywhere, the safe "report"
// default wins. There is deliberately NO MCP tool that writes either file —
// arming or disarming enforcement is a one-way trust decision the human makes,
// now through the token-gated canvas settings panel (a browser/human surface) or
// by hand (docs/setup.md). The agent's tool surface can never grant itself
// enforcement, nor remove it (ADR-0007: calibrate-before-enforce is a human
// sign-off). Gate mode is not a hard boundary against a filesystem-capable agent
// — it is a QUALITY control the human owns.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";

export type GateMode = "report" | "enforce";
export type GateScope = "workspace" | "user";

/** Where a resolved gate mode came from, for the UI to explain itself. */
export type GateSource = GateScope | "default";

export interface GateResolution {
  mode: GateMode;
  source: GateSource;
}

/** Read an EXPLICIT gate setting from one config.json. Returns the value only
 *  when `.gate` is exactly `"enforce"` or `"report"`; a missing file, unreadable
 *  file, malformed JSON, or any other value yields `null` so the caller falls
 *  through to the next precedence level. Note: an explicit `"report"` is NOT the
 *  same as absent — a workspace `"report"` deliberately overrides a user-level
 *  `"enforce"`. */
function readGateSetting(configPath: string): GateMode | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const gate = (parsed as { gate?: unknown }).gate;
      if (gate === "enforce" || gate === "report") return gate;
    }
  } catch {
    // no config, unreadable, or malformed → degrade to the next level
  }
  return null;
}

/** The user-level config path (`~/.visual-chat/config.json`) — the sibling of
 *  the per-workspace state dirs. Derived from the workspace dir so it honours a
 *  test's isolated HOME without a second parameter. */
export function userConfigPath(workspaceDir: string): string {
  return join(dirname(workspaceDir), "config.json");
}

/** The per-workspace config path (`<workspaceDir>/config.json`). */
export function workspaceConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

/**
 * Resolve the effective gate mode by precedence: an explicit workspace override
 * wins over an explicit user-level default, which wins over the safe `"report"`
 * default. Anything malformed or missing at either level degrades to the next.
 * Cheap enough (at most two small file reads) to call PER PUBLISH, so a settings
 * flip takes effect on the next artifact with no server restart (ADR-0011).
 * Returns the source so the settings panel can say where the mode came from.
 */
export function resolveGateMode(workspaceDir: string): GateResolution {
  const workspace = readGateSetting(workspaceConfigPath(workspaceDir));
  if (workspace !== null) return { mode: workspace, source: "workspace" };
  const user = readGateSetting(userConfigPath(workspaceDir));
  if (user !== null) return { mode: user, source: "user" };
  return { mode: "report", source: "default" };
}

/**
 * Whether the enforcement path should engage for a submission. FALSE for report
 * mode, for non-svg artifacts, and — critically — whenever there are zero
 * findings. `runGateSafe` degrades a gate THROW to zero findings, so a gate
 * crash can never satisfy this predicate: the fail-open invariant (ADR-0007,
 * issue 12) is structural here, not a special case. Enforcement acts on real
 * coordinate findings only, never on a gate exception.
 */
export function shouldEnforce(input: {
  mode: GateMode;
  type: string;
  findings: readonly unknown[];
}): boolean {
  return (
    input.mode === "enforce" &&
    input.type === "svg" &&
    input.findings.length > 0
  );
}

/** A rejected settings write (unknown gate or scope). Surfaced as a 400 by the
 *  route; NOTHING is written when this throws. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export interface SettingsUpdate {
  gate: GateMode;
  scope: GateScope;
}

/** Strictly validate a `POST /api/settings` body. Only `gate ∈ {report,
 *  enforce}` and `scope ∈ {workspace, user}` are accepted; anything else throws
 *  SettingsValidationError and the caller writes nothing. */
export function validateSettingsBody(body: unknown): SettingsUpdate {
  if (typeof body !== "object" || body === null) {
    throw new SettingsValidationError("body must be a JSON object");
  }
  const { gate, scope } = body as { gate?: unknown; scope?: unknown };
  if (gate !== "report" && gate !== "enforce") {
    throw new SettingsValidationError('gate must be "report" or "enforce"');
  }
  if (scope !== "workspace" && scope !== "user") {
    throw new SettingsValidationError('scope must be "workspace" or "user"');
  }
  return { gate, scope };
}

/**
 * Write the chosen gate mode to the config.json for `scope`, preserving any
 * other keys already in that file. The user-level file lives in
 * `~/.visual-chat/`, which is (re)ensured 0700; the file itself is written
 * atomically at 0600 (atomicWriteFile). Returns the new resolution so the caller
 * can echo the live effective mode + source.
 */
export function writeGateSetting(
  workspaceDir: string,
  update: SettingsUpdate,
): GateResolution {
  const configPath =
    update.scope === "user"
      ? userConfigPath(workspaceDir)
      : workspaceConfigPath(workspaceDir);

  // Preserve any other keys already present (only a valid JSON object counts;
  // a malformed file is replaced rather than allowed to fail the write).
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // no existing file / malformed → start clean
  }

  // Ensure the containing dir exists 0700 (the user-level ~/.visual-chat is
  // normally created at boot, but pin it here for the first user-scope write).
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; the dir is under the user's own HOME
  }

  const merged = { ...existing, gate: update.gate };
  atomicWriteFile(configPath, JSON.stringify(merged, null, 2));
  chmodSync(configPath, 0o600);

  return resolveGateMode(workspaceDir);
}
