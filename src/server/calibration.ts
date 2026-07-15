// Calibration ledger (issue 11): the human's rulings on Legibility Gate
// findings, append-only in `<stateDir>/calibration.jsonl` (0600). This is the
// evidence that ADR-0007 requires before the gate may ever gain enforcement
// power (issue 12) — so it is a plain, auditable, append-only log, never
// silently rewritten.
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Verdict = "correct" | "false-positive";
export type GateCheck =
  | "text-overlap"
  | "edge-straddle"
  | "clipped"
  | "sub-legible";

const CHECKS: GateCheck[] = [
  "text-overlap",
  "edge-straddle",
  "clipped",
  "sub-legible",
];

/** One human ruling on one finding. `finding_index` is the finding's position
 *  in the Version's stored `v<N>.findings.json`, so a ruling pins to an exact
 *  finding. */
export interface Ruling {
  artifact_id: string;
  version: number;
  finding_index: number;
  check: GateCheck;
  verdict: Verdict;
  ts: string;
}

/** Per-check precision: correct / (correct + false-positive), over the latest
 *  ruling per distinct finding. `null` precision means "not yet ruled on". */
export interface CheckPrecision {
  check: GateCheck;
  correct: number;
  falsePositive: number;
  precision: number | null;
}

export interface CalibrationSummary {
  perCheck: CheckPrecision[];
  totalRulings: number;
}

export class InvalidRulingError extends Error {}

function isVerdict(v: unknown): v is Verdict {
  return v === "correct" || v === "false-positive";
}

function isCheck(v: unknown): v is GateCheck {
  return typeof v === "string" && (CHECKS as string[]).includes(v);
}

export class CalibrationLedger {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "calibration.jsonl");
  }

  /** Validate and append a ruling. Returns the stored record (with its ts). */
  append(body: unknown): Ruling {
    if (typeof body !== "object" || body === null) {
      throw new InvalidRulingError("expected a JSON object");
    }
    const b = body as Record<string, unknown>;
    if (typeof b.artifact_id !== "string" || b.artifact_id === "") {
      throw new InvalidRulingError("artifact_id must be a non-empty string");
    }
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) {
      throw new InvalidRulingError("version must be a positive integer");
    }
    if (
      typeof b.finding_index !== "number" ||
      !Number.isInteger(b.finding_index) ||
      b.finding_index < 0
    ) {
      throw new InvalidRulingError("finding_index must be a non-negative integer");
    }
    if (!isCheck(b.check)) {
      throw new InvalidRulingError(`check must be one of ${CHECKS.join(", ")}`);
    }
    if (!isVerdict(b.verdict)) {
      throw new InvalidRulingError('verdict must be "correct" or "false-positive"');
    }
    const ruling: Ruling = {
      artifact_id: b.artifact_id,
      version: b.version,
      finding_index: b.finding_index,
      check: b.check,
      verdict: b.verdict,
      ts: new Date().toISOString(),
    };
    const existed = existsSync(this.path);
    appendFileSync(this.path, `${JSON.stringify(ruling)}\n`, { mode: 0o600 });
    if (!existed) chmodSync(this.path, 0o600);
    return ruling;
  }

  /** Every ruling in log order (ignoring unparseable lines). */
  all(): Ruling[] {
    if (!existsSync(this.path)) return [];
    const out: Ruling[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const r = JSON.parse(line) as Ruling;
        if (isCheck(r.check) && isVerdict(r.verdict)) out.push(r);
      } catch {
        // skip corrupt lines — the ledger stays readable
      }
    }
    return out;
  }

  /** Precision per check, counting the LATEST ruling per distinct finding so a
   *  human can correct an earlier misclick. */
  summary(): CalibrationSummary {
    const latest = new Map<string, Ruling>();
    for (const r of this.all()) {
      latest.set(`${r.artifact_id}:${r.version}:${r.finding_index}`, r);
    }
    const counts = new Map<GateCheck, { correct: number; fp: number }>();
    for (const c of CHECKS) counts.set(c, { correct: 0, fp: 0 });
    for (const r of latest.values()) {
      const c = counts.get(r.check)!;
      if (r.verdict === "correct") c.correct++;
      else c.fp++;
    }
    const perCheck: CheckPrecision[] = CHECKS.map((check) => {
      const { correct, fp } = counts.get(check)!;
      const ruled = correct + fp;
      return {
        check,
        correct,
        falsePositive: fp,
        precision: ruled === 0 ? null : correct / ruled,
      };
    });
    return { perCheck, totalRulings: latest.size };
  }
}
