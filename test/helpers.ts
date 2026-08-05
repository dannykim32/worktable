// Shared test plumbing: raw HTTP client (full header control, e.g. Host
// spoofing) and a spawned Canvas Server driven over real stdio MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorkspaceId } from "../src/server/workspace.js";

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

/** Spawn the Canvas Server as a real subprocess with an isolated HOME.
 *  Pass `home` to reuse existing workspace state (restart scenarios). Pass
 *  `gate` to pre-seed `<stateDir>/config.json` BEFORE startup, since the gate
 *  mode is read once at boot (issue 12). */
export async function spawnServer(
  opts: {
    env?: Record<string, string>;
    home?: string;
    gate?: "report" | "enforce";
  } = {},
): Promise<SpawnedServer> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "purview-test-"));
  if (opts.gate) {
    // The workspace id derives from cwd (the repo root the server runs in), so
    // it is deterministic here — pre-create the state dir and drop config.json.
    const stateDir = join(home, ".purview", deriveWorkspaceId(repoRoot));
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ gate: opts.gate }, null, 2),
      { mode: 0o600 },
    );
  }
  const transport = new StdioClientTransport({
    command: "bun",
    args: [serverEntry],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      PURVIEW_NO_OPEN: "1",
      ...opts.env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "purview-tests", version: "0.0.0" });
  await client.connect(transport);

  const wsRoot = join(home, ".purview");
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

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface SseListener {
  frames: SseFrame[];
  /** Resolves with the first frame of this event matching the predicate
   *  (already-received or future). */
  waitFor(
    event: string,
    timeoutMs?: number,
    predicate?: (frame: SseFrame) => boolean,
  ): Promise<SseFrame>;
  close(): void;
}

/** Open a live /api/events stream (bearer-authed) and parse its frames. */
export function openSse(port: number, token: string): Promise<SseListener> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const waiters: Array<{
      event: string;
      predicate: (f: SseFrame) => boolean;
      resolve: (f: SseFrame) => void;
    }> = [];
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/events", headers: bearer(token) },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connect failed: ${res.statusCode}`));
          return;
        }
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "message";
            let data: unknown;
            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
            }
            if (raw.startsWith(":")) continue; // comment/heartbeat frame
            const frame = { event, data };
            frames.push(frame);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i]!.event === event && waiters[i]!.predicate(frame)) {
                waiters[i]!.resolve(frame);
                waiters.splice(i, 1);
              }
            }
          }
        });
        resolve({
          frames,
          waitFor: (event, timeoutMs = 3000, predicate = () => true) =>
            new Promise<SseFrame>((resolveWait, rejectWait) => {
              const existing = frames.find(
                (f) => f.event === event && predicate(f),
              );
              if (existing) {
                resolveWait(existing);
                return;
              }
              const timer = setTimeout(
                () => rejectWait(new Error(`no ${event} frame in ${timeoutMs}ms`)),
                timeoutMs,
              );
              waiters.push({
                event,
                predicate,
                resolve: (f) => {
                  clearTimeout(timer);
                  resolveWait(f);
                },
              });
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
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
