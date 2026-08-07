// hooks/askback-hook.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/shared/workspaceId.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
function deriveWorkspaceId(cwd = process.cwd()) {
  return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
}

// hooks/askback-hook.ts
var REQUEST_TIMEOUT_MS = 300;
function formatPending(items) {
  const lines = [
    `The human left ${items.length} unread canvas ask-back` + `${items.length === 1 ? "" : "s"} on the worktable canvas:`,
    ""
  ];
  for (const item of items) {
    const title = item.artifact_title ?? item.anchor.artifact_id;
    const where = item.anchor.block_index === null ? `${title} (v${item.anchor.version}, whole artifact)` : `${title} (v${item.anchor.version}, block ${item.anchor.block_index})`;
    if (item.kind === "approval") {
      lines.push(`- Approved: ${where}`);
    } else {
      lines.push(`- On ${where}, re: “${item.quote}”: ${item.question}`);
    }
  }
  lines.push("");
  lines.push("Call the check_askbacks tool to acknowledge these (it marks them " + "delivered), then answer each using its anchor's context.");
  return lines.join(`
`);
}
async function fetchPending(port, token) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/askbacks/pending`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (!res.ok)
      return [];
    const body = await res.json();
    return body.askbacks ?? [];
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  let workspaceId;
  try {
    workspaceId = deriveWorkspaceId();
  } catch {
    return;
  }
  const dir = join(homedir(), ".worktable", workspaceId);
  const portPath = join(dir, "port");
  const tokenPath = join(dir, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath))
    return;
  let port;
  let token;
  try {
    port = readFileSync(portPath, "utf8").trim();
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return;
  }
  if (!port || !token)
    return;
  let items;
  try {
    items = await fetchPending(port, token);
  } catch {
    return;
  }
  if (items.length === 0)
    return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatPending(items)
    }
  }));
}
main();
