// Canvas boot: token from the capability URL (kept in JS memory), header
// chrome, artifact gallery, SSE live updates.
import "./styles.css";
import { connectEvents, createApi } from "./api.js";
import { Gallery } from "./gallery.js";
import type { ArtifactEvent } from "../shared/artifacts.js";

function boot(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    const err = document.createElement("p");
    err.className = "canvas-error";
    err.textContent =
      "Missing capability token. Open the canvas via the URL the agent " +
      "printed (open_canvas), which carries ?token=…";
    app.appendChild(err);
    return;
  }

  const api = createApi(token);

  // Header chrome: title, workspace id, connection dot.
  const header = document.createElement("header");
  header.className = "canvas-chrome";
  const h1 = document.createElement("h1");
  h1.textContent = "Visual Chat — Canvas";
  const ws = document.createElement("span");
  ws.className = "ws";
  const live = document.createElement("span");
  live.className = "live";
  const dot = document.createElement("span");
  dot.className = "dot";
  const liveLabel = document.createElement("span");
  liveLabel.textContent = "connecting…";
  live.append(dot, liveLabel);
  header.append(h1, ws, live);

  const galleryRoot = document.createElement("main");
  galleryRoot.id = "gallery";
  app.append(header, galleryRoot);

  void api
    .health()
    .then((h) => {
      ws.textContent = `workspace: ${h.workspaceId}`;
    })
    .catch(() => {
      ws.textContent = "workspace: unavailable";
    });

  const gallery = new Gallery(galleryRoot, api);
  void gallery.init().catch((err: unknown) => {
    const note = document.createElement("p");
    note.className = "canvas-error";
    note.textContent = `Could not load artifacts: ${String(err)}`;
    galleryRoot.appendChild(note);
  });

  connectEvents(token, {
    onEvent: (event, data) => {
      if (event === "artifact") {
        void gallery.handleArtifactEvent(data as ArtifactEvent);
      }
    },
    onState: (connected) => {
      dot.className = connected ? "dot connected" : "dot";
      liveLabel.textContent = connected ? "agent connected" : "reconnecting…";
    },
  });
}

boot();
