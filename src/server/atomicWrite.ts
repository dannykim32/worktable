// THE atomic file write for all workspace state: tmp file (0600) + rename.
// A crash before the rename commit point leaves the previous state fully
// intact. Every state writer (token/port, artifact versions, ask-back queue)
// goes through here — do not reimplement.
import { renameSync, writeFileSync } from "node:fs";

export interface AtomicWriteHooks {
  /** Test seam: runs between the tmp write and the rename (the commit point). */
  beforeRename?: () => void;
}

export function atomicWriteFile(
  path: string,
  contents: string,
  hooks: AtomicWriteHooks = {},
): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  hooks.beforeRename?.();
  renameSync(tmp, path);
}
