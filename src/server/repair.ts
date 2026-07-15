// Repair-round bookkeeping (issue 12 / ADR-0007). When enforcement is armed and
// a free-form SVG fails the Legibility Gate, the agent gets ONE bounded repair
// round: the first failure hands back the exact coordinate findings and opens a
// repair context; a second failing submission in the SAME context becomes an
// Honest Absence. This registry is that per-context attempt counter.
//
// Persisted to `<stateDir>/repair-contexts.json` so a context survives a server
// restart (AC5): the agent still holds its repair token / artifact id across the
// restart, so its resubmission lands in the same context. Contexts expire after
// one hour — a stale context must never turn a fresh, unrelated submission into
// an absence.
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";

/** A repair context lives for one hour from its first failure (issue 12). */
export const REPAIR_TTL_MS = 60 * 60 * 1000;

interface RepairContext {
  key: string;
  /** Failing submissions recorded in this context so far. */
  attempts: number;
  /** Epoch ms of the first failure — the TTL anchor. */
  createdAt: number;
}

/** A provisional publish token: the key for a repair context that has no
 *  artifact id yet (a brand-new publish). The agent echoes it on resubmission
 *  so the server correlates the retry with the original failure. */
export function mintRepairToken(): string {
  return `rt_${randomBytes(6).toString("hex")}`;
}

export class RepairRegistry {
  private readonly path: string;
  private readonly now: () => number;
  private contexts = new Map<string, RepairContext>();

  constructor(stateDir: string, now: () => number = Date.now) {
    this.path = join(stateDir, "repair-contexts.json");
    this.now = now;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const c of parsed as RepairContext[]) {
        if (
          c &&
          typeof c.key === "string" &&
          typeof c.attempts === "number" &&
          typeof c.createdAt === "number"
        ) {
          this.contexts.set(c.key, c);
        }
      }
    } catch {
      // corrupt file → start clean; the registry is a cache of intent, not a
      // source of truth, so a bad read must never crash the server.
    }
  }

  private persist(): void {
    atomicWriteFile(
      this.path,
      JSON.stringify([...this.contexts.values()], null, 2),
    );
  }

  private purgeExpired(): void {
    const cutoff = this.now() - REPAIR_TTL_MS;
    let changed = false;
    for (const [key, c] of this.contexts) {
      if (c.createdAt <= cutoff) {
        this.contexts.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Is `key` a live (unexpired) repair context? */
  has(key: string): boolean {
    this.purgeExpired();
    return this.contexts.has(key);
  }

  /** Record a FAILING submission against `key`. Returns whether the repair
   *  round is now spent — i.e. this is the second (or later) failure in a
   *  still-live context, so the caller must convert to Honest Absence. A fresh
   *  or expired key starts a new context at attempt 1 (secondFailure=false). */
  recordFailure(key: string): { attempt: number; secondFailure: boolean } {
    this.purgeExpired();
    const existing = this.contexts.get(key);
    if (existing) {
      existing.attempts += 1;
      this.persist();
      return { attempt: existing.attempts, secondFailure: true };
    }
    this.contexts.set(key, { key, attempts: 1, createdAt: this.now() });
    this.persist();
    return { attempt: 1, secondFailure: false };
  }

  /** Clear a context — a passing submission, or one just converted to absence. */
  clear(key: string): void {
    if (this.contexts.delete(key)) this.persist();
  }
}
