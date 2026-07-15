// Compare component renderer (issue 08, ADR-0007). Reference rendering:
// the judged prototype's "Ask-back delivery: before / after" card — two
// labeled panes of monospace lines with add/del background tints.
//
// Marks arrive from the agent (the canvas never computes diffs), and every
// line lands via textContent — never innerHTML of model-influenced strings.
// Side-by-side ≥700px, stacked below (styles.css media query).
import type { ArtifactContent, ComparePane } from "../../shared/artifacts.js";

function renderPane(pane: ComparePane, mount: HTMLElement): HTMLElement {
  const doc = mount.ownerDocument;
  const root = doc.createElement("div");
  root.className = "pane";

  const head = doc.createElement("div");
  head.className = "pane-head";
  head.textContent = pane.label;
  root.appendChild(head);

  const pre = doc.createElement("pre");
  pane.lines.forEach((line, index) => {
    const span = doc.createElement("span");
    span.className = line.mark ? `line ${line.mark}` : "line";
    span.textContent = line.text;
    // Anchors reference pane lines by index within the viewed Version.
    span.dataset.lineIndex = String(index);
    pre.appendChild(span);
  });
  root.appendChild(pre);

  mount.appendChild(root);
  return root;
}

export function renderCompare(
  content: ArtifactContent,
  mount: HTMLElement,
): void {
  if (content.type !== "compare") return;
  mount.classList.add("compare");
  for (const pane of content.panes) renderPane(pane, mount);
}
