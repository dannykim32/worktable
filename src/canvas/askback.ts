// Ask-back capture UI: select text inside a document block → floating
// "Ask about this" pill → composer popover → POST /api/askbacks.
// The Anchor pins artifact + the Version being viewed + block/char span,
// with the quote always carried so it survives content drift (ADR-0006).
import type { Anchor } from "../shared/artifacts.js";
import type { CanvasApi } from "./api.js";
import type { Gallery } from "./gallery.js";

export const QUOTE_MAX = 300;

/** Absolute character offset of (node, offsetInNode) within root's text. */
export function textOffsetWithin(
  root: Node,
  target: Node,
  offsetInTarget: number,
): number {
  let total = 0;
  let found = false;

  function walk(node: Node): void {
    if (found) return;
    if (node === target) {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        total += offsetInTarget;
      } else {
        // Element target: offset counts child nodes; add their text lengths.
        for (let i = 0; i < offsetInTarget; i++) {
          total += node.childNodes[i]?.textContent?.length ?? 0;
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === 3) {
      total += node.textContent?.length ?? 0;
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
      if (found) return;
    }
  }

  walk(root);
  return total;
}

/** Build the Anchor for a selection Range inside a single document block. */
export function anchorFromRange(
  range: Range,
  blockEl: HTMLElement,
  artifactId: string,
  version: number,
): Anchor {
  return {
    artifact_id: artifactId,
    version,
    block_index: Number(blockEl.dataset.blockIndex),
    char_start: textOffsetWithin(blockEl, range.startContainer, range.startOffset),
    char_end: textOffsetWithin(blockEl, range.endContainer, range.endOffset),
    quote: range.toString().slice(0, QUOTE_MAX),
  };
}

/** Whole-artifact Anchor (card ⋯ menu) — quote falls back to the title. */
export function wholeArtifactAnchor(
  artifactId: string,
  version: number,
  title: string,
): Anchor {
  return {
    artifact_id: artifactId,
    version,
    block_index: null,
    quote: title.slice(0, QUOTE_MAX),
  };
}

export interface AskbackDeps {
  api: CanvasApi;
  gallery: Gallery;
}

export class AskbackUi {
  readonly pill: HTMLElement;
  readonly composer: HTMLElement;
  readonly quoteBox: HTMLElement;
  readonly input: HTMLInputElement;
  readonly status: HTMLElement;
  private currentAnchor: Anchor | null = null;
  private pendingRangeAnchor: Anchor | null = null;

  constructor(
    private readonly doc: Document,
    private readonly deps: AskbackDeps,
  ) {
    this.pill = doc.createElement("button");
    this.pill.className = "askback-pill";
    this.pill.textContent = "Ask about this";
    this.pill.hidden = true;

    this.composer = doc.createElement("div");
    this.composer.className = "askback-composer";
    this.composer.hidden = true;
    this.quoteBox = doc.createElement("div");
    this.quoteBox.className = "anchor";
    this.input = doc.createElement("input");
    this.input.placeholder = "Ask the agent about this selection…";
    this.input.setAttribute("aria-label", "ask-back question");
    this.status = doc.createElement("div");
    this.status.className = "hint";
    this.status.textContent = "↵ to send · esc to close";
    this.composer.append(this.quoteBox, this.input, this.status);

    doc.body.append(this.pill, this.composer);

    doc.addEventListener("mouseup", (e) => {
      if (this.composer.contains(e.target as Node)) return;
      this.handleSelection();
    });
    this.pill.addEventListener("click", () => {
      if (this.pendingRangeAnchor) this.openComposer(this.pendingRangeAnchor);
    });
    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void this.submit();
      if (e.key === "Escape") this.closeComposer();
    });
  }

  /** mouseup handler: show the pill when a selection sits in one block. */
  handleSelection(): void {
    this.pill.hidden = true;
    this.pendingRangeAnchor = null;
    const win = this.doc.defaultView;
    const sel = win?.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const blockEl = this.closestBlock(range.commonAncestorContainer);
    if (!blockEl) return; // selection outside a block, or spanning blocks
    const card = blockEl.closest("[data-artifact-id]") as HTMLElement | null;
    if (!card) return;
    const artifactId = card.dataset.artifactId!;
    const version = this.deps.gallery.viewingVersion(artifactId);
    if (version === null) return;

    this.pendingRangeAnchor = anchorFromRange(range, blockEl, artifactId, version);
    const rect = range.getBoundingClientRect();
    this.pill.style.left = `${(win?.scrollX ?? 0) + rect.left + rect.width / 2 - 50}px`;
    this.pill.style.top = `${(win?.scrollY ?? 0) + rect.top - 34}px`;
    this.pill.hidden = false;
  }

  openComposer(anchor: Anchor): void {
    this.currentAnchor = anchor;
    // Quote + pin shown to the human before asking (textContent only).
    this.quoteBox.textContent =
      `${anchor.artifact_id} · v${anchor.version}` +
      (anchor.block_index === null
        ? " · whole artifact"
        : ` · block ${anchor.block_index}`) +
      `\n“${anchor.quote}”`;
    this.input.value = "";
    this.input.disabled = false;
    this.status.textContent = "↵ to send · esc to close";
    this.composer.style.left = this.pill.style.left;
    this.composer.style.top = `${parseFloat(this.pill.style.top || "0") + 40}px`;
    this.composer.hidden = false;
    this.pill.hidden = true;
    this.input.focus();
  }

  async submit(): Promise<void> {
    if (!this.currentAnchor) return;
    const question = this.input.value.trim();
    if (question.length === 0) return;
    this.input.disabled = true;
    try {
      await this.deps.api.postAskback({ anchor: this.currentAnchor, question });
      this.status.textContent = "sent — reaches the agent next turn ✓";
      setTimeout(() => this.closeComposer(), 2000);
    } catch (err) {
      this.input.disabled = false;
      this.status.textContent = `could not send: ${String(err)}`;
    }
  }

  closeComposer(): void {
    this.composer.hidden = true;
    this.currentAnchor = null;
  }

  private closestBlock(node: Node): HTMLElement | null {
    let current: Node | null =
      node.nodeType === 3 ? node.parentNode : node;
    while (current && current.nodeType === 1) {
      const el = current as HTMLElement;
      if (el.dataset.blockIndex !== undefined) return el;
      current = el.parentNode;
    }
    return null;
  }
}
