// Workspace identity + capability-token state (ADR-0005).
// All state lives under ~/.visual-chat/<workspaceId>/ — dirs 0700, files 0600.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";
import { deriveWorkspaceId } from "../shared/workspaceId.js";

// The workspace id derivation is shared with the Claude Code hook (issue 13);
// re-exported here so existing `./workspace.js` importers keep working.
export { deriveWorkspaceId };

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface Workspace {
  readonly id: string;
  /** Absolute path of ~/.visual-chat/<id>/ */
  readonly dir: string;
  /** Current capability token (mutable via rotateToken). */
  readonly token: string;
  /** Mint + persist a fresh capability token; old one is dead immediately. */
  rotateToken(): string;
  /** Record the bound HTTP port at <dir>/port. */
  recordPort(port: number): void;
}

export interface OpenWorkspaceOptions {
  cwd?: string;
  /** Overridable for tests; defaults to os.homedir(). */
  home?: string;
}

/**
 * Open (create if needed) the per-workspace state dir and load or mint the
 * capability token. Per-workspace persistence keeps an open canvas tab valid
 * across agent restarts (ADR-0005).
 */
export function openWorkspace(opts: OpenWorkspaceOptions = {}): Workspace {
  const id = deriveWorkspaceId(opts.cwd);
  const root = join(opts.home ?? homedir(), ".visual-chat");
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir mode is masked by umask and skipped for pre-existing dirs; pin both.
  chmodSync(root, 0o700);
  chmodSync(dir, 0o700);

  const tokenPath = join(dir, "token");
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
    if (token.length === 0) throw new Error("empty token file");
  } catch {
    token = mintToken();
    atomicWriteFile(tokenPath, token);
  }
  chmodSync(tokenPath, 0o600);

  return {
    id,
    dir,
    get token() {
      return token;
    },
    rotateToken() {
      token = mintToken();
      atomicWriteFile(tokenPath, token);
      return token;
    },
    recordPort(port: number) {
      atomicWriteFile(join(dir, "port"), String(port));
    },
  };
}
