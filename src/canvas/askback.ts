// Ask-back capture UI (PROSE / ABSENCE path): select text inside a document
// block → floating "Ask about this" pill → hand the Anchor to the drawer, whose
// composer takes over (issue 27). The pill STAYS as the trigger; the composer +
// the whole conversation moved into the right-side drawer, so asking never
// covers the selected text.
//
// The Anchor pins artifact + the Version being viewed + block/char span, with
// the quote always carried so it survives content drift (ADR-0006).
import type { Anchor } from "../shared/artifacts.js";
import { QUOTE_MAX } from "../shared/constraints.js";
import type { Gallery } from "./gallery.js";

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

/** Build the Anchor for a selection Range anchored to `blockEl` (the block the
 *  selection STARTS in). char_start always lands inside blockEl; char_end may
 *  point into a LATER block when the selection was dragged across a boundary, in
 *  which case it clamps to the end of blockEl — the anchor marks this block while
 *  the quote carries the whole selected text (ADR-0006). */
export function anchorFromRange(
  range: Range,
  blockEl: HTMLElement,
  artifactId: string,
  version: number,
): Anchor {
  const charStart = textOffsetWithin(
    blockEl,
    range.startContainer,
    range.startOffset,
  );
  const charEnd = blockEl.contains(range.endContainer)
    ? textOffsetWithin(blockEl, range.endContainer, range.endOffset)
    : (blockEl.textContent?.length ?? charStart);
  return {
    artifact_id: artifactId,
    version,
    block_index: Number(blockEl.dataset.blockIndex),
    char_start: charStart,
    char_end: charEnd,
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
  gallery: Gallery;
  /** The pill was clicked with a live selection: hand the Anchor to the drawer,
   *  whose composer takes over (issue 27). */
  onAsk: (anchor: Anchor) => void;
}

export class AskbackUi {
  readonly pill: HTMLElement;
  private pendingRangeAnchor: Anchor | null = null;

  constructor(
    private readonly doc: Document,
    private readonly deps: AskbackDeps,
  ) {
    this.pill = doc.createElement("button");
    this.pill.className = "askback-pill";
    this.pill.textContent = "Ask about this";
    this.pill.hidden = true;

    doc.body.append(this.pill);

    doc.addEventListener("mouseup", (e) => {
      if (this.pill.contains(e.target as Node)) return;
      this.handleSelection();
    });
    this.pill.addEventListener("click", () => {
      if (this.pendingRangeAnchor) {
        const anchor = this.pendingRangeAnchor;
        this.pill.hidden = true;
        this.pendingRangeAnchor = null;
        this.deps.onAsk(anchor);
      }
    });
  }

  /** mouseup handler: show the pill for any non-empty selection that STARTS in a
   *  document block. A selection kept inside one block anchors to that block; one
   *  dragged across a block boundary (e.g. a heading into the paragraph below)
   *  anchors to the block it STARTS in, its quote carrying the full selected text
   *  (ADR-0006) so the ask-back stays faithful. */
  handleSelection(): void {
    this.pill.hidden = true;
    this.pendingRangeAnchor = null;
    const win = this.doc.defaultView;
    const sel = win?.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Anchor to the block the selection STARTS in. range.startContainer is the
    // earlier boundary point in document order regardless of drag direction, so
    // the choice is deterministic; commonAncestorContainer would resolve to the
    // card (no block index) for a cross-block drag and lose the anchor entirely.
    const blockEl = this.closestBlock(range.startContainer);
    if (!blockEl) return; // selection starts outside any document block
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
