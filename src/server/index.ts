// Canvas Server entry: one MCP stdio server that owns the local HTTP canvas
// service (ADR-0003). Log to stderr only — stdout is the MCP transport.
import { fileURLToPath } from "node:url";
import type { ArtifactEvent } from "../shared/artifacts.js";
import {
  AskbackQueue,
  AskbackValidationError,
  validateAskbackBody,
} from "./askbacks.js";
import {
  readJsonBody,
  sendJson,
  startCanvasHttpServer,
  type ApiRoute,
} from "./http.js";
import { connectStdio, createMcpServer, ToolInputError, type ToolSpec } from "./mcp.js";
import { openInBrowser } from "./open.js";
import { SseHub } from "./sse.js";
import {
  ArtifactStore,
  ArtifactTypeMismatchError,
  UnknownArtifactError,
} from "./store.js";
import {
  publishArtifactSchema,
  updateArtifactSchema,
  validateArtifactContent,
  validateUpdateInput,
  ValidationError,
} from "./validate.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { openWorkspace } from "./workspace.js";

async function main(): Promise<void> {
  const workspace = openWorkspace();
  const canvasDistDir = fileURLToPath(
    new URL("../../dist/canvas", import.meta.url),
  );

  const store = new ArtifactStore(workspace.dir);
  const sse = new SseHub();
  const askbacks = new AskbackQueue(workspace.dir);

  const apiRoutes: ApiRoute[] = [
    {
      method: "GET",
      template: "/api/artifacts",
      handler: ({ res }) => sendJson(res, 200, store.list()),
    },
    {
      method: "GET",
      template: "/api/artifacts/:id",
      handler: ({ res, params }) => {
        const meta = store.getMeta(params.id!);
        const content = meta && store.getVersion(meta.id, meta.latest);
        if (!meta || !content) {
          sendJson(res, 404, { error: "unknown artifact" });
          return;
        }
        sendJson(res, 200, { ...meta, content });
      },
    },
    {
      method: "GET",
      template: "/api/artifacts/:id/v/:n",
      handler: ({ res, params }) => {
        const content = store.getVersion(params.id!, Number(params.n));
        if (!content) {
          sendJson(res, 404, { error: "unknown artifact or version" });
          return;
        }
        sendJson(res, 200, content);
      },
    },
    {
      method: "GET",
      template: "/api/events",
      handler: ({ res }) => sse.attach(res),
    },
    {
      method: "POST",
      template: "/api/askbacks",
      handler: async ({ req, res }) => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String((err as Error).message) });
          return;
        }
        try {
          const validated = validateAskbackBody(body);
          const askback = askbacks.append(validated);
          sendJson(res, 201, { id: askback.id, state: askback.state });
        } catch (err) {
          if (err instanceof AskbackValidationError) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
  ];

  const running = await startCanvasHttpServer({
    workspace,
    version: SERVER_VERSION,
    canvasDistDir,
    apiRoutes,
  });
  workspace.recordPort(running.port);

  const canvasUrl = () =>
    `http://127.0.0.1:${running.port}/?token=${workspace.token}`;

  let hasAutoOpened = false;
  const announce = (event: ArtifactEvent) => {
    sse.broadcast("artifact", event);
    if (!hasAutoOpened) {
      hasAutoOpened = true;
      openInBrowser(canvasUrl()); // no-op under VISUAL_CHAT_NO_OPEN=1
    }
  };

  const mapErrors = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof UnknownArtifactError ||
        err instanceof ArtifactTypeMismatchError
      ) {
        throw new ToolInputError(err.message);
      }
      throw err;
    }
  };

  const tools: ToolSpec[] = [
    {
      name: "publish_artifact",
      description:
        "Publish a new visual artifact to the canvas. Component Artifacts are " +
        "structured data drawn by the trusted Component Vocabulary. Use type " +
        '"absence" to decline honestly (with the reason) instead of fabricating.',
      inputSchema: publishArtifactSchema as Record<string, unknown>,
      handler: (args) =>
        mapErrors(() => {
          const content = validateArtifactContent(args);
          const meta = store.publish(content);
          announce({ artifact_id: meta.id, version: 1, type: meta.type });
          return { artifact_id: meta.id, version: 1, url: canvasUrl() };
        }),
    },
    {
      name: "update_artifact",
      description:
        "Replace an existing artifact's content in place. The artifact keeps " +
        "its identity; every prior version stays viewable, and ask-back anchors " +
        "bind to the version the human was reading.",
      inputSchema: updateArtifactSchema as Record<string, unknown>,
      handler: (args) =>
        mapErrors(() => {
          const { artifactId, content } = validateUpdateInput(args);
          // Type stability is enforced by the store itself (ADR-0006);
          // ArtifactTypeMismatchError surfaces as a friendly tool error.
          const meta = store.update(artifactId, content);
          announce({
            artifact_id: meta.id,
            version: meta.latest,
            type: meta.type,
          });
          return { artifact_id: meta.id, version: meta.latest };
        }),
    },
    {
      name: "check_askbacks",
      description:
        "Pull the pending ask-backs the human sent from the canvas: each is a " +
        "question anchored to an artifact, version, and text span. Call this " +
        "at the start of every turn. Returned items are marked delivered.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        const drained = askbacks.drainPending();
        if (drained.length === 0) {
          return {
            askbacks: [],
            hint: "no pending questions from the canvas",
          };
        }
        return {
          askbacks: drained.map((a) => ({
            id: a.id,
            question: a.question,
            quote: a.anchor.quote,
            anchor: a.anchor,
            artifact_title: store.getMeta(a.anchor.artifact_id)?.title ?? null,
            created_at: a.created_at,
          })),
        };
      },
    },
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
    sse.close();
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
