// Server config (issue 12): the ONE human-only switch that arms the Legibility
// Gate. `<stateDir>/config.json` `{ "gate": "report" | "enforce" }`, default
// "report". There is deliberately NO MCP tool to write this file — arming or
// disarming enforcement is a one-way trust decision the human makes by editing
// the file (docs/setup.md). The agent can never grant itself enforcement, nor
// remove it (ADR-0007: calibrate-before-enforce is a human sign-off).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type GateMode = "report" | "enforce";

/** Read the gate mode from `<stateDir>/config.json`. Anything other than an
 *  explicit `"enforce"` — missing file, unreadable, malformed, unknown value —
 *  degrades to the safe default `"report"`. Read once at server startup; a
 *  human flip takes effect on the next server restart. */
export function readGateMode(stateDir: string): GateMode {
  try {
    const parsed = JSON.parse(
      readFileSync(join(stateDir, "config.json"), "utf8"),
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { gate?: unknown }).gate === "enforce"
    ) {
      return "enforce";
    }
  } catch {
    // no config, or unreadable/malformed → safe default
  }
  return "report";
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
