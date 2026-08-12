// Gallery navigator: a compact, fixed index of the renderings on this canvas.
//
// When the agent publishes more than one artifact into the same session the
// cards stack vertically, and the extra renderings sit below the fold where
// they're easy to miss. This top-left panel names each rendering and jumps to
// it on click, with a scroll-spy marker for the one currently in view. It stays
// hidden while there is 0–1 artifact so the common single-render case is
// uncluttered. Pure DOM; no framework.
import type { ArtifactType } from "../shared/artifacts.js";

export interface NavEntry {
  id: string;
  title: string;
  type: ArtifactType;
  /** The artifact `<section>` in the gallery this entry scrolls to. */
  el: HTMLElement;
}

/** Below the single-render threshold the whole panel hides — no clutter for the
 *  case that doesn't need navigation. */
const MIN_ENTRIES = 2;

export class GalleryNav {
  private readonly nav: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly countLabel: HTMLElement;
  private readonly list: HTMLOListElement;
  /** id → its list button, so scroll-spy can toggle `.active` without a rebuild. */
  private readonly items = new Map<string, HTMLButtonElement>();
  /** id → its gallery card, for jump + intersection bookkeeping. */
  private readonly cardEls = new Map<string, HTMLElement>();
  /** id → last intersection ratio; the max-ratio entry is the active one. */
  private readonly ratios = new Map<string, number>();
  private readonly observer: IntersectionObserver | null;
  private collapsed = false;

  constructor(private readonly doc: Document) {
    const nav = doc.createElement("nav");
    nav.className = "gallery-nav";
    nav.hidden = true;
    nav.setAttribute("aria-label", "Renderings on this canvas");

    const head = doc.createElement("button");
    head.type = "button";
    head.className = "gallery-nav-head";
    head.setAttribute("aria-expanded", "true");
    const icon = doc.createElement("span");
    icon.className = "gallery-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▤";
    this.countLabel = doc.createElement("span");
    this.countLabel.className = "gallery-nav-count";
    head.append(icon, this.countLabel);
    head.addEventListener("click", () => this.toggle());

    this.list = doc.createElement("ol");
    this.list.className = "gallery-nav-list";

    nav.append(head, this.list);
    this.head = head;
    this.nav = nav;
    doc.body.appendChild(nav);

    // Scroll-spy is a progressive enhancement: without IntersectionObserver
    // (older host, test DOM) the panel still navigates, just without the marker.
    this.observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => this.onIntersect(entries), {
            // Bias toward the upper band so "active" tracks what you're reading,
            // not a card barely peeking in at the bottom.
            rootMargin: "-10% 0px -70% 0px",
            threshold: [0, 0.25, 0.5, 1],
          })
        : null;
  }

  /** Rebuild the index from the gallery's current cards, in visual (DOM) order.
   *  Called whenever a card is added or its title changes. */
  sync(entries: NavEntry[]): void {
    this.observer?.disconnect();
    this.items.clear();
    this.cardEls.clear();
    this.ratios.clear();
    this.list.replaceChildren();

    if (entries.length < MIN_ENTRIES) {
      this.nav.hidden = true;
      return;
    }

    this.countLabel.textContent = `${entries.length} renderings`;
    entries.forEach((entry, i) => {
      const li = this.doc.createElement("li");
      const btn = this.doc.createElement("button");
      btn.type = "button";
      btn.className = "gallery-nav-item";
      btn.dataset.navId = entry.id;

      const num = this.doc.createElement("span");
      num.className = "gallery-nav-num";
      num.textContent = String(i + 1);
      const title = this.doc.createElement("span");
      title.className = "gallery-nav-title";
      title.textContent = entry.title; // untrusted → textContent
      const type = this.doc.createElement("span");
      type.className = `gallery-nav-type gallery-nav-type--${entry.type}`;
      type.setAttribute("aria-hidden", "true");

      btn.append(num, title, type);
      btn.addEventListener("click", () => this.jump(entry.el));
      li.appendChild(btn);
      this.list.appendChild(li);

      this.items.set(entry.id, btn);
      this.cardEls.set(entry.id, entry.el);
      this.observer?.observe(entry.el);
    });

    this.nav.hidden = false;
  }

  private jump(el: HTMLElement): void {
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({
          behavior: this.prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
      } catch {
        try {
          el.scrollIntoView();
        } catch {
          /* non-browser env */
        }
      }
    }
    // Flash the target so the eye lands on it after the scroll.
    el.classList.remove("artifact--flash");
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add("artifact--flash");
  }

  private toggle(): void {
    this.collapsed = !this.collapsed;
    this.nav.dataset.collapsed = String(this.collapsed);
    this.head.setAttribute("aria-expanded", String(!this.collapsed));
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.artifactId;
      if (id) this.ratios.set(id, e.isIntersecting ? e.intersectionRatio : 0);
    }
    let activeId: string | null = null;
    let best = 0;
    // Iterate insertion order (== DOM order) so ties resolve to the topmost.
    for (const [id] of this.items) {
      const r = this.ratios.get(id) ?? 0;
      if (r > best) {
        best = r;
        activeId = id;
      }
    }
    for (const [id, btn] of this.items) {
      btn.classList.toggle("active", id === activeId);
    }
  }

  private prefersReducedMotion(): boolean {
    try {
      return this.doc.defaultView?.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches === true;
    } catch {
      return false;
    }
  }
}
