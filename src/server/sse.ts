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

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(":connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
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
