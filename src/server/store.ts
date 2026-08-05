// Versioned in-place Artifact store (ADR-0006): stable identities, atomic
// full-content writes, every prior Version retained.
// Layout: <stateDir>/artifacts/<artifact_id>/v<N>.json + meta.json
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ArtifactContent, ArtifactMeta } from "../shared/artifacts.js";
import { atomicWriteFile, type AtomicWriteHooks } from "./atomicWrite.js";

export class UnknownArtifactError extends Error {
  constructor(id: string) {
    super(`unknown artifact_id: ${id}`);
  }
}

/** An Artifact keeps one type for its lifetime (stable identity, ADR-0006). */
export class ArtifactTypeMismatchError extends Error {
  constructor(id: string, existing: string, attempted: string) {
    super(
      `invalid input at /type: artifact ${id} is type "${existing}"; ` +
        `an artifact keeps one type for its lifetime (got "${attempted}")`,
    );
  }
}

export function mintArtifactId(): string {
  return `a_${randomBytes(4).toString("hex")}`;
}

/** JSON flavor of the single atomic tmp+rename helper (atomicWrite.ts).
 *  A crash before the rename leaves prior state intact — never a torn
 *  v<N>.json. */
export function atomicWriteJson(
  path: string,
  value: unknown,
  hooks: AtomicWriteHooks = {},
): void {
  atomicWriteFile(path, JSON.stringify(value, null, 2), hooks);
}

export class ArtifactStore {
  private readonly root: string;
  private readonly metas = new Map<string, ArtifactMeta>();

  constructor(stateDir: string) {
    this.root = join(stateDir, "artifacts");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(this.root, entry.name, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ArtifactMeta;
        this.metas.set(meta.id, meta);
      } catch (err) {
        console.error(
          `worktable: skipping unreadable artifact meta ${metaPath}: ${String(err)}`,
        );
      }
    }
  }

  publish(content: ArtifactContent): ArtifactMeta {
    const id = mintArtifactId();
    const now = new Date().toISOString();
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    atomicWriteJson(join(dir, "v1.json"), content);
    const meta: ArtifactMeta = {
      id,
      type: content.type,
      title: content.title,
      latest: 1,
      created_at: now,
      updated_at: now,
    };
    atomicWriteJson(join(dir, "meta.json"), meta);
    this.metas.set(id, meta);
    return meta;
  }

  update(id: string, content: ArtifactContent): ArtifactMeta {
    const meta = this.metas.get(id);
    if (!meta) throw new UnknownArtifactError(id);
    if (meta.type !== content.type) {
      throw new ArtifactTypeMismatchError(id, meta.type, content.type);
    }
    const version = meta.latest + 1;
    const dir = join(this.root, id);
    atomicWriteJson(join(dir, `v${version}.json`), content);
    const updated: ArtifactMeta = {
      ...meta,
      title: content.title,
      latest: version,
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(join(dir, "meta.json"), updated);
    this.metas.set(id, updated);
    return updated;
  }

  /** All metas, most recently updated first. */
  list(): ArtifactMeta[] {
    return [...this.metas.values()].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
    );
  }

  getMeta(id: string): ArtifactMeta | null {
    return this.metas.get(id) ?? null;
  }

  /** A specific Version's full content, or null if absent (ADR-0006: every
   *  prior Version stays readable). */
  getVersion(id: string, version: number): ArtifactContent | null {
    const meta = this.metas.get(id);
    if (!meta || !Number.isInteger(version) || version < 1) return null;
    if (version > meta.latest) return null;
    const path = join(this.root, id, `v${version}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ArtifactContent;
  }
}
