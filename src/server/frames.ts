// Frame slug registry (issue 25): a fresh 128-bit random slug per html Version,
// mapped server-side to (artifactId, version). The slug — NOT the 8-hex display
// id — gates the token-free frame routes (issue 15 pre-decision 3): it is the
// only thing that need be unguessable there, and it must never be the display id
// (which is short and shown in the UI). Every prior Version keeps its slug so
// the version scrubber can still frame old html (ADR-0006).
//
// Persisted to <stateDir>/frames.json so an open canvas tab keeps working across
// an agent restart (ADR-0005): the canvas reloads artifacts and re-derives each
// frame URL from the same slug.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrameSlug } from "../shared/constraints.js";
import { atomicWriteJson } from "./store.js";

interface FrameTarget {
  artifactId: string;
  version: number;
}

/** Mint 16 random bytes as lowercase hex — a 128-bit slug. */
export function mintFrameSlug(): string {
  return randomBytes(16).toString("hex");
}

export class FrameRegistry {
  private readonly path: string;
  private readonly bySlug = new Map<string, FrameTarget>();
  private readonly byVersion = new Map<string, string>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "frames.json");
    this.loadFromDisk();
  }

  private static key(artifactId: string, version: number): string {
    return `${artifactId}@${version}`;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      for (const [slug, target] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (!isFrameSlug(slug)) continue;
        const t = target as { artifactId?: unknown; version?: unknown };
        if (typeof t.artifactId !== "string") continue;
        if (typeof t.version !== "number" || !Number.isInteger(t.version)) {
          continue;
        }
        this.bySlug.set(slug, { artifactId: t.artifactId, version: t.version });
        this.byVersion.set(FrameRegistry.key(t.artifactId, t.version), slug);
      }
    } catch (err) {
      console.error(
        `visual-chat: skipping unreadable frame registry ${this.path}: ${String(err)}`,
      );
    }
  }

  private persist(): void {
    const out: Record<string, FrameTarget> = {};
    for (const [slug, target] of this.bySlug) out[slug] = target;
    atomicWriteJson(this.path, out);
  }

  /** Mint (or reuse) the slug for a specific (artifactId, version). Idempotent:
   *  re-publishing the same version returns the existing slug. */
  mint(artifactId: string, version: number): string {
    const key = FrameRegistry.key(artifactId, version);
    const existing = this.byVersion.get(key);
    if (existing) return existing;
    let slug = mintFrameSlug();
    while (this.bySlug.has(slug)) slug = mintFrameSlug();
    this.bySlug.set(slug, { artifactId, version });
    this.byVersion.set(key, slug);
    this.persist();
    return slug;
  }

  /** Resolve a slug to its target, or null. Unknown/malformed → null (the frame
   *  server 404s, leaking nothing). */
  resolve(slug: unknown): FrameTarget | null {
    if (!isFrameSlug(slug)) return null;
    return this.bySlug.get(slug) ?? null;
  }

  /** The slug for a (artifactId, version), or null if none was minted. */
  slugFor(artifactId: string, version: number): string | null {
    return this.byVersion.get(FrameRegistry.key(artifactId, version)) ?? null;
  }
}
