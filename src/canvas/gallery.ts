// Vertical artifact gallery: cards with title, type badge, version chip with
// ‹ › scrubber, relative timestamp, live SSE-driven updates. All state is
// client-local and invisible to the agent (ADR-0010).
import type { CanvasApi } from "./api.js";
import type {
  ArtifactContent,
  ArtifactEvent,
  ArtifactMeta,
} from "../shared/artifacts.js";
import { componentRegistry } from "./components/registry.js";

export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

interface CardState {
  meta: ArtifactMeta;
  /** The Version currently rendered in the card body. */
  viewing: number;
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  badge: HTMLElement;
  vlabel: HTMLElement;
  marker: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  /** Review Moment banner (issue 14); hidden until a review is requested. */
  banner: HTMLElement;
}

export interface GalleryOptions {
  /** Card ⋯ menu → "Ask about this artifact" (whole-artifact ask-back). */
  onAskArtifact?: (meta: ArtifactMeta, viewing: number) => void;
  /** Review banner "Looks good — continue" (issue 14): approve the artifact. */
  onApproveReview?: (meta: ArtifactMeta, viewing: number) => void;
}

export class Gallery {
  private readonly cards = new Map<string, CardState>();
  private readonly emptyNote: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: CanvasApi,
    private readonly options: GalleryOptions = {},
  ) {
    const doc = root.ownerDocument;
    this.emptyNote = doc.createElement("p");
    this.emptyNote.className = "gallery-empty";
    this.emptyNote.textContent =
      "No artifacts yet — ask the agent to publish something to the canvas.";
    root.appendChild(this.emptyNote);
  }

  async init(): Promise<void> {
    const metas = await this.api.listArtifacts();
    for (const meta of metas) {
      const artifact = await this.api.getArtifact(meta.id);
      this.upsertCard(artifact, artifact.content);
    }
  }

  /** SSE `artifact` event: live-update the card in place, no reload. */
  async handleArtifactEvent(event: ArtifactEvent): Promise<void> {
    const artifact = await this.api.getArtifact(event.artifact_id);
    this.upsertCard(artifact, artifact.content);
  }

  /** The Version the card is currently showing (for anchor pinning). */
  viewingVersion(artifactId: string): number | null {
    return this.cards.get(artifactId)?.viewing ?? null;
  }

  metaFor(artifactId: string): ArtifactMeta | null {
    return this.cards.get(artifactId)?.meta ?? null;
  }

  /** SSE `review_requested`: the agent is blocking on this artifact's review.
   *  Show a banner with an approve button (issue 14). No-op if the card is not
   *  present yet. */
  showReviewBanner(artifactId: string): void {
    const card = this.cards.get(artifactId);
    if (!card) return;
    const doc = this.root.ownerDocument;
    card.banner.replaceChildren();
    const msg = doc.createElement("span");
    msg.className = "review-msg";
    msg.textContent = "agent is waiting for your review";
    const approve = doc.createElement("button");
    approve.className = "review-approve";
    approve.textContent = "Looks good — continue";
    approve.addEventListener("click", () => {
      approve.disabled = true;
      approve.textContent = "sent ✓";
      // The banner stays until the server confirms resolution via SSE
      // review_resolved — the approval travels as an ask-back (ADR-0010).
      this.options.onApproveReview?.(card.meta, card.viewing);
    });
    card.banner.append(msg, approve);
    card.banner.hidden = false;
  }

  /** SSE `review_resolved` (resolution OR timeout): clear the banner. */
  clearReviewBanner(artifactId: string): void {
    const card = this.cards.get(artifactId);
    if (!card) return;
    card.banner.hidden = true;
    card.banner.replaceChildren();
  }

  private upsertCard(meta: ArtifactMeta, latestContent: ArtifactContent): void {
    this.emptyNote.remove();
    const existing = this.cards.get(meta.id);
    if (!existing) {
      const card = this.buildCard(meta);
      this.cards.set(meta.id, card);
      this.root.insertBefore(card.root, this.root.firstChild);
      this.renderVersion(card, latestContent, meta.latest);
      return;
    }
    const followingLatest = existing.viewing === existing.meta.latest;
    existing.meta = meta;
    if (followingLatest) {
      this.renderVersion(existing, latestContent, meta.latest);
    } else {
      this.refreshChrome(existing); // stay pinned; update "viewing vN of M"
    }
  }

  private buildCard(meta: ArtifactMeta): CardState {
    const doc = this.root.ownerDocument;
    const root = doc.createElement("section");
    root.className = "artifact";
    root.dataset.artifactId = meta.id;

    const head = doc.createElement("div");
    head.className = "head";
    const title = doc.createElement("h2");
    const badge = doc.createElement("span");
    badge.className = "badge";
    const marker = doc.createElement("span");
    marker.className = "viewing-marker";
    marker.hidden = true;

    const vchip = doc.createElement("div");
    vchip.className = "vchip";
    const prev = doc.createElement("button");
    prev.className = "scrub prev";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "view previous version");
    const next = doc.createElement("button");
    next.className = "scrub next";
    next.textContent = "›";
    next.setAttribute("aria-label", "view next version");
    const vlabel = doc.createElement("span");
    vlabel.className = "vlabel";
    vchip.append(prev, vlabel, next);

    head.append(title, badge, marker, vchip);

    if (this.options.onAskArtifact) {
      const menuButton = doc.createElement("button");
      menuButton.className = "card-menu";
      menuButton.textContent = "⋯";
      menuButton.setAttribute("aria-label", "artifact actions");
      const menu = doc.createElement("div");
      menu.className = "card-menu-popover";
      menu.hidden = true;
      const askItem = doc.createElement("button");
      askItem.className = "card-menu-item";
      askItem.textContent = "Ask about this artifact";
      menu.appendChild(askItem);
      menuButton.addEventListener("click", () => {
        menu.hidden = !menu.hidden;
      });
      askItem.addEventListener("click", () => {
        menu.hidden = true;
        const state = this.cards.get(meta.id);
        this.options.onAskArtifact?.(
          state?.meta ?? meta,
          state?.viewing ?? meta.latest,
        );
      });
      head.append(menuButton, menu);
    }

    const banner = doc.createElement("div");
    banner.className = "review-banner";
    banner.hidden = true;

    const body = doc.createElement("div");
    body.className = "body";
    root.append(head, banner, body);

    const card: CardState = {
      meta,
      viewing: meta.latest,
      root,
      body,
      title,
      badge,
      vlabel,
      marker,
      prev,
      next,
      banner,
    };
    prev.addEventListener("click", () => void this.scrub(card, -1));
    next.addEventListener("click", () => void this.scrub(card, +1));
    return card;
  }

  private async scrub(card: CardState, delta: number): Promise<void> {
    const target = card.viewing + delta;
    if (target < 1 || target > card.meta.latest) return;
    const content = await this.api.getVersion(card.meta.id, target);
    this.renderVersion(card, content, target);
  }

  private renderVersion(
    card: CardState,
    content: ArtifactContent,
    version: number,
  ): void {
    card.viewing = version;
    card.body.replaceChildren();
    card.body.className = "body";
    card.body.dataset.version = String(version);
    componentRegistry[content.type](content, card.body);
    this.refreshChrome(card);
  }

  private refreshChrome(card: CardState): void {
    const { meta } = card;
    card.title.textContent = meta.title;
    // Free-form SVG wears a distinct provenance badge (ADR-0009); components
    // show their plain type. The standing caption lives in the card body.
    card.badge.textContent = meta.type === "svg" ? "svg · free-form" : meta.type;
    card.badge.className = `badge ${
      meta.type === "absence" ? "absence" : meta.type === "svg" ? "freeform" : ""
    }`.trim();
    card.vlabel.textContent = `v${card.viewing} · ${relativeTime(meta.updated_at)}`;
    card.prev.disabled = card.viewing <= 1;
    card.next.disabled = card.viewing >= meta.latest;
    const behind = card.viewing < meta.latest;
    card.marker.hidden = !behind;
    card.marker.textContent = behind
      ? `viewing v${card.viewing} of ${meta.latest}`
      : "";
  }
}
