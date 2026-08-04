// The frame-origin server (issue 25): a SECOND 127.0.0.1 listener, on a port
// range DISJOINT from the canvas server, that serves ONLY html-artifact
// documents at token-free `/f/<slug>` routes. This is the real origin split the
// security model mandates (issue 15 pre-decision 3): the model's HTML lives on a
// different origin from the canvas, so it can never reach the capability token
// (which is in the canvas origin's JS).
//
// Gating: the route is guarded ONLY by an unguessable 128-bit frame slug — never
// a capability token (a token inside compromised frame content would itself be a
// leak vector). Same 127.0.0.1 bind + Host allowlist as the canvas server
// (DNS-rebinding defense reused, not reinvented).
//
// The strict CSP is delivered as an HTTP HEADER (a <meta> CSP cannot deliver
// sandbox/frame-ancestors — issue 15), with a fresh per-response nonce so only
// the trusted capture prelude runs and every model <script>/onclick is inert.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bindFirstFreePort, hostAllowed } from "./http.js";
import type { FrameRegistry } from "./frames.js";
import { buildFrameDocument } from "./frameShell.js";
import type { ArtifactStore } from "./store.js";

export const FRAME_PORT_SCAN_START = 8888;
export const FRAME_PORT_SCAN_END = 8988;

/** The exact frame CSP (issue 25). `frame-ancestors` names the CANVAS origin so
 *  the sole legitimate embedder (the canvas, a DIFFERENT origin under the
 *  mandated origin split) can frame it and nothing else can. See the deviation
 *  note: the literal spec said `'self'`, which — because the frame and canvas
 *  are different origins by design — would block the canvas itself. */
export function frameCsp(nonce: string, canvasOrigin: string): string {
  return (
    "default-src 'none'; " +
    `script-src 'nonce-${nonce}'; ` +
    "style-src 'unsafe-inline'; " +
    "img-src data:; " +
    "font-src data:; " +
    "connect-src 'none'; " +
    "form-action 'none'; " +
    "base-uri 'none'; " +
    `frame-ancestors ${canvasOrigin}`
  );
}

export interface FrameHttpDeps {
  store: ArtifactStore;
  frames: FrameRegistry;
  /** The canvas origin, resolved after the canvas server binds (getter so the
   *  frame CSP's `frame-ancestors` can name it). */
  canvasOrigin: () => string;
}

export interface RunningFrameServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

const FRAME_ROUTE = /^\/f\/([0-9a-f]{32})$/;

/** Bind the frame-origin server on 127.0.0.1 in [8888, 8988]. */
export async function startFrameHttpServer(
  deps: FrameHttpDeps,
): Promise<RunningFrameServer> {
  let boundPort = -1;

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error(`visual-chat: frame handler error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("internal error");
    }
  });

  function baseHeaders(res: ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
  }

  function notFound(res: ServerResponse): void {
    baseHeaders(res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    baseHeaders(res);

    // 1. Host allowlist (DNS-rebinding defense) — same as the canvas server.
    if (!hostAllowed(req.headers.host, boundPort)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden host");
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const match = FRAME_ROUTE.exec(url.pathname);
    if (!match) {
      notFound(res);
      return;
    }

    // 2. Slug gate — the ONLY authorization here (no token by design).
    const target = deps.frames.resolve(match[1]!);
    if (!target) {
      notFound(res);
      return;
    }
    const content = deps.store.getVersion(target.artifactId, target.version);
    if (!content || content.type !== "html" || typeof content.html !== "string") {
      notFound(res);
      return;
    }

    // 3. Serve the shell: fresh 128-bit nonce, header-delivered CSP, verbatim
    //    (markup-stripped) model HTML.
    const nonce = randomBytes(16).toString("base64");
    const doc = buildFrameDocument(content.html, nonce);
    res.setHeader(
      "Content-Security-Policy",
      frameCsp(nonce, deps.canvasOrigin()),
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(doc),
    });
    res.end(doc);
  }

  boundPort = await bindFirstFreePort(
    server,
    FRAME_PORT_SCAN_START,
    FRAME_PORT_SCAN_END,
  );
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
