// Ask-back side drawer (issue 27). Replaces the old composer popover
// (askback.ts, which now only raises the pill) and the inline reply threads
// (replies.ts, deleted): the composer + the WHOLE conversation live here, on the
// right of the canvas, so asking never covers the selected content. The artifact
// column reflows narrower while the drawer is open (CSS, driven by a body class).
//
// This is the single home for a canvas's Q&A. Each entry carries the selected
// quote (what it's about), the question, and the agent's answer — or a neutral
// pending state; the nudge BANNER carries the delivery story (terminal turn vs
// a listening agent, per the `listening` SSE state). Answers arrive via
// SSE `askback_answered` and fill their entry in place (ADR-0010: no new
// browser→agent channel — the write is still POST /api/askbacks).
//
// In-content markers + click-to-locate (the Google-Docs-comments model):
//  · PROSE / ABSENCE render in the PARENT DOM, so this drawer draws the marker
//    directly in the card and scrolls/highlights it — no bridge.
//  · HTML renders in a cross-origin sandboxed iframe, so the frame prelude draws
//    the marker; the drawer drives it over the MessageChannel bridge
//    (drawer→frame `focusMarker`; frame→drawer `focusEntry` via the gallery).
//
// Security: every model/agent-authored string (quote, question, answer) reaches
// this DOM via textContent ONLY — never innerHTML (XSS canary).
import type { CanvasApi } from "./api.js";
import { renderMarkdownInto } from "./components/prose.js";
import type {
  Anchor,
  AskbackAnswer,
  AskbackAnsweredEvent,
  ArtifactType,
} from "../shared/artifacts.js";

interface DrawerEntry {
  id: string;
  anchor: Anchor;
  question: string;
  answer?: AskbackAnswer;
  /** True when the artifact renders in the cross-origin frame: markers are
   *  drawn by the prelude and located over the bridge, not in the parent DOM. */
  isHtml: boolean;
  /** The frame-assigned markerId (html only); undefined for prose/absence. */
  markerId?: string;
  /** The rendered drawer list item (for highlight-on-locate). */
  entryEl?: HTMLElement;
}

export interface DrawerDeps {
  api: Pick<CanvasApi, "postAskback" | "getAnsweredAskbacks">;
  /** Where prose/absence cards live, so prose markers can be (re)mounted. */
  galleryRoot: HTMLElement;
  /** Drawer → marker locate for an html entry: drive the frame's marker over
   *  the bridge (gallery → the card's HtmlBridge.focusMarker). */
  locateInFrame?: (artifactId: string, markerId: string) => void;
  /** So a reloaded answer knows whether its artifact is html (frame-drawn
   *  markers) or prose/absence (parent-drawn). */
  artifactType?: (artifactId: string) => ArtifactType | null;
}

export class Drawer {
  /** Q&A for the whole canvas, insertion-ordered (the numbering + list order). */
  private readonly entries = new Map<string, DrawerEntry>();
  /** Prose/absence marker elements drawn in the cards, keyed by ask-back id. */
  private readonly markerEls = new Map<string, HTMLElement>();

  readonly toggleButton: HTMLButtonElement;
  readonly panel: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly quoteBox: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly emptyNote: HTMLElement;
  /** Prominent "the ball is in the terminal's court" banner, shown whenever a
   *  question is waiting for the human to submit a terminal turn (issue 27). */
  private readonly nudge: HTMLElement;

  private open_ = false;
  /** True while the agent has a poll-wake listener parked on the server (SSE
   *  `listening`): a question reaches it with no terminal keystroke, so the
   *  nudge banner switches to the calmer "listening" copy. */
  private listening = false;
  /** The in-progress question, before submit. */
  private pending:
    | { anchor: Anchor; isHtml: boolean; markerId?: string }
    | null = null;

  constructor(
    private readonly doc: Document,
    private readonly deps: DrawerDeps,
  ) {
    // Edge tab: a FIXED handle on the viewport's right edge, so collapsing and
    // reopening the drawer never depends on page content that the drawer (or a
    // narrow window) might occlude — the old header-placed toggle could end up
    // underneath the open drawer, leaving the tiny × as the only way out.
    this.toggleButton = doc.createElement("button");
    this.toggleButton.className = "drawer-tab";
    this.toggleButton.type = "button";
    this.toggleButton.setAttribute("aria-label", "toggle the conversation drawer");
    this.toggleButton.addEventListener("click", () => this.toggle());

    // Escape collapses the drawer (the composer's own esc first cancels the
    // in-progress question; a second esc then closes).
    doc.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.open_) return;
      if (!this.composer.hidden) return; // composer's esc handler owns this one
      this.close();
    });

    // Panel.
    this.panel = doc.createElement("aside");
    this.panel.className = "drawer";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "ask-back conversation");

    const header = doc.createElement("div");
    header.className = "drawer-head";
    const title = doc.createElement("h2");
    title.className = "drawer-title";
    title.textContent = "Conversation";
    const close = doc.createElement("button");
    close.className = "drawer-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "close the conversation drawer");
    close.addEventListener("click", () => this.close());
    header.append(title, close);

    // Composer (hidden until the human starts a question).
    this.composer = doc.createElement("div");
    this.composer.className = "drawer-composer";
    this.composer.hidden = true;
    const composerLabel = doc.createElement("div");
    composerLabel.className = "drawer-composer-label";
    composerLabel.textContent = "Ask about:";
    this.quoteBox = doc.createElement("div");
    this.quoteBox.className = "drawer-quote";
    this.input = doc.createElement("input");
    this.input.className = "drawer-input";
    this.input.placeholder = "Ask the agent about this selection…";
    this.input.setAttribute("aria-label", "ask-back question");
    this.status = doc.createElement("div");
    this.status.className = "drawer-hint";
    this.status.textContent = "↵ to send · esc to cancel";
    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void this.submit();
      if (e.key === "Escape") this.cancelComposer();
    });
    this.composer.append(composerLabel, this.quoteBox, this.input, this.status);

    // Terminal-turn nudge: an idle agent can't be woken from here, so once a
    // question is waiting, make it unmissable that the human must submit a
    // terminal turn to deliver it. Hidden until there's a pending question.
    this.nudge = doc.createElement("div");
    this.nudge.className = "drawer-nudge";
    this.nudge.hidden = true;
    this.nudge.setAttribute("role", "status");

    // Conversation list.
    this.list = doc.createElement("div");
    this.list.className = "drawer-list";
    this.emptyNote = doc.createElement("p");
    this.emptyNote.className = "drawer-empty";
    this.emptyNote.textContent =
      "Select text in an artifact and choose “Ask about this” — your questions " +
      "and the agent's answers gather here.";

    // Resize handle: a grab strip on the panel's left edge. Dragging writes
    // --drawer-w on the root, so the panel, the edge tab, AND the body reflow
    // all follow one variable — the artifact column resizes live with it.
    const grip = doc.createElement("div");
    grip.className = "drawer-resize";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "vertical");
    grip.setAttribute("aria-label", "resize the conversation drawer");
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      try {
        grip.setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic/odd pointers can't be captured — dragging still works */
      }
      // Transitions would fight the pointer — suspend them while dragging.
      this.doc.documentElement.classList.add("drawer-resizing");
      const onMove = (ev: PointerEvent) => {
        const viewport =
          this.doc.documentElement.clientWidth ||
          this.doc.defaultView?.innerWidth ||
          0;
        this.setWidth(viewport - ev.clientX);
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        this.doc.documentElement.classList.remove("drawer-resizing");
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });

    this.panel.append(grip, header, this.composer, this.nudge, this.list);
    this.restoreWidth();
    this.renderList();
    this.refreshToggle();
  }

  // ── width (drag-resize; one CSS var drives panel + tab + reflow) ──────
  /** Clamp + apply a drawer width and persist it across reloads. */
  setWidth(px: number): void {
    const viewport =
      this.doc.documentElement.clientWidth ||
      this.doc.defaultView?.innerWidth ||
      1200;
    const clamped = Math.round(
      Math.min(Math.min(720, viewport * 0.92), Math.max(280, px)),
    );
    this.doc.documentElement.style.setProperty("--drawer-w", `${clamped}px`);
    try {
      this.doc.defaultView?.localStorage?.setItem(
        "worktable.drawer-w",
        String(clamped),
      );
    } catch {
      /* storage may be unavailable — width just won't persist */
    }
  }

  private restoreWidth(): void {
    try {
      const saved = Number(
        this.doc.defaultView?.localStorage?.getItem("worktable.drawer-w"),
      );
      if (Number.isFinite(saved) && saved > 0) this.setWidth(saved);
    } catch {
      /* ignore */
    }
  }

  /** Place the edge tab and the panel in the page. */
  attach(body: HTMLElement): void {
    body.appendChild(this.toggleButton);
    body.appendChild(this.panel);
  }

  // ── open/close + reflow ───────────────────────────────────────────────
  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.panel.hidden = false;
    this.doc.documentElement.classList.add("drawer-open");
    this.refreshToggle();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.panel.hidden = true;
    this.doc.documentElement.classList.remove("drawer-open");
    this.refreshToggle();
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  private refreshToggle(): void {
    const n = this.entries.size;
    // Open: the tab rides the drawer's left edge as a collapse chevron.
    // Closed: it names the drawer (with the entry count) on the viewport edge.
    this.toggleButton.textContent = this.open_
      ? "›"
      : n > 0
        ? `‹ Conversation (${n})`
        : "‹ Conversation";
    this.toggleButton.setAttribute("aria-expanded", this.open_ ? "true" : "false");
  }

  // ── starting a question (both paths land here) ────────────────────────
  /** PROSE / ABSENCE: the parent-side pill was clicked with a live selection. */
  startAsk(anchor: Anchor, opts: { isHtml: boolean; markerId?: string }): void {
    this.pending = { anchor, isHtml: opts.isHtml, markerId: opts.markerId };
    this.quoteBox.textContent = anchor.quote;
    this.input.value = "";
    this.input.disabled = false;
    this.status.textContent = "↵ to send · esc to cancel";
    this.composer.hidden = false;
    this.open();
    this.input.focus();
  }

  /** HTML: the frame prelude sent `askstart` — open the composer for a
   *  whole-artifact anchor, tracking the frame's markerId. */
  onFrameAskStart(
    artifactId: string,
    version: number,
    quote: string,
    markerId: string,
  ): void {
    const anchor: Anchor = {
      artifact_id: artifactId,
      version,
      block_index: null,
      quote,
    };
    this.startAsk(anchor, { isHtml: true, markerId });
  }

  private cancelComposer(): void {
    this.composer.hidden = true;
    this.pending = null;
  }

  async submit(): Promise<void> {
    if (!this.pending) return;
    const { anchor, isHtml, markerId } = this.pending;
    const question = this.input.value.trim();
    if (question.length === 0) return;
    this.input.disabled = true;
    try {
      const res = await this.deps.api.postAskback({ anchor, question });
      if (res) {
        this.entries.set(res.id, { id: res.id, anchor, question, isHtml, markerId });
        this.composer.hidden = true;
        this.pending = null;
        this.renderList();
        if (isHtml && markerId) {
          // The frame draws + persists the marker on this confirmation, and
          // scrolls/highlights it (drawer → marker locate).
          this.deps.locateInFrame?.(anchor.artifact_id, markerId);
        } else {
          this.renderMarkers();
        }
        this.highlightEntry(res.id);
      }
    } catch (err) {
      this.input.disabled = false;
      this.status.textContent = `could not send: ${String(err)}`;
    }
  }

  // ── answers (SSE + boot) ──────────────────────────────────────────────
  /** Boot + refresh: pull answered ask-backs so the conversation survives a
   *  reload; fill answers into their entries (creating any not asked this
   *  session). */
  async loadAnswered(): Promise<void> {
    const answered = await this.deps.api.getAnsweredAskbacks();
    for (const a of answered) {
      const existing = this.entries.get(a.id);
      if (existing) {
        existing.answer = a.answer;
        existing.question = a.question;
        existing.anchor = a.anchor;
      } else {
        this.entries.set(a.id, {
          id: a.id,
          anchor: a.anchor,
          question: a.question,
          answer: a.answer,
          isHtml: this.deps.artifactType?.(a.anchor.artifact_id) === "html",
        });
      }
    }
    this.renderList();
    this.renderMarkers();
  }

  /** SSE `askback_answered`: the payload carries only ids, so refetch + refill. */
  async handleAnswered(_event: AskbackAnsweredEvent): Promise<void> {
    await this.loadAnswered();
  }

  // ── conversation list ─────────────────────────────────────────────────
  private renderList(): void {
    this.list.replaceChildren();
    if (this.entries.size === 0) {
      this.list.appendChild(this.emptyNote);
      this.refreshToggle();
      this.refreshNudge();
      return;
    }
    let n = 0;
    for (const entry of this.entries.values()) {
      n++;
      entry.entryEl = this.buildEntry(entry, n);
      this.list.appendChild(entry.entryEl);
    }
    this.refreshToggle();
    this.refreshNudge();
  }

  /** SSE `listening` (and its connect-time snapshot): the agent armed or
   *  dropped its poll-wake listener — swap the nudge copy accordingly. */
  setListening(on: boolean): void {
    if (this.listening === on) return;
    this.listening = on;
    this.refreshNudge();
  }

  /** Show the nudge iff a question is still waiting for its answer. Two static
   *  copies for the same banner: while the agent is LISTENING (a parked
   *  poll-wake waiter) the question arrives automatically; otherwise an idle
   *  agent can't be woken from here, so make the terminal keystroke obvious. */
  private refreshNudge(): void {
    let waiting = 0;
    for (const e of this.entries.values()) if (!e.answer) waiting++;
    this.nudge.classList.toggle("drawer-nudge--listening", this.listening);
    if (waiting === 0) {
      this.nudge.hidden = true;
      this.nudge.replaceChildren();
      return;
    }
    this.nudge.replaceChildren();
    const icon = this.doc.createElement("span");
    icon.className = "drawer-nudge-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = this.listening ? "●" : "⌨";
    const text = this.doc.createElement("span");
    text.className = "drawer-nudge-text";
    if (this.listening) {
      text.textContent =
        "The agent is listening — your question will reach it automatically.";
    } else {
      text.textContent =
        waiting === 1
          ? "Type anything in your terminal to send this question to the agent."
          : `Type anything in your terminal to send your ${waiting} pending questions.`;
    }
    this.nudge.append(icon, text);
    this.nudge.hidden = false;
  }

  private buildEntry(entry: DrawerEntry, num: number): HTMLElement {
    const doc = this.doc;
    const el = doc.createElement("div");
    el.className = "drawer-entry";
    el.dataset.askbackId = entry.id;

    const quote = doc.createElement("div");
    quote.className = "drawer-entry-quote";
    const badge = doc.createElement("span");
    badge.className = "drawer-entry-num";
    badge.textContent = String(num);
    const quoteText = doc.createElement("span");
    quoteText.className = "drawer-entry-quote-text";
    quoteText.textContent = entry.anchor.quote; // untrusted → textContent
    quote.append(badge, quoteText);

    const q = doc.createElement("div");
    q.className = "drawer-entry-q";
    q.textContent = entry.question; // human-authored, textContent for one rule

    el.append(quote, q);

    if (entry.answer) {
      const a = doc.createElement("div");
      a.className = "drawer-entry-a";
      const who = doc.createElement("span");
      who.className = "drawer-entry-who";
      who.textContent = "agent";
      const text = doc.createElement("div");
      text.className = "drawer-entry-text";
      // Agent-authored untrusted markdown → the trusted prose pipeline
      // (textContent/createElement only). Renders bullets/paragraphs/code
      // readably in the narrow column instead of one flat blob.
      renderMarkdownInto(entry.answer.text, text);
      a.append(who, text);
      el.appendChild(a);
    } else {
      const pending = doc.createElement("div");
      pending.className = "drawer-pending";
      const dot = doc.createElement("span");
      dot.className = "drawer-pending-dot";
      dot.setAttribute("aria-hidden", "true");
      const label = doc.createElement("span");
      label.className = "drawer-pending-label";
      // Honest pending copy: an idle terminal agent replies on its NEXT terminal
      // turn (the ask-back hook delivers; the human must submit a turn to nudge).
      label.textContent =
        "Sent — waiting for the agent.";
      pending.append(dot, label);
      el.appendChild(pending);
    }

    // Click the entry → locate its marker in the content (drawer → marker).
    el.addEventListener("click", () => this.locateEntry(entry.id));
    return el;
  }

  // ── markers (prose/absence, parent-drawn) ─────────────────────────────
  /** (Re)mount prose/absence markers in the cards. Safe to call after the
   *  gallery re-renders a card (which wipes body-mounted markers). */
  renderMarkers(): void {
    let n = 0;
    for (const entry of this.entries.values()) {
      n++;
      if (entry.isHtml) continue; // frame-drawn, not our DOM
      this.markerEls.get(entry.id)?.remove();
      this.markerEls.delete(entry.id);
      const marker = this.buildMarker(entry, n);
      if (this.mountMarker(entry.anchor, marker)) {
        this.markerEls.set(entry.id, marker);
      }
    }
  }

  private buildMarker(entry: DrawerEntry, num: number): HTMLElement {
    const marker = this.doc.createElement("button");
    marker.type = "button";
    marker.className = "anchor-marker";
    marker.dataset.askbackId = entry.id;
    marker.textContent = String(num);
    marker.setAttribute("aria-label", `question ${num} — show in the conversation`);
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      this.highlightEntry(entry.id);
    });
    return marker;
  }

  /** Insert a marker at its anchor: after the selected block for a block anchor,
   *  else on the artifact card. Returns false if the card is not on the canvas. */
  private mountMarker(anchor: Anchor, marker: HTMLElement): boolean {
    const card = this.deps.galleryRoot.querySelector(
      `[data-artifact-id="${cssEscape(anchor.artifact_id)}"]`,
    ) as HTMLElement | null;
    if (!card) return false;
    if (anchor.block_index !== null) {
      const block = card.querySelector(
        `[data-block-index="${anchor.block_index}"]`,
      ) as HTMLElement | null;
      if (block?.parentNode) {
        block.parentNode.insertBefore(marker, block.nextSibling);
        return true;
      }
    }
    card.appendChild(marker);
    return true;
  }

  // ── locate (both directions) ──────────────────────────────────────────
  /** Drawer → content: scroll to + highlight the marker for this entry. */
  locateEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.isHtml && entry.markerId) {
      this.deps.locateInFrame?.(entry.anchor.artifact_id, entry.markerId);
      return;
    }
    const marker = this.markerEls.get(id);
    if (marker) {
      this.scrollIntoView(marker, "center");
      this.flash(marker, "anchor-marker--flash");
    }
  }

  /** Content → drawer: highlight (and scroll to) this entry in the drawer. */
  highlightEntry(id: string): void {
    this.open();
    const entry = this.entries.get(id);
    const el = entry?.entryEl;
    if (!el) return;
    this.scrollIntoView(el, "nearest");
    this.flash(el, "drawer-entry--flash");
  }

  /** Frame marker → drawer (html): the bridge reported `focusEntry(markerId)`. */
  highlightEntryByMarker(artifactId: string, markerId: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.isHtml &&
        entry.markerId === markerId &&
        entry.anchor.artifact_id === artifactId
      ) {
        this.highlightEntry(entry.id);
        return;
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────
  private prefersReducedMotion(): boolean {
    try {
      return !!this.doc.defaultView?.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      )?.matches;
    } catch {
      return false;
    }
  }

  private scrollIntoView(el: HTMLElement, block: ScrollLogicalPosition): void {
    if (typeof el.scrollIntoView !== "function") return;
    try {
      el.scrollIntoView({
        behavior: this.prefersReducedMotion() ? "auto" : "smooth",
        block,
      });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* no-op in non-browser env */
      }
    }
  }

  private flash(el: HTMLElement, cls: string): void {
    el.classList.add(cls);
    const view = this.doc.defaultView;
    view?.setTimeout(() => el.classList.remove(cls), 1600);
  }
}

/** Minimal attribute-selector escape for artifact ids (a_[0-9a-f]{8}). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
