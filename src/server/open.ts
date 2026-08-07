// OS-open a URL in the default browser. Honors WORKTABLE_NO_OPEN=1.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export function openInBrowser(url: string): void {
  // Test seam: when set, record the URL instead of launching a browser, so
  // integration tests can assert auto-open decisions against the real server.
  // Checked first so it works even when WORKTABLE_NO_OPEN=1 is also set.
  const logPath = process.env.WORKTABLE_OPEN_LOG;
  if (logPath) {
    try {
      appendFileSync(logPath, `${url}\n`);
    } catch {
      /* best-effort test seam */
    }
    return;
  }
  if (process.env.WORKTABLE_NO_OPEN === "1") return;
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      console.error(`worktable: could not open browser: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`worktable: could not open browser: ${String(err)}`);
  }
}

/** Decide whether a publish/update should auto-open the canvas.
 *
 *  Open only when NO tab is watching (`clientCount === 0`): a live tab holds an
 *  SSE stream and reconnects on its own, so it receives the event without a new
 *  tab. The debounce suppresses a second open while the first tab is still
 *  loading (a publish-then-update burst would otherwise spawn duplicate tabs
 *  before either connects). */
export function shouldOpenCanvas(
  clientCount: number,
  msSinceLastOpen: number,
  debounceMs: number,
): boolean {
  return clientCount === 0 && msSinceLastOpen >= debounceMs;
}
