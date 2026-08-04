// Canvas boot: token from the capability URL (kept in JS memory), header
// chrome, artifact gallery, SSE live updates.
import "./styles.css";
import { connectEvents, createApi } from "./api.js";
import { AskbackUi, wholeArtifactAnchor } from "./askback.js";
import { Gallery } from "./gallery.js";
import { ReplyThreads } from "./replies.js";
import type {
  ArtifactEvent,
  AskbackAnsweredEvent,
} from "../shared/artifacts.js";

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

  // Inline canvas answers (issue 22): threads the agent's replies to ask-backs
  // back under the anchored selection.
  const replies = new ReplyThreads(document, galleryRoot, api);

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
    // html hatch (issue 25): an ask-back raised from inside a sandboxed frame
    // was accepted — track it so the agent's reply threads back onto the card.
    onAskbackSubmitted: (id, anchor, question) =>
      replies.track(id, anchor, question),
  });
  const askbackUi = new AskbackUi(document, {
    api,
    gallery,
    onSubmitted: (id, anchor, question) => replies.track(id, anchor, question),
  });
  void gallery
    .init()
    .then(() => replies.loadAnswered())
    .catch((err: unknown) => {
      const note = document.createElement("p");
      note.className = "canvas-error";
      note.textContent = `Could not load artifacts: ${String(err)}`;
      galleryRoot.appendChild(note);
    });

  connectEvents(token, {
    onEvent: (event, data) => {
      if (event === "artifact") {
        void gallery
          .handleArtifactEvent(data as ArtifactEvent)
          // A card re-render wipes body-mounted threads; re-attach them.
          .then(() => replies.render());
      } else if (event === "askback_answered") {
        void replies.handleAnswered(data as AskbackAnsweredEvent);
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
