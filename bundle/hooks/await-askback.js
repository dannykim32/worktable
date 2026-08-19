// hooks/await-askback.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/shared/workspaceId.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
function deriveWorkspaceId(cwd = process.cwd()) {
  return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
}

// hooks/await-askback.ts
var TIMEOUT_MIN_MS = 5000;
var TIMEOUT_MAX_MS = 240000;
var TIMEOUT_DEFAULT_MS = 240000;
var FETCH_SLACK_MS = 1e4;
var BUDGET_DEFAULT_MS = 45 * 60000;
var BUDGET_MAX_MS = 4 * 60 * 60000;
var RETRY_BACKOFF_MIN_MS = 2000;
var RETRY_BACKOFF_MAX_MS = 30000;
function parseFlagMs(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1 || argv[i + 1] === undefined)
    return null;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? Math.floor(n) : null;
}
function parseTimeoutMs(argv) {
  const n = parseFlagMs(argv, "--timeout-ms");
  if (n === null)
    return TIMEOUT_DEFAULT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, n));
}
function parseBudgetMs(argv, timeoutMs) {
  const n = parseFlagMs(argv, "--budget-ms");
  if (n !== null)
    return Math.min(BUDGET_MAX_MS, Math.max(timeoutMs, n));
  if (parseFlagMs(argv, "--timeout-ms") !== null)
    return timeoutMs;
  return BUDGET_DEFAULT_MS;
}
function emit(status, action, detail) {
  console.log(`WORKTABLE_LISTENER status=${status} action=${action}`);
  console.log(detail);
}
function askMessage(pending) {
  return `worktable: ${pending} canvas question(s) waiting — call check_askbacks, ` + "answer each, then re-arm the listener (run this same command in the " + "background again).";
}
function budgetMessage(minutes, canvasOpen) {
  if (canvasOpen === true) {
    return `worktable: listened ~${minutes} min with no questions, and the canvas ` + "page IS still open — the human may still be reading. RE-ARM (same " + "command, in the background).";
  }
  if (canvasOpen === false) {
    return `worktable: listened ~${minutes} min with no questions and the canvas ` + "page is closed. Let the listener rest; re-arm if the human reopens the " + "canvas or asks you to publish again.";
  }
  return `worktable: listened ~${minutes} min with no questions. If the canvas is ` + "still the active surface — an artifact is awaiting the human's input or " + "they're reading — RE-ARM (same command, in the background). Only let it " + "rest if the conversation has clearly moved on from the canvas.";
}
function unreachableMessage(minutes) {
  return `worktable: no canvas server answered for this workspace across ~${minutes} ` + "min. Either the canvas server isn't running, or this background job's " + "working directory doesn't match the one the server was started in (the " + "workspace id is derived from the cwd). If you expect the server to be up " + "— you just published — RE-ARM from the project directory; otherwise let it " + "rest until the human reopens the canvas or you publish again.";
}
function readState(portPath, tokenPath) {
  if (!existsSync(portPath) || !existsSync(tokenPath))
    return null;
  try {
    const port = readFileSync(portPath, "utf8").trim();
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!port || !token)
      return null;
    return { port, token };
  } catch {
    return null;
  }
}
async function awaitAskbacks(port, token, timeoutMs) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs + FETCH_SLACK_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/askbacks/await?timeout_ms=${timeoutMs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (!res.ok)
      throw new Error(`await route responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const argv = process.argv.slice(2);
  const timeoutMs = parseTimeoutMs(argv);
  const budgetMs = parseBudgetMs(argv, timeoutMs);
  const minutes = Math.max(1, Math.round(budgetMs / 60000));
  let workspaceId;
  try {
    workspaceId = deriveWorkspaceId();
  } catch (err) {
    console.error(`worktable: cannot derive workspace from cwd: ${String(err)}`);
    emit("unreachable", "rest", "worktable: this directory isn't a recognizable workspace — could not " + "derive a workspace id from the cwd, so there is no canvas server to " + "address here. Re-arm only from the project directory where the server " + "is running.");
    return;
  }
  const dir = join(homedir(), ".worktable", workspaceId);
  const portPath = join(dir, "port");
  const tokenPath = join(dir, "token");
  const deadline = Date.now() + budgetMs;
  let canvasOpen = null;
  let everReached = false;
  let backoff = RETRY_BACKOFF_MIN_MS;
  let consecutiveFailures = 0;
  let lastFailureLogAt = 0;
  for (;; ) {
    const remaining = deadline - Date.now();
    if (remaining < TIMEOUT_MIN_MS) {
      if (!everReached) {
        emit("unreachable", "retry", unreachableMessage(minutes));
      } else {
        emit("idle", canvasOpen === false ? "rest" : "rearm", budgetMessage(minutes, canvasOpen));
      }
      return;
    }
    const state = readState(portPath, tokenPath);
    if (!state) {
      await sleep(Math.min(backoff, Math.max(0, remaining)));
      backoff = Math.min(RETRY_BACKOFF_MAX_MS, backoff * 2);
      continue;
    }
    try {
      const body = await awaitAskbacks(state.port, state.token, Math.min(timeoutMs, remaining));
      everReached = true;
      backoff = RETRY_BACKOFF_MIN_MS;
      consecutiveFailures = 0;
      if (body.status === "ask") {
        emit("questions", "check", askMessage(body.pending ?? 1));
        return;
      }
      if (typeof body.canvas_open === "boolean")
        canvasOpen = body.canvas_open;
    } catch (err) {
      consecutiveFailures += 1;
      const now = Date.now();
      if (consecutiveFailures === 1) {
        console.error(`worktable: listener poll failed (${String(err)}); retrying within budget.`);
        lastFailureLogAt = now;
      } else if (now - lastFailureLogAt >= 300000) {
        const elapsedMin = Math.round((budgetMs - (deadline - now)) / 60000);
        console.error(`worktable: still unreachable after ${consecutiveFailures} attempts ` + `(~${elapsedMin} min); retrying.`);
        lastFailureLogAt = now;
      }
      await sleep(Math.min(backoff, Math.max(0, remaining)));
      backoff = Math.min(RETRY_BACKOFF_MAX_MS, backoff * 2);
    }
  }
}
main();
