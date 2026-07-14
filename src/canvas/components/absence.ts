// Honest Absence renderer: the agent declined to render something it could
// not render truthfully. Styled as a first-class outcome — deliberately calm,
// never an error banner (CONTEXT.md).
import type { ArtifactContent } from "../../shared/artifacts.js";

export function renderAbsence(content: ArtifactContent, mount: HTMLElement): void {
  if (content.type !== "absence") return;
  const doc = mount.ownerDocument;
  mount.classList.add("absence-body");

  const label = doc.createElement("div");
  label.className = "absence-label";
  label.textContent = "Declined honestly — with reason";
  mount.appendChild(label);

  const reason = doc.createElement("div");
  reason.className = "absence-reason";
  reason.textContent = content.reason;
  mount.appendChild(reason);
}
