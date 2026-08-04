// Canvas-side API client. The capability token arrives once in the page URL
// (ADR-0005) and lives in JS memory here; every /api request sends it as a
// bearer. SSE runs over fetch because EventSource cannot attach the bearer.
import type {
  Anchor,
  ArtifactContent,
  ArtifactMeta,
  AskbackAnswer,
} from "../shared/artifacts.js";

export interface ArtifactWithContent extends ArtifactMeta {
  content: ArtifactContent;
}

/** An answered ask-back as returned by GET /api/askbacks/answered (issue 22). */
export interface AnsweredAskback {
  id: string;
  anchor: Anchor;
  question: string;
  answer: AskbackAnswer;
}

export type GateMode = "report" | "enforce";
export type GateScope = "workspace" | "user";
export type GateSource = GateScope | "default";

/** The effective gate mode + where it was resolved from (issue 20). */
export interface GateSettings {
  gate: { effective: GateMode; source: GateSource };
}

export interface CanvasApi {
  health(): Promise<{
    workspaceId: string;
    version: string;
    /** The frame-serving origin for html artifacts (issue 25), or null. */
    frameOrigin: string | null;
  }>;
  listArtifacts(): Promise<ArtifactMeta[]>;
  getArtifact(id: string): Promise<ArtifactWithContent>;
  getVersion(id: string, version: number): Promise<ArtifactContent>;
  postAskback(body: {
    anchor: unknown;
    question: string;
    kind?: "question" | "approval";
  }): Promise<{ id: string; state: string }>;
  getAnsweredAskbacks(): Promise<AnsweredAskback[]>;
  getSettings(): Promise<GateSettings>;
  postSettings(body: { gate: GateMode; scope: GateScope }): Promise<GateSettings>;
}

export function createApi(token: string): CanvasApi {
  const headers = { Authorization: `Bearer ${token}` };
  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    health: () => getJson("/api/health"),
    listArtifacts: () => getJson("/api/artifacts"),
    getArtifact: (id) => getJson(`/api/artifacts/${encodeURIComponent(id)}`),
    getVersion: (id, version) =>
      getJson(`/api/artifacts/${encodeURIComponent(id)}/v/${version}`),
    postAskback: async (body) => {
      const res = await fetch("/api/askbacks", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/askbacks failed: ${res.status}`);
      return (await res.json()) as { id: string; state: string };
    },
    getAnsweredAskbacks: async () =>
      (await getJson<{ askbacks: AnsweredAskback[] }>("/api/askbacks/answered"))
        .askbacks,
    getSettings: () => getJson("/api/settings"),
    postSettings: async (body) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/settings failed: ${res.status}`);
      return (await res.json()) as GateSettings;
    },
  };
}

export interface EventStreamHandlers {
  onEvent: (event: string, data: unknown) => void;
  onState: (connected: boolean) => void;
}

/** Connect to /api/events with automatic reconnect. Returns a stop function. */
export function connectEvents(
  token: string,
  handlers: EventStreamHandlers,
): () => void {
  let stopped = false;

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        const res = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        handlers.onState(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.startsWith(":")) continue; // heartbeat
            let event = "message";
            let data: unknown;
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
            }
            handlers.onEvent(event, data);
          }
        }
      } catch {
        // fall through to reconnect
      }
      handlers.onState(false);
      if (!stopped) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  void run();
  return () => {
    stopped = true;
  };
}
