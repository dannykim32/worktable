// Poll-wake listener CLI. The agent runs this as a BACKGROUNDED Bash job while
// idle; it long-polls GET /api/askbacks/await, and when the human sends an
// ask-back the server resolves the poll, this process exits, and the Agent Host
// re-invokes the agent with the stdout below — no terminal keystroke needed.
//
// READ-ONLY by construction: the await route never marks delivery, so this job
// and check_askbacks never race destructively (delivery stays with the tool).
//
// EXIT CONTRACT. The exit code is ALWAYS 0 — a dead or slow canvas server must
// never fail a background job loudly, and the Agent Host re-invokes the agent on
// any exit regardless of code. All signal rides stdout, whose FIRST line is a
// stable, machine-parseable status the agent branches on without parsing prose:
//   WORKTABLE_LISTENER status=<questions|idle|unreachable> action=<check|rearm|rest|retry>
// A human-readable line follows it. `status` disambiguates the two exits that
// used to look identical (a healthy quiet expiry vs. a server that never
// answered); `action` always names a live next step, so there is no dead end.
//
// UNREACHABLE IS RETRIED, NOT FATAL. "Publish now, the human opens the canvas
// later" is the normal case, and a canvas-server restart can rebind to a
// different port in [8787,8887]. So the listener RE-READS the port/token files
// and RETRIES within its budget (short backoff) instead of giving up on the
// first missing-state or refused-connection. Only a cwd that yields no workspace
// id at all is structural (retrying can't fix a wrong directory) — that exits at
// once. Everything else keeps trying until a question arrives or the budget ends.
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

// Backoff between UNREACHABLE attempts (server down / state files absent). A
// live-but-quiet server needs no backoff — its long-poll already blocks for the
// window — so this gap only paces the retries when there is nothing to talk to,
// keeping a down server from becoming a busy loop while staying responsive when
// it comes up.
const RETRY_BACKOFF_MIN_MS = 2_000;
const RETRY_BACKOFF_MAX_MS = 30_000;

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

type Status = "questions" | "idle" | "unreachable";
type Action = "check" | "rearm" | "rest" | "retry";

/** The single exit point. Prints the stable status line the agent branches on,
 *  then the human-readable detail. Exit code stays 0 (see EXIT CONTRACT). */
function emit(status: Status, action: Action, detail: string): void {
  console.log(`WORKTABLE_LISTENER status=${status} action=${action}`);
  console.log(detail);
}

function askMessage(pending: number): string {
  return (
    `worktable: ${pending} canvas question(s) waiting — call check_askbacks, ` +
    "answer each, then re-arm the listener (run this same command in the " +
    "background again)."
  );
}

/** The exit message states a FACT about the canvas page when the server
 *  reported one (a live tab holds an SSE stream), so the agent's re-arm/rest
 *  call needs no guessing. `null` = talking to a server that didn't say. */
function budgetMessage(minutes: number, canvasOpen: boolean | null): string {
  if (canvasOpen === true) {
    return (
      `worktable: listened ~${minutes} min with no questions, and the canvas ` +
      "page IS still open — the human may still be reading. RE-ARM (same " +
      "command, in the background)."
    );
  }
  if (canvasOpen === false) {
    return (
      `worktable: listened ~${minutes} min with no questions and the canvas ` +
      "page is closed. Let the listener rest; re-arm if the human reopens the " +
      "canvas or asks you to publish again."
    );
  }
  return (
    `worktable: listened ~${minutes} min with no questions. If the canvas is ` +
    "still the active surface — an artifact is awaiting the human's input or " +
    "they're reading — RE-ARM (same command, in the background). Only let it " +
    "rest if the conversation has clearly moved on from the canvas."
  );
}

/** Budget spent without a single successful contact. Names both hypotheses —
 *  server not up, or wrong working directory — so the agent can judge whether a
 *  re-arm is worthwhile rather than being told a flat "do not re-arm". */
function unreachableMessage(minutes: number): string {
  return (
    `worktable: no canvas server answered for this workspace across ~${minutes} ` +
    "min. Either the canvas server isn't running, or this background job's " +
    "working directory doesn't match the one the server was started in (the " +
    "workspace id is derived from the cwd). If you expect the server to be up " +
    "— you just published — RE-ARM from the project directory; otherwise let it " +
    "rest until the human reopens the canvas or you publish again."
  );
}

/** Read the current port/token for this workspace. Returns null when either
 *  file is absent or empty — a transient "no live server right now" state that
 *  the caller retries, since the server may (re)appear and rewrite them. Read
 *  fresh on EVERY attempt: a restarted server can bind a different port. */
function readState(
  portPath: string,
  tokenPath: string,
): { port: string; token: string } | null {
  if (!existsSync(portPath) || !existsSync(tokenPath)) return null;
  try {
    const port = readFileSync(portPath, "utf8").trim();
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!port || !token) return null;
    return { port, token };
  } catch {
    return null;
  }
}

async function awaitAskbacks(
  port: string,
  token: string,
  timeoutMs: number,
): Promise<{ status?: string; pending?: number; canvas_open?: boolean }> {
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const timeoutMs = parseTimeoutMs(argv);
  const budgetMs = parseBudgetMs(argv, timeoutMs);
  const minutes = Math.max(1, Math.round(budgetMs / 60_000));

  // Structural, not transient: a cwd that yields no workspace id can never be
  // fixed by waiting, so this is the one case that exits at once.
  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId();
  } catch (err) {
    console.error(`worktable: cannot derive workspace from cwd: ${String(err)}`);
    emit(
      "unreachable",
      "rest",
      "worktable: this directory isn't a recognizable workspace — could not " +
        "derive a workspace id from the cwd, so there is no canvas server to " +
        "address here. Re-arm only from the project directory where the server " +
        "is running.",
    );
    return;
  }

  const dir = join(homedir(), ".worktable", workspaceId);
  const portPath = join(dir, "port");
  const tokenPath = join(dir, "token");

  // Poll until a question arrives or the budget runs out. Inner timeouts are
  // silent — only the FINAL exit wakes the agent, so listening for 45 minutes
  // costs the same one wake-up as listening for 4. A missing server or refused
  // poll is retried (re-reading the state files each time) rather than fatal.
  const deadline = Date.now() + budgetMs;
  let canvasOpen: boolean | null = null;
  let everReached = false;
  let backoff = RETRY_BACKOFF_MIN_MS;
  // Throttle unreachable-retry noise: a long outage retries many times, but the
  // failure is the same every time. Log the first, then a heartbeat every 5 min,
  // and reset on any successful contact — so stderr stays readable instead of
  // hundreds of identical lines.
  let consecutiveFailures = 0;
  let lastFailureLogAt = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < TIMEOUT_MIN_MS) {
      if (!everReached) {
        // Never once reached a server across the whole budget.
        emit("unreachable", "retry", unreachableMessage(minutes));
      } else {
        emit(
          "idle",
          canvasOpen === false ? "rest" : "rearm",
          budgetMessage(minutes, canvasOpen),
        );
      }
      return;
    }

    const state = readState(portPath, tokenPath);
    if (!state) {
      // No live server state for this workspace right now — it may appear
      // (server starting, or recordPort not yet written). Back off and retry.
      await sleep(Math.min(backoff, Math.max(0, remaining)));
      backoff = Math.min(RETRY_BACKOFF_MAX_MS, backoff * 2);
      continue;
    }

    try {
      const body = await awaitAskbacks(
        state.port,
        state.token,
        Math.min(timeoutMs, remaining),
      );
      everReached = true;
      backoff = RETRY_BACKOFF_MIN_MS; // reset after a good contact
      consecutiveFailures = 0;
      if (body.status === "ask") {
        emit("questions", "check", askMessage(body.pending ?? 1));
        return;
      }
      // timeout → remember whether a canvas tab was connected, then re-poll
      // immediately (the server's own long-poll paced us; no backoff needed).
      // The server debounces its "listening" indicator across this gap, so the
      // canvas shows one continuous session.
      if (typeof body.canvas_open === "boolean") canvasOpen = body.canvas_open;
    } catch (err) {
      // Server down, connection refused/severed, or the poll never answered.
      // Not fatal: back off and retry — the next attempt re-reads the state
      // files, so a server that restarted onto a new port is picked up. Only
      // the first failure and a 5-min heartbeat are logged (see counters above).
      consecutiveFailures += 1;
      const now = Date.now();
      if (consecutiveFailures === 1) {
        console.error(
          `worktable: listener poll failed (${String(err)}); retrying within budget.`,
        );
        lastFailureLogAt = now;
      } else if (now - lastFailureLogAt >= 300_000) {
        const elapsedMin = Math.round((budgetMs - (deadline - now)) / 60_000);
        console.error(
          `worktable: still unreachable after ${consecutiveFailures} attempts ` +
            `(~${elapsedMin} min); retrying.`,
        );
        lastFailureLogAt = now;
      }
      await sleep(Math.min(backoff, Math.max(0, remaining)));
      backoff = Math.min(RETRY_BACKOFF_MAX_MS, backoff * 2);
    }
  }
}

void main();
