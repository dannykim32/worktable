// Inline canvas answers (issue 22): render the agent's reply to an ask-back
// next to the anchored selection, closing the loop where the human asked.
//
// Direction: answers flow agent→browser (SSE + a read route), the same way
// artifact pushes do — NOT a new browser→agent channel, so ADR-0010 holds. The
// answer is agent-authored text treated as UNTRUSTED display text: every string
// reaches the DOM via textContent/createElement only, never innerHTML.
import type { CanvasApi } from "./api.js";
import type {
  Anchor,
  AskbackAnswer,
  AskbackAnsweredEvent,
} from "../shared/artifacts.js";

interface ThreadEntry {
  anchor: Anchor;
  question: string;
  answer?: AskbackAnswer;
}

export class ReplyThreads {
  /** Ask-backs the human submitted (id → anchor+question), plus any answer
   *  once it arrives. Submitted-but-unanswered items are tracked but unrendered
   *  until an answer lands. */
  private readonly entries = new Map<string, ThreadEntry>();
  /** Mounted thread elements, keyed by ask-back id (for idempotent re-render). */
  private readonly mounted = new Map<string, HTMLElement>();

  constructor(
    private readonly doc: Document,
    private readonly galleryRoot: HTMLElement,
    private readonly api: CanvasApi,
  ) {}

  /** On submit, remember the ask-back locally (id + anchor + question) so its
   *  eventual answer can be threaded back to the right selection. */
  track(id: string, anchor: Anchor, question: string): void {
    const existing = this.entries.get(id);
    this.entries.set(id, { anchor, question, answer: existing?.answer });
  }

  /** Boot + refresh: load answered ask-backs from the server and render them,
   *  so inline replies survive a reload. */
  async loadAnswered(): Promise<void> {
    const answered = await this.api.getAnsweredAskbacks();
    for (const a of answered) {
      this.entries.set(a.id, {
        anchor: a.anchor,
        question: a.question,
        answer: a.answer,
      });
    }
    this.render();
  }

  /** SSE `askback_answered`: the payload carries only ids, so fetch the answer
   *  text from the read route and re-render — the reply appears without reload. */
  async handleAnswered(_event: AskbackAnsweredEvent): Promise<void> {
    await this.loadAnswered();
  }

  /** (Re)mount every answered thread at its anchor. Idempotent and safe to call
   *  after the gallery re-renders a card (which wipes body-mounted threads). */
  render(): void {
    for (const [id, entry] of this.entries) {
      if (!entry.answer) continue;
      // Drop any stale mount first so placement is always recomputed.
      this.mounted.get(id)?.remove();
      this.mounted.delete(id);
      const thread = this.buildThread(id, entry, entry.answer);
      if (this.mount(entry.anchor, thread)) this.mounted.set(id, thread);
    }
  }

  /** Insert a thread under its anchor: after the selected block for a
   *  block-anchored ask-back, else on the artifact card. Returns false if the
   *  target artifact is not on the canvas (nothing mounted). */
  private mount(anchor: Anchor, thread: HTMLElement): boolean {
    const card = this.galleryRoot.querySelector(
      `[data-artifact-id="${cssEscape(anchor.artifact_id)}"]`,
    ) as HTMLElement | null;
    if (!card) return false;
    if (anchor.block_index !== null) {
      const block = card.querySelector(
        `[data-block-index="${anchor.block_index}"]`,
      ) as HTMLElement | null;
      if (block?.parentNode) {
        block.parentNode.insertBefore(thread, block.nextSibling);
        return true;
      }
    }
    // Whole-artifact ask-back, or the block is not currently rendered: mount on
    // the card itself.
    card.appendChild(thread);
    return true;
  }

  private buildThread(
    id: string,
    entry: ThreadEntry,
    answer: AskbackAnswer,
  ): HTMLElement {
    const doc = this.doc;
    const thread = doc.createElement("div");
    thread.className = "reply-thread";
    thread.dataset.askbackId = id;

    // Unobtrusive affordance: a subtle "1 reply" toggle, collapsed by default.
    const toggle = doc.createElement("button");
    toggle.className = "reply-toggle";
    toggle.type = "button";
    toggle.textContent = "1 reply";
    toggle.setAttribute("aria-expanded", "false");

    const body = doc.createElement("div");
    body.className = "reply-body";
    body.hidden = true;

    // The human's question (textContent — agent never authored this, but keep
    // the whole thread innerHTML-free for one consistent rule).
    const q = doc.createElement("div");
    q.className = "reply-question";
    q.textContent = entry.question;

    // The agent's reply, visually distinct (indented/marked). answer.text is
    // agent-authored untrusted display text → textContent ONLY (XSS canary).
    const a = doc.createElement("div");
    a.className = "reply-answer";
    const who = doc.createElement("span");
    who.className = "reply-who";
    who.textContent = "agent";
    const text = doc.createElement("span");
    text.className = "reply-text";
    text.textContent = answer.text;
    a.append(who, text);

    body.append(q, a);
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      body.hidden = expanded;
    });

    thread.append(toggle, body);
    return thread;
  }
}

/** Minimal attribute-selector escape for artifact ids (a_[0-9a-f]{8}); guards
 *  the querySelector even though ids are already constrained. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
