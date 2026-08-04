// Keep-alive canvas server (dev helper): the Canvas Server is an MCP stdio
// server, so it lives only while an MCP client holds its stdin open. This script
// connects a client and idles, keeping the browser canvas reachable for a while
// so a human can view/interact.
//
// Run: bun run build && bun scripts/serve.ts   (Ctrl+C to stop)
// Stays up for VISUAL_CHAT_SERVE_MINUTES (default 60), then exits cleanly.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distEntry = join(repoRoot, "dist", "server", "index.js");
const MINUTES = Number(process.env.VISUAL_CHAT_SERVE_MINUTES ?? 60);

function toolText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content[0]?.text ?? "";
}

async function main(): Promise<void> {
  const useDist = existsSync(distEntry);
  const transport = new StdioClientTransport({
    command: useDist ? "node" : "bun",
    args: [useDist ? distEntry : join(repoRoot, "src", "server", "index.ts")],
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), VISUAL_CHAT_NO_OPEN: "1" },
    stderr: "inherit",
  });
  const client = new Client({ name: "visual-chat-serve", version: "0.1.0" });
  await client.connect(transport);

  // open_canvas returns the tokened canvas URL (NO_OPEN suppresses the tab).
  const url = JSON.parse(toolText(await client.callTool({ name: "open_canvas", arguments: {} })));
  const canvasUrl: string = url.url ?? "";
  console.log(`\n  Canvas:       ${canvasUrl}`);
  console.log(`\n  Server up for ${MINUTES} min (Ctrl+C to stop sooner).\n`);

  await new Promise((resolve) => setTimeout(resolve, MINUTES * 60_000));
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
