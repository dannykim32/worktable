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
var IDLE_MESSAGE = "worktable: canvas server not reachable — listener idle. Do not re-arm.";
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
async function main() {
  const argv = process.argv.slice(2);
  const timeoutMs = parseTimeoutMs(argv);
  const budgetMs = parseBudgetMs(argv, timeoutMs);
  let workspaceId;
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
  let port;
  let token;
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
  const deadline = Date.now() + budgetMs;
  let canvasOpen = null;
  for (;; ) {
    const remaining = deadline - Date.now();
    if (remaining < TIMEOUT_MIN_MS) {
      console.log(budgetMessage(Math.max(1, Math.round(budgetMs / 60000)), canvasOpen));
      return;
    }
    try {
      const body = await awaitAskbacks(port, token, Math.min(timeoutMs, remaining));
      if (body.status === "ask") {
        console.log(askMessage(body.pending ?? 1));
        return;
      }
      if (typeof body.canvas_open === "boolean")
        canvasOpen = body.canvas_open;
    } catch (err) {
      console.error(`worktable: listener poll failed: ${String(err)}`);
      console.log(IDLE_MESSAGE);
      return;
    }
  }
}
main();
