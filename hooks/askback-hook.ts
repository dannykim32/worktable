// Claude Code UserPromptSubmit hook (issue 13, ADR-0004). Peeks the pending
// ask-backs for the current workspace and appends them as additionalContext to
// whatever the user types next, removing the "nudge the terminal" ritual.
//
// READ-ONLY by construction: it hits GET /api/askbacks/pending, which never
// marks delivery. Delivery marking stays with check_askbacks, so the hook and
// the tool never race destructively and running the hook N times cannot lose
// or mutate a queued ask-back. Any failure — missing state, server down,
// timeout — exits 0 with no output, so the portable core keeps working.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceId } from "../src/shared/workspaceId.js";

const REQUEST_TIMEOUT_MS = 300;

interface PendingItem {
  question: string;
  quote: string;
  anchor: { artifact_id: string; version: number; block_index: number | null };
  artifact_title: string | null;
  kind?: string;
}

function formatPending(items: PendingItem[]): string {
  const lines: string[] = [
    `The human left ${items.length} unread canvas ask-back` +
      `${items.length === 1 ? "" : "s"} on the visual-chat canvas:`,
    "",
  ];
  for (const item of items) {
    const title = item.artifact_title ?? item.anchor.artifact_id;
    const where =
      item.anchor.block_index === null
        ? `${title} (v${item.anchor.version}, whole artifact)`
        : `${title} (v${item.anchor.version}, block ${item.anchor.block_index})`;
    if (item.kind === "approval") {
      lines.push(`- Approved: ${where}`);
    } else {
      lines.push(`- On ${where}, re: “${item.quote}”: ${item.question}`);
    }
  }
  lines.push("");
  lines.push(
    "Call the check_askbacks tool to acknowledge these (it marks them " +
      "delivered), then answer each using its anchor's context.",
  );
  return lines.join("\n");
}

async function fetchPending(
  port: string,
  token: string,
): Promise<PendingItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/askbacks/pending`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { askbacks?: PendingItem[] };
    return body.askbacks ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId();
  } catch {
    return; // cwd unresolvable — nothing to do
  }

  const dir = join(homedir(), ".visual-chat", workspaceId);
  const portPath = join(dir, "port");
  const tokenPath = join(dir, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) return;

  let port: string;
  let token: string;
  try {
    port = readFileSync(portPath, "utf8").trim();
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return;
  }
  if (!port || !token) return;

  let items: PendingItem[];
  try {
    items = await fetchPending(port, token);
  } catch {
    return; // server down or timed out — stay silent, exit 0
  }
  if (items.length === 0) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatPending(items),
      },
    }),
  );
}

void main();
