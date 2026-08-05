// Poll-wake listener CLI. The agent runs this as a BACKGROUNDED Bash job while
// idle; it long-polls GET /api/askbacks/await, and when the human sends an
// ask-back the server resolves the poll, this process exits, and the Agent Host
// re-invokes the agent with the stdout below — no terminal keystroke needed.
//
// READ-ONLY by construction: the await route never marks delivery, so this job
// and check_askbacks never race destructively (delivery stays with the tool).
// stdout is the re-invoked agent's instruction and always states the next
// action; errors go to stderr; the exit code is always 0 so a dead server can
// never fail a background job loudly.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceId } from "../src/shared/workspaceId.js";

// Mirrors the server clamp (src/server/listeners.ts) so what we wait on
// client-side matches what the route will actually hold open.
const TIMEOUT_MIN_MS = 5_000;
const TIMEOUT_MAX_MS = 240_000;
const TIMEOUT_DEFAULT_MS = 240_000;
/** Fetch slack past the poll window: the server must win the timeout race. */
const FETCH_SLACK_MS = 10_000;

const IDLE_MESSAGE =
  "worktable: canvas server not reachable — listener idle. Do not re-arm.";

function parseTimeoutMs(argv: string[]): number {
  const i = argv.indexOf("--timeout-ms");
  if (i === -1 || argv[i + 1] === undefined) return TIMEOUT_DEFAULT_MS;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n)) return TIMEOUT_DEFAULT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.floor(n)));
}

function askMessage(pending: number): string {
  return (
    `worktable: ${pending} canvas question(s) waiting — call check_askbacks, ` +
    "answer each, then re-arm the listener (run this same command in the " +
    "background again)."
  );
}

const TIMEOUT_MESSAGE =
  "worktable: listener window ended with no questions. Re-arm it (same " +
  "command, in the background) if you're still working with the canvas; " +
  "otherwise let it rest.";

async function awaitAskbacks(
  port: string,
  token: string,
  timeoutMs: number,
): Promise<{ status?: string; pending?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + FETCH_SLACK_MS);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/askbacks/await?timeout_ms=${timeoutMs}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`await route responded ${res.status}`);
    return (await res.json()) as { status?: string; pending?: number };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const timeoutMs = parseTimeoutMs(process.argv.slice(2));

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId();
  } catch (err) {
    console.error(`worktable: cannot derive workspace from cwd: ${String(err)}`);
    console.log(IDLE_MESSAGE);
    return;
  }

  const dir = join(homedir(), ".worktable", workspaceId);
  const portPath = join(dir, "port");
  const tokenPath = join(dir, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    console.log(IDLE_MESSAGE);
    return;
  }

  let port: string;
  let token: string;
  try {
    port = readFileSync(portPath, "utf8").trim();
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (err) {
    console.error(`worktable: cannot read workspace state: ${String(err)}`);
    console.log(IDLE_MESSAGE);
    return;
  }
  if (!port || !token) {
    console.log(IDLE_MESSAGE);
    return;
  }

  try {
    const body = await awaitAskbacks(port, token, timeoutMs);
    if (body.status === "ask") {
      console.log(askMessage(body.pending ?? 1));
    } else {
      console.log(TIMEOUT_MESSAGE);
    }
  } catch (err) {
    // Server down, connection refused/severed, or the poll never answered.
    console.error(`worktable: listener poll failed: ${String(err)}`);
    console.log(IDLE_MESSAGE);
  }
}

void main();
