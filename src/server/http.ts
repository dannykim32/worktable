// The Canvas Server's browser-facing HTTP surface (ADR-0003, ADR-0005).
// 127.0.0.1 bind, Host allowlist, capability-token auth on every route,
// security headers (incl. CSP) on every response.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Workspace } from "./workspace.js";

export const PORT_SCAN_START = 8787;
export const PORT_SCAN_END = 8887;

const CSP =
  "default-src 'self'; img-src 'self' data:; script-src 'self'; " +
  "connect-src 'self'; style-src 'self' 'unsafe-inline'";

/** Host allowlist (DNS-rebinding defense): 127.0.0.1[:port] or localhost[:port]. */
export function hostAllowed(
  hostHeader: string | undefined,
  boundPort: number,
): boolean {
  if (!hostHeader) return false;
  const match = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(hostHeader);
  if (!match) return false;
  return match[2] === undefined || Number(match[2]) === boundPort;
}

/** Rewrite built canvas asset URLs to carry the capability token: subresource
 *  requests fired by the HTML parser cannot attach a bearer header. Scoped to
 *  Vite's /assets/ output only; preserves any existing query string. */
export function injectTokenIntoCanvasHtml(html: string, token: string): string {
  return html.replace(
    /(src|href)="(\/assets\/[^"]*)"/g,
    (_match, attr: string, assetPath: string) =>
      `${attr}="${assetPath}${assetPath.includes("?") ? "&" : "?"}token=${token}"`,
  );
}

/** Constant-time token comparison (hash both sides to erase length signal). */
export function tokensEqual(candidate: string, actual: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

const BODY_LIMIT_BYTES = 64 * 1024;

/** Read and parse a JSON request body (bounded). Throws on malformed input. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export interface ApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export interface ApiRoute {
  method: string;
  /** Path template, e.g. "/api/artifacts/:id/v/:n". */
  template: string;
  handler: (ctx: ApiContext) => void | Promise<void>;
}

function matchTemplate(
  template: string,
  pathname: string,
): Record<string, string> | null {
  const tParts = template.split("/");
  const pParts = pathname.split("/");
  if (tParts.length !== pParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tParts.length; i++) {
    const t = tParts[i]!;
    const p = pParts[i]!;
    if (t.startsWith(":")) {
      if (p === "") return null;
      params[t.slice(1)] = decodeURIComponent(p);
    } else if (t !== p) {
      return null;
    }
  }
  return params;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

export interface CanvasHttpDeps {
  workspace: Workspace;
  version: string;
  /** dist/canvas — the built Canvas the browser loads. */
  canvasDistDir: string;
  /** Extra bearer-authed routes (artifacts in 03, ask-backs in 05). */
  apiRoutes?: ApiRoute[];
}

export interface RunningHttpServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Bind 127.0.0.1 on the first free port in [8787, 8887].
 * Middleware order: Host allowlist (403) → capability auth (401) → route.
 */
export async function startCanvasHttpServer(
  deps: CanvasHttpDeps,
): Promise<RunningHttpServer> {
  let boundPort = -1;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error(`visual-chat: request handler error: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Security headers on every response, including errors.
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    // 1. Host allowlist.
    if (!hostAllowed(req.headers.host, boundPort)) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);

    // 2. Capability auth (ADR-0005: every browser-facing endpoint).
    // The tokened URL (`?token=`) opens the page; page JS holds the token in
    // memory and sends `Authorization: Bearer` for all /api requests. Canvas
    // static subresources also accept `?token=` — CSP `script-src 'self'`
    // forbids inline scripts, and a <script src> cannot carry a bearer header.
    const bearer = bearerToken(req);
    const queryToken = url.searchParams.get("token");
    const bearerOk = bearer !== null && tokensEqual(bearer, deps.workspace.token);
    const queryOk =
      queryToken !== null && tokensEqual(queryToken, deps.workspace.token);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const authed = isApi ? bearerOk : bearerOk || queryOk;
    if (!authed) {
      sendJson(res, 401, { error: "missing or invalid capability token" });
      return;
    }

    // 3. Routes.
    if (isApi) {
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          workspaceId: deps.workspace.id,
          version: deps.version,
        });
        return;
      }
      for (const route of deps.apiRoutes ?? []) {
        if (route.method !== req.method) continue;
        const params = matchTemplate(route.template, url.pathname);
        if (params === null) continue;
        await route.handler({ req, res, url, params });
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    serveCanvasStatic(deps, url.pathname, res);
  }

  function serveCanvasStatic(
    d: CanvasHttpDeps,
    pathname: string,
    res: ServerResponse,
  ): void {
    if (pathname === "/") {
      const indexPath = join(d.canvasDistDir, "index.html");
      if (!existsSync(indexPath)) {
        sendJson(res, 503, {
          error: "canvas not built — run `bun run build` first",
        });
        return;
      }
      const html = injectTokenIntoCanvasHtml(
        readFileSync(indexPath, "utf8"),
        d.workspace.token,
      );
      res.writeHead(200, {
        "Content-Type": MIME[".html"]!,
        "Content-Length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    const root = resolve(d.canvasDistDir);
    const filePath = resolve(join(root, normalize(pathname)));
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": body.byteLength,
    });
    res.end(body);
  }

  function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/.exec(header);
    return match ? match[1]! : null;
  }

  boundPort = await bindFirstFreePort(server);
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

async function bindFirstFreePort(server: http.Server): Promise<number> {
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port++) {
    const bound = await new Promise<boolean>((resolveBind, rejectBind) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") resolveBind(false);
        else rejectBind(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolveBind(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (bound) return port;
  }
  throw new Error(
    `no free port between ${PORT_SCAN_START} and ${PORT_SCAN_END}`,
  );
}
