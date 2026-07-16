// Workspace identity, shared by the Canvas Server and the Claude Code hook.
// Kept dependency-light (crypto + realpath only) so the hook starts fast.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** workspaceId = sha256(realpath(cwd)) truncated to 12 hex chars. */
export function deriveWorkspaceId(cwd: string = process.cwd()): string {
  return createHash("sha256")
    .update(realpathSync(cwd))
    .digest("hex")
    .slice(0, 12);
}
