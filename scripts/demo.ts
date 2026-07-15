// Walking-skeleton demo (issue 06): speaks MCP over stdio to a spawned
// Canvas Server. Publishes a six-block document, updates it to v2, prints
// the canvas URL, then polls check_askbacks every 2s and prints anything
// the human sends from the browser. Exits 0 on Ctrl+C or after the poll
// window (VISUAL_CHAT_DEMO_TIMEOUT_MS, default 120000).
//
// Run: bun scripts/demo.ts   (build first: bun run build)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distEntry = join(repoRoot, "dist", "server", "index.js");
const POLL_MS = 2000;
const TIMEOUT_MS = Number(process.env.VISUAL_CHAT_DEMO_TIMEOUT_MS ?? 120_000);

function toolJson(result: unknown): Record<string, unknown> {
  const r = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const useDist = existsSync(distEntry);
  const transport = new StdioClientTransport({
    command: useDist ? "node" : "bun",
    args: [useDist ? distEntry : join(repoRoot, "src", "server", "index.ts")],
    cwd: repoRoot,
    env: process.env as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "visual-chat-demo", version: "0.1.0" });
  await client.connect(transport);

  const published = toolJson(
    await client.callTool({
      name: "publish_artifact",
      arguments: {
        type: "document",
        title: "Walking skeleton: the full loop, demonstrated",
        blocks: [
          { kind: "heading", level: 1, text: "What you are looking at" },
          {
            kind: "paragraph",
            text:
              "This document was published from a terminal process over MCP. " +
              "Select any sentence in this paragraph to send an anchored " +
              "ask-back home to that process.",
          },
          {
            kind: "callout",
            tone: "info",
            text:
              "Honest absence doctrine: what cannot be rendered truthfully " +
              "is declined with a reason, never fabricated.",
          },
          {
            kind: "code",
            lang: "json",
            text: '{ "tool": "publish_artifact", "arguments": { "type": "document" } }',
          },
          {
            kind: "table",
            header: ["Flow", "Channel"],
            rows: [
              ["agent → canvas", "publish_artifact / update_artifact + SSE"],
              ["canvas → agent", "ask-back queue, pulled via check_askbacks"],
            ],
          },
          {
            kind: "list",
            ordered: true,
            items: [
              "publish (v1)",
              "update in place (v2, v1 retained)",
              "select text in the browser and ask",
              "watch this terminal print your question",
            ],
          },
        ],
      },
    }),
  );
  const artifactId = published.artifact_id as string;
  console.log(`published ${artifactId} v1`);

  const updated = toolJson(
    await client.callTool({
      name: "update_artifact",
      arguments: {
        artifact_id: artifactId,
        type: "document",
        title: "Walking skeleton: the full loop, demonstrated (v2)",
        blocks: [
          { kind: "heading", level: 1, text: "What you are looking at (updated)" },
          {
            kind: "paragraph",
            text:
              "Same artifact, new version — scrub back with ‹ to see v1 and " +
              "the viewing marker. Select any sentence to send an anchored " +
              "ask-back home to this terminal.",
          },
          {
            kind: "callout",
            tone: "warn",
            text: "Ask-backs pin the version you were reading when you asked.",
          },
          {
            kind: "code",
            lang: "json",
            text: '{ "tool": "update_artifact", "arguments": { "artifact_id": "' + artifactId + '" } }',
          },
          {
            kind: "table",
            header: ["Version", "State"],
            rows: [
              ["v1", "retained, viewable via the scrubber"],
              ["v2", "live"],
            ],
          },
          {
            kind: "list",
            ordered: true,
            items: ["you are here", "now ask something from the browser"],
          },
        ],
      },
    }),
  );
  console.log(`updated ${artifactId} to v${updated.version as number}`);

  const opened = toolJson(
    await client.callTool({ name: "open_canvas", arguments: {} }),
  );
  console.log(`canvas: ${opened.url as string}`);
  console.log(
    `polling check_askbacks every ${POLL_MS / 1000}s for up to ` +
      `${Math.round(TIMEOUT_MS / 1000)}s — ask something from the browser ` +
      "(Ctrl+C to stop)…",
  );

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (!stopping && Date.now() < deadline) {
    const result = toolJson(
      await client.callTool({ name: "check_askbacks", arguments: {} }),
    ) as { askbacks: Array<Record<string, unknown>> };
    for (const askback of result.askbacks) {
      console.log("ask-back received:");
      console.log(JSON.stringify(askback, null, 2));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await client.close();
  console.log("demo done.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`demo failed: ${String(err)}`);
  process.exit(1);
});
