// Server-Sent Events hub: pushes artifact publish/update notifications to
// every connected canvas tab. One-way by design — the ask-back queue is the
// only browser→agent channel (ADR-0010).
import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 15_000;

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Connected canvas tabs. A live tab holds an SSE stream (EventSource
   *  auto-reconnects), so >0 is a solid "someone has the page open" signal. */
  get clientCount(): number {
    return this.clients.size;
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(":connected\n\n");
    this.clients.add(res);
    // Disconnect detection on BOTH the response and the raw socket: node fires
    // res 'close' on client disconnect; bun's http server (used when tests run
    // the server via `bun src/...`) fires only the socket/request close. The
    // delete is idempotent, so double-fire is harmless.
    const drop = () => this.clients.delete(res);
    res.once("close", drop);
    res.socket?.once("close", drop);
  }

  /** Send one event to a single attached client — for initial-state snapshots
   *  a late joiner would otherwise miss (e.g. the current `listening` state). */
  send(res: ServerResponse, event: string, data: unknown): void {
    if (!this.clients.has(res)) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
