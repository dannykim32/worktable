// Free-form HTML hatch — PARENT side (issue 25). This is the host-canvas half of
// the security boundary; the model's HTML never touches this DOM. We render only
// a sandboxed <iframe> whose `src` points at the SECOND (frame-origin) server,
// and we wire the MessageChannel bridge.
//
// Structural invariants (test-enforced, not aspirational):
//  · sandbox="allow-scripts" with NO allow-same-origin — a documented total
//    escape; its absence must be structural, so we set the attribute to the
//    exact string and never add same-origin.
//  · The frame's opaque origin serializes as "null", so event.origin is useless
//    (issue 15). Identity is `event.source === iframe.contentWindow`; the port
//    is transferred ONLY after that check passes, and all verbs then travel the
//    private MessageChannel port.
//  · The capability token NEVER crosses the bridge — the parent re-POSTs a
//    schema-validated ask-back through the existing /api/askbacks door
//    (ADR-0010). The only message the parent ever sends the frame is {v:"port"}.
import type { Anchor } from "../../shared/artifacts.js";
import { QUESTION_MAX, QUOTE_MAX } from "../../shared/constraints.js";
import type { CanvasApi } from "../api.js";

/** Clamp a frame-reported height to a sane range (parent is the final word). */
function clampHeight(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.max(80, Math.min(20000, Math.floor(px)));
}

export interface HtmlBridgeDeps {
  iframe: HTMLIFrameElement;
  api: Pick<CanvasApi, "postAskback">;
  artifactId: string;
  version: number;
  /** Called with the frame's reported content height (already clamped). */
  onResize?: (px: number) => void;
  /** Called after an ask-back from the frame is accepted, so its eventual
   *  answer can thread back onto the card (issue 22 whole-artifact path). */
  onAskbackSubmitted?: (id: string, anchor: Anchor, question: string) => void;
}

/**
 * The parent side of the frame bridge. Owns one MessageChannel; transfers a port
 * to the frame ONLY after an identity-checked "ready" handshake; then processes a
 * CLOSED, schema-validated verb set from the frame over the private port.
 */
export class HtmlBridge {
  private readonly channel: MessageChannel;
  private transferred = false;
  private disposed = false;

  constructor(private readonly deps: HtmlBridgeDeps) {
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = (e: MessageEvent) =>
      this.handleFrameMessage(e.data);
  }

  /** Begin listening for the frame's identity-checked handshake. */
  start(): void {
    this.deps.iframe.ownerDocument.defaultView?.addEventListener(
      "message",
      this.onWindowMessage,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.deps.iframe.ownerDocument.defaultView?.removeEventListener(
      "message",
      this.onWindowMessage,
    );
    try {
      this.channel.port1.onmessage = null;
      this.channel.port1.close();
    } catch {
      /* no-op */
    }
  }

  /** Identity gate: a window message is trusted ONLY when it originates from our
   *  own iframe's content window. The frame's opaque origin is "null", so
   *  event.origin cannot be used — event.source is the identity (issue 15). */
  acceptsSource(source: MessageEventSource | null): boolean {
    return source !== null && source === this.deps.iframe.contentWindow;
  }

  /** Window 'message' handler: on the frame's identity-verified "ready", transfer
   *  the channel port to it (targetOrigin "*" — opaque origin) exactly once. */
  private readonly onWindowMessage = (e: MessageEvent): void => {
    if (this.disposed || this.transferred) return;
    if (!this.acceptsSource(e.source)) return; // identity mismatch → ignore
    const data = e.data as { v?: unknown } | null;
    if (!data || data.v !== "ready") return;
    const win = this.deps.iframe.contentWindow;
    if (!win) return;
    // The ONLY message the parent sends the frame — carries no token, only the
    // transferred port.
    win.postMessage({ v: "port" }, "*", [this.channel.port2]);
    this.transferred = true;
  };

  /** Process one verb from the frame (over the private port). Closed set:
   *  {v:"resize",px} and {v:"askback",quote,question}; anything else is dropped.
   *  Exposed for direct unit testing. */
  handleFrameMessage(data: unknown): void {
    if (this.disposed) return;
    if (!data || typeof data !== "object") return;
    const verb = data as { v?: unknown; px?: unknown; quote?: unknown; question?: unknown };

    if (verb.v === "resize") {
      if (typeof verb.px === "number" && Number.isFinite(verb.px)) {
        this.deps.onResize?.(clampHeight(verb.px));
      }
      return;
    }

    if (verb.v === "askback") {
      if (typeof verb.quote !== "string" || typeof verb.question !== "string") {
        return;
      }
      const quote = verb.quote.trim().slice(0, QUOTE_MAX);
      const question = verb.question.trim().slice(0, QUESTION_MAX);
      if (quote === "" || question === "") return;
      // block_index is null: the frame is opaque, there are no host-DOM block
      // indices — so this is a whole-artifact anchor, and the agent's reply
      // mounts on the card (replies.ts whole-artifact path).
      const anchor: Anchor = {
        artifact_id: this.deps.artifactId,
        version: this.deps.version,
        block_index: null,
        quote,
      };
      void this.deps.api
        .postAskback({ anchor, question })
        .then((res) => {
          if (res && this.deps.onAskbackSubmitted) {
            this.deps.onAskbackSubmitted(res.id, anchor, question);
          }
        })
        .catch(() => {
          /* surfaced elsewhere; never throw out of the bridge */
        });
      return;
    }
    // Unknown verb → dropped.
  }
}

export interface HtmlCardDeps {
  api: Pick<CanvasApi, "postAskback">;
  frameOrigin: string;
  frameSlug: string;
  artifactId: string;
  version: number;
  title: string;
  onAskbackSubmitted?: (id: string, anchor: Anchor, question: string) => void;
}

/** Build the sandboxed iframe card body + its bridge. Returns a disposer the
 *  gallery calls before re-rendering (scrub/update) to drop window listeners. */
export function renderHtmlCard(
  mount: HTMLElement,
  deps: HtmlCardDeps,
): { dispose(): void } {
  const doc = mount.ownerDocument;
  mount.classList.add("html-body");

  const iframe = doc.createElement("iframe");
  // allow-scripts ONLY: allow-same-origin is a documented total sandbox escape
  // and must be structurally absent (issue 15).
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("loading", "lazy");
  iframe.title = deps.title;
  iframe.className = "html-frame";
  iframe.src = `${deps.frameOrigin}/f/${deps.frameSlug}`;
  mount.appendChild(iframe);

  const caption = doc.createElement("p");
  caption.className = "html-caption";
  caption.textContent =
    "Model-authored HTML, shown isolated in a locked-down sandbox — no network, " +
    "no scripts of its own. Select text inside it to ask about it.";
  mount.appendChild(caption);

  const bridge = new HtmlBridge({
    iframe,
    api: deps.api,
    artifactId: deps.artifactId,
    version: deps.version,
    onResize: (px) => {
      iframe.style.height = `${px}px`;
    },
    onAskbackSubmitted: deps.onAskbackSubmitted,
  });
  bridge.start();
  return { dispose: () => bridge.dispose() };
}
