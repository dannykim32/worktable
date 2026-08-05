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

// One ARMING listens far longer than one HTTP poll: the route caps a single
// long-poll at 240s, so this CLI loops polls internally and only exits (waking
// the agent) on a question or when the whole budget runs out. Dogfood showed
// why: with 4-minute exits the agent woke empty three times while the human
// was simply reading, concluded they'd left, and stopped listening at the
// exact moment an artifact was waiting on their decisions.
const BUDGET_DEFAULT_MS = 45 * 60_000;
const BUDGET_MAX_MS = 4 * 60 * 60_000;

const IDLE_MESSAGE =
  "worktable: canvas server not reachable — listener idle. Do not re-arm.";

function parseFlagMs(argv: string[], flag: string): number | null {
  const i = argv.indexOf(flag);
  if (i === -1 || argv[i + 1] === undefined) return null;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** Inner poll window (per HTTP request). */
function parseTimeoutMs(argv: string[]): number {
  const n = parseFlagMs(argv, "--timeout-ms");
  if (n === null) return TIMEOUT_DEFAULT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, n));
}

/** Total listening budget across polls. When --timeout-ms is given WITHOUT a
 *  budget, the budget collapses to that one window — explicit short polls
 *  (tests, scripts) keep their single-request semantics. */
function parseBudgetMs(argv: string[], timeoutMs: number): number {
  const n = parseFlagMs(argv, "--budget-ms");
  if (n !== null) return Math.min(BUDGET_MAX_MS, Math.max(timeoutMs, n));
  if (parseFlagMs(argv, "--timeout-ms") !== null) return timeoutMs;
  return BUDGET_DEFAULT_MS;
}

function askMessage(pending: number): string {
  return (
    `worktable: ${pending} canvas question(s) waiting — call check_askbacks, ` +
    "answer each, then re-arm the listener (run this same command in the " +
    "background again)."
  );
}

function budgetMessage(minutes: number): string {
  return (
    `worktable: listened ~${minutes} min with no questions. If the canvas is ` +
    "still the active surface — an artifact is awaiting the human's input or " +
    "they're reading — RE-ARM (same command, in the background). Only let it " +
    "rest if the conversation has clearly moved on from the canvas."
  );
}

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
  const argv = process.argv.slice(2);
  const timeoutMs = parseTimeoutMs(argv);
  const budgetMs = parseBudgetMs(argv, timeoutMs);

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

  // Poll until a question arrives or the budget runs out. Inner timeouts are
  // silent — only the FINAL exit wakes the agent, so listening for 45 minutes
  // costs the same one wake-up as listening for 4.
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < TIMEOUT_MIN_MS) {
      console.log(budgetMessage(Math.max(1, Math.round(budgetMs / 60_000))));
      return;
    }
    try {
      const body = await awaitAskbacks(
        port,
        token,
        Math.min(timeoutMs, remaining),
      );
      if (body.status === "ask") {
        console.log(askMessage(body.pending ?? 1));
        return;
      }
      // timeout → immediately re-poll (the server debounces its "listening"
      // indicator across this gap, so the canvas shows one continuous session).
    } catch (err) {
      // Server down, connection refused/severed, or the poll never answered.
      console.error(`worktable: listener poll failed: ${String(err)}`);
      console.log(IDLE_MESSAGE);
      return;
    }
  }
}

void main();
