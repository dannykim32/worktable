// Canvas boot: token from the capability URL (kept in JS memory), header
// chrome, artifact gallery, SSE live updates.
import "./styles.css";
import { connectEvents, createApi } from "./api.js";
import { AskbackUi, wholeArtifactAnchor } from "./askback.js";
import { Gallery } from "./gallery.js";
import { SettingsPanel } from "./settings.js";
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
  // Link to the authed legibility calibration gallery (issue 11). The token
  // rides the URL so the page can hold it in memory like this one does.
  const calLink = document.createElement("a");
  calLink.className = "cal-back";
  calLink.href = `/calibration?token=${encodeURIComponent(token)}`;
  calLink.textContent = "calibration gallery →";
  // Gate settings gear (issue 20): the human's live toggle for report/enforce.
  const settings = new SettingsPanel(document, api);
  header.append(h1, ws, live, calLink, settings.mount());
  void settings.load();

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

  const gallery: Gallery = new Gallery(galleryRoot, api, {
    onAskArtifact: (meta, viewing) => {
      askbackUi.openComposer(wholeArtifactAnchor(meta.id, viewing, meta.title));
    },
    // Review Moment approval (issue 14): travels the single ask-back channel
    // as a kind:"approval" item (ADR-0010) — no new browser→agent surface.
    onApproveReview: (meta, viewing) => {
      void api.postAskback({
        anchor: wholeArtifactAnchor(meta.id, viewing, meta.title),
        question: "",
        kind: "approval",
      });
    },
  });
  const askbackUi = new AskbackUi(document, { api, gallery });
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
      } else if (event === "review_requested") {
        gallery.showReviewBanner((data as { artifact_id: string }).artifact_id);
      } else if (event === "review_resolved") {
        gallery.clearReviewBanner((data as { artifact_id: string }).artifact_id);
      }
    },
    onState: (connected) => {
      dot.className = connected ? "dot connected" : "dot";
      liveLabel.textContent = connected ? "agent connected" : "reconnecting…";
    },
  });
}

boot();
