// Free-form SVG renderer (issue 10): Image Isolation made structural. The
// sanitized markup is shown ONLY as a data:image/svg+xml URL in an <img> —
// never inline <svg>, never an <iframe> — so script execution is impossible
// by construction (CONTEXT.md Image Isolation), not by filtering. Provenance
// is a badge + standing caption, not sketch styling (ADR-0009).
import type { ArtifactContent } from "../../shared/artifacts.js";

/** The standing caption on every free-form artifact (ADR-0009, issue 10). */
export const SVG_CAPTION =
  "Depicts the idea, not the exact code — drawn by the model, shown as an " +
  "inert image.";

export function renderSvg(content: ArtifactContent, mount: HTMLElement): void {
  if (content.type !== "svg") return;
  const doc = mount.ownerDocument;
  mount.classList.add("svg-body");

  const holder = doc.createElement("div");
  holder.className = "svg-holder";
  const img = doc.createElement("img");
  // encodeURIComponent, not base64: keeps the data URL human-auditable and
  // matches the CSP `img-src data:` allowance from issue 02.
  img.src = `data:image/svg+xml,${encodeURIComponent(content.svg)}`;
  img.alt = content.title;
  holder.appendChild(img);
  mount.appendChild(holder);

  const caption = doc.createElement("p");
  caption.className = "svg-caption";
  caption.textContent = SVG_CAPTION;
  mount.appendChild(caption);
}
