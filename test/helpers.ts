// Shared test plumbing: raw HTTP client (full header control, e.g. Host
// spoofing) and a spawned Canvas Server driven over real stdio MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const serverEntry = join(repoRoot, "src", "server", "index.ts");

export interface HttpResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** Raw node:http request — lets tests set forbidden headers like Host. */
export function httpRequest(opts: {
  port: number;
  path: string;
  host?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: opts.headers,
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Build dist/canvas once if missing (GET / serves the built canvas). */
export function ensureCanvasBuilt(): void {
  if (existsSync(join(repoRoot, "dist", "canvas", "index.html"))) return;
  const result = spawnSync(
    "bun",
    ["x", "vite", "build", "--config", "src/canvas/vite.config.ts"],
    { cwd: repoRoot, stdio: "ignore" },
  );
  if (result.status !== 0) throw new Error("vite build failed in test setup");
}

export interface SpawnedServer {
  client: Client;
  home: string;
  stateDir: string;
  workspaceId: string;
  port: number;
  /** Reads the current on-disk token (rotate-aware). */
  token(): string;
  close(): Promise<void>;
}

/** Spawn the Canvas Server as a real subprocess with an isolated HOME. */
export async function spawnServer(
  opts: { env?: Record<string, string> } = {},
): Promise<SpawnedServer> {
  const home = mkdtempSync(join(tmpdir(), "visual-chat-test-"));
  const transport = new StdioClientTransport({
    command: "bun",
    args: [serverEntry],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      VISUAL_CHAT_NO_OPEN: "1",
      ...opts.env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "visual-chat-tests", version: "0.0.0" });
  await client.connect(transport);

  const wsRoot = join(home, ".visual-chat");
  const workspaceId = readdirSync(wsRoot)[0]!;
  const stateDir = join(wsRoot, workspaceId);
  const port = Number(readFileSync(join(stateDir, "port"), "utf8"));

  return {
    client,
    home,
    stateDir,
    workspaceId,
    port,
    token: () => readFileSync(join(stateDir, "token"), "utf8").trim(),
    close: async () => {
      await client.close();
    },
  };
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Extract the JSON payload of a tool result's first text content block. */
export function toolJson(result: unknown): Record<string, unknown> {
  const r = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
