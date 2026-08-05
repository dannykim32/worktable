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
//    (ADR-0010). The messages the parent sends the frame are the one-time
//    {v:"port"} transfer and the closed {v:"focusMarker",markerId} verb (issue
//    27) — neither carries a token.
import { HREF_MAX, QUOTE_MAX } from "../../shared/constraints.js";
import type { CanvasApi } from "../api.js";

/** Clamp a frame-reported height to a sane range (parent is the final word). */
function clampHeight(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.max(80, Math.min(20000, Math.floor(px)));
}

export interface HtmlBridgeDeps {
  iframe: HTMLIFrameElement;
  artifactId: string;
  version: number;
  /** Called with the frame's reported content height (already clamped). */
  onResize?: (px: number) => void;
  /** Issue 27: the human clicked "Ask about this" inside the frame. The parent
   *  opens the drawer composer pre-filled with `quote`, tracking `markerId` so a
   *  later locate can drive `focusMarker` back into the frame. */
  onAskStart?: (quote: string, markerId: string) => void;
  /** Issue 27: the human clicked an in-frame marker. The parent highlights the
   *  matching drawer entry (marker → drawer locate). */
  onFocusEntry?: (markerId: string) => void;
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
  /** How many times the iframe has fired `load`. The WindowProxy identity
   *  (event.source === contentWindow) SURVIVES a navigation, so identity alone
   *  is not enough: a navigated frame could post {v:"ready"} and grab the port.
   *  The port is transferred ONLY during the FIRST load generation (issue 25
   *  security review, Finding 2). */
  private loadCount = 0;

  constructor(private readonly deps: HtmlBridgeDeps) {
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = (e: MessageEvent) =>
      this.handleFrameMessage(e.data);
  }

  /** Begin listening for the frame's identity-checked handshake. */
  start(): void {
    const view = this.deps.iframe.ownerDocument.defaultView;
    view?.addEventListener("message", this.onWindowMessage);
    this.deps.iframe.addEventListener("load", this.onFrameLoad);
  }

  dispose(): void {
    this.disposed = true;
    const view = this.deps.iframe.ownerDocument.defaultView;
    view?.removeEventListener("message", this.onWindowMessage);
    this.deps.iframe.removeEventListener("load", this.onFrameLoad);
    try {
      this.channel.port1.onmessage = null;
      this.channel.port1.close();
    } catch {
      /* no-op */
    }
  }

  private readonly onFrameLoad = (): void => {
    this.loadCount++;
  };

  /** True once the frame has navigated (fired more than one load). */
  hasNavigated(): boolean {
    return this.loadCount >= 2;
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
    // Refuse to hand the port to a navigated frame: the WindowProxy identity
    // survives navigation, so a document loaded AFTER the first (our trusted
    // frame document) must never receive the bridge port (Finding 2).
    if (this.hasNavigated()) return;
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

  /** Process one verb from the frame (over the private port). CLOSED set:
   *  {v:"resize",px}, {v:"askstart",quote,markerId}, {v:"focusEntry",markerId},
   *  {v:"openlink",href}; anything else is dropped. Exposed for direct unit
   *  testing. */
  handleFrameMessage(data: unknown): void {
    if (this.disposed) return;
    if (!data || typeof data !== "object") return;
    const verb = data as {
      v?: unknown;
      px?: unknown;
      quote?: unknown;
      markerId?: unknown;
      href?: unknown;
    };

    if (verb.v === "resize") {
      if (typeof verb.px === "number" && Number.isFinite(verb.px)) {
        this.deps.onResize?.(clampHeight(verb.px));
      }
      return;
    }

    if (verb.v === "askstart") {
      // The human started a question inside the frame. The composer lives in the
      // parent drawer now; only the quote + the frame-assigned markerId cross —
      // NO question text, NO token. The question is typed + POSTed host-side.
      if (typeof verb.quote !== "string" || typeof verb.markerId !== "string") {
        return;
      }
      const quote = verb.quote.trim().slice(0, QUOTE_MAX);
      const markerId = verb.markerId.slice(0, 64);
      if (quote === "" || markerId === "") return;
      this.deps.onAskStart?.(quote, markerId);
      return;
    }

    if (verb.v === "focusEntry") {
      if (typeof verb.markerId !== "string") return;
      const markerId = verb.markerId.slice(0, 64);
      if (markerId === "") return;
      this.deps.onFocusEntry?.(markerId);
      return;
    }

    if (verb.v === "openlink") {
      // Clickable external reference. The frame's prelude checks are
      // convenience only — the frame is untrusted, so THIS validation is the
      // boundary and must stand alone: a string, bounded, URL-parseable, and
      // strictly http(s). On any failure: drop, never throw. The new tab gets
      // noopener,noreferrer so the destination can reach neither this window
      // nor the capability token it holds.
      if (typeof verb.href !== "string") return;
      const href = verb.href;
      if (href.length === 0 || href.length > HREF_MAX) return;
      let protocol: string;
      try {
        protocol = new URL(href).protocol;
      } catch {
        return; // relative / unparseable → drop
      }
      if (protocol !== "http:" && protocol !== "https:") return;
      try {
        const view = this.deps.iframe.ownerDocument.defaultView;
        view?.open(href, "_blank", "noopener,noreferrer");
      } catch {
        /* never throw out of the bridge */
      }
      return;
    }
    // Unknown verb → dropped.
  }

  /** Parent → frame: ask the frame to draw (if needed), scroll to, and highlight
   *  the marker for `markerId` (issue 27). Carries no token. Sent over the
   *  private port only after the port has been transferred. */
  focusMarker(markerId: string): void {
    if (this.disposed) return;
    try {
      this.channel.port1.postMessage({ v: "focusMarker", markerId });
    } catch {
      /* never throw out of the bridge */
    }
  }
}

export interface HtmlCardDeps {
  frameOrigin: string;
  frameSlug: string;
  artifactId: string;
  version: number;
  title: string;
  /** Issue 27: an "Ask about this" started inside the frame — open the parent
   *  drawer composer for this artifact/version, tracking the frame's markerId. */
  onAskStart?: (
    artifactId: string,
    version: number,
    quote: string,
    markerId: string,
  ) => void;
  /** Issue 27: an in-frame marker was clicked — highlight its drawer entry. */
  onFocusEntry?: (artifactId: string, markerId: string) => void;
}

/** The live handle for an html card: a disposer (drop window listeners before a
 *  re-render) plus `focusMarker` so the drawer can drive drawer → marker locate
 *  into the frame (issue 27). */
export interface HtmlCardHandle {
  dispose(): void;
  focusMarker(markerId: string): void;
}

/** Build the sandboxed iframe card body + its bridge. Returns the card handle;
 *  the gallery calls `dispose` before re-rendering (scrub/update). */
export function renderHtmlCard(
  mount: HTMLElement,
  deps: HtmlCardDeps,
): HtmlCardHandle {
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
    "no scripts of its own. Select text inside it to ask about it; links open " +
    "in a new tab.";
  mount.appendChild(caption);

  const bridge = new HtmlBridge({
    iframe,
    artifactId: deps.artifactId,
    version: deps.version,
    onResize: (px) => {
      iframe.style.height = `${px}px`;
    },
    onAskStart: (quote, markerId) =>
      deps.onAskStart?.(deps.artifactId, deps.version, quote, markerId),
    onFocusEntry: (markerId) => deps.onFocusEntry?.(deps.artifactId, markerId),
  });
  bridge.start();
  return {
    dispose: () => bridge.dispose(),
    focusMarker: (markerId) => bridge.focusMarker(markerId),
  };
}
