// Canvas Server entry: one MCP stdio server that owns the local HTTP canvas
// service (ADR-0003). Log to stderr only — stdout is the MCP transport.
import { fileURLToPath } from "node:url";
import { startCanvasHttpServer } from "./http.js";
import { connectStdio, createMcpServer, type ToolSpec } from "./mcp.js";
import { openInBrowser } from "./open.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { openWorkspace } from "./workspace.js";

async function main(): Promise<void> {
  const workspace = openWorkspace();
  const canvasDistDir = fileURLToPath(
    new URL("../../dist/canvas", import.meta.url),
  );

  const running = await startCanvasHttpServer({
    workspace,
    version: SERVER_VERSION,
    canvasDistDir,
  });
  workspace.recordPort(running.port);

  const canvasUrl = () =>
    `http://127.0.0.1:${running.port}/?token=${workspace.token}`;

  const tools: ToolSpec[] = [
    {
      name: "open_canvas",
      description:
        "Open the workspace's canvas page in the default browser and return " +
        "its capability URL.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        const url = canvasUrl();
        openInBrowser(url);
        return { url };
      },
    },
    {
      name: "rotate_token",
      description:
        "Regenerate this workspace's capability token. The old canvas URL and " +
        "any saved bearer stop working immediately.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        workspace.rotateToken();
        return { rotated: true, url: canvasUrl() };
      },
    },
  ];

  const mcp = createMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
  });

  const shutdown = async () => {
    await running.close().catch(() => {});
    process.exit(0);
  };
  // HTTP lifecycle is tied to the stdio transport: stdin closing means the
  // agent host is gone.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  mcp.onclose = () => void shutdown();

  await connectStdio(mcp);
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} — workspace ${workspace.id}, ` +
      `canvas on http://127.0.0.1:${running.port}`,
  );
}

main().catch((err: unknown) => {
  console.error(`visual-chat: fatal: ${String(err)}`);
  process.exit(1);
});
