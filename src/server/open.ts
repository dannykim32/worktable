// OS-open a URL in the default browser. Honors WORKTABLE_NO_OPEN=1.
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
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
