// Canvas settings panel (issue 20, ADR-0011): a gear in the header opens a
// popover that shows the effective Legibility Gate mode + where it was resolved
// from, and lets the HUMAN flip Report↔Enforce at either scope (this workspace,
// or all their workspaces). The change POSTs to the bearer-gated /api/settings
// and the panel re-renders from the server's response — the flip is LIVE (the
// server resolves gate mode per publish). This is the human's surface; no MCP
// tool can reach it.
//
// ALL text is set via textContent and nodes are built with createElement —
// never innerHTML. The gate mode + source come from the server, but keeping the
// panel injection-free by construction is the same posture as the rest of the
// canvas.
import type {
  CanvasApi,
  GateMode,
  GateScope,
  GateSettings,
} from "./api.js";

type SettingsApi = Pick<CanvasApi, "getSettings" | "postSettings">;

const MODE_LABEL: Record<GateMode, string> = {
  report: "Report",
  enforce: "Enforce",
};

const SOURCE_LABEL: Record<GateSettings["gate"]["source"], string> = {
  workspace: "this workspace",
  user: "all my workspaces",
  default: "default",
};

const MICROCOPY: Record<GateMode, string> = {
  report:
    "Report — the gate records legibility findings next to each free-form SVG " +
    "but never blocks or alters a publish.",
  enforce:
    "Enforce — an illegible SVG gets one bounded repair round with the gate's " +
    "exact findings; a second failure becomes an honest-absence artifact, never " +
    "a broken render.",
};

export class SettingsPanel {
  /** The gear button the caller places in the header. */
  readonly button: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly effectiveLine: HTMLElement;
  private readonly microcopy: HTMLElement;
  private readonly modeButtons = new Map<GateMode, HTMLButtonElement>();
  private readonly scopeInputs = new Map<GateScope, HTMLInputElement>();
  private readonly status: HTMLElement;
  private current: GateSettings | null = null;
  private open = false;

  constructor(
    private readonly doc: Document,
    private readonly api: SettingsApi,
  ) {
    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.className = "settings-gear";
    this.button.textContent = "⚙";
    this.button.title = "Legibility gate settings";
    this.button.setAttribute("aria-label", "Legibility gate settings");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", () => this.toggle());

    this.popover = doc.createElement("div");
    this.popover.className = "settings-popover";
    this.popover.hidden = true;

    const heading = doc.createElement("h2");
    heading.className = "settings-title";
    heading.textContent = "Legibility gate";
    this.popover.appendChild(heading);

    this.effectiveLine = doc.createElement("p");
    this.effectiveLine.className = "settings-effective";
    this.effectiveLine.textContent = "Loading…";
    this.popover.appendChild(this.effectiveLine);

    // Mode toggle (Report / Enforce).
    const modeRow = doc.createElement("div");
    modeRow.className = "settings-toggle";
    modeRow.setAttribute("role", "group");
    modeRow.setAttribute("aria-label", "Gate mode");
    for (const mode of ["report", "enforce"] as GateMode[]) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "settings-mode";
      b.dataset.mode = mode;
      b.textContent = MODE_LABEL[mode];
      b.addEventListener("click", () => void this.apply(mode));
      this.modeButtons.set(mode, b);
      modeRow.appendChild(b);
    }
    this.popover.appendChild(modeRow);

    this.microcopy = doc.createElement("p");
    this.microcopy.className = "settings-microcopy";
    this.popover.appendChild(this.microcopy);

    // Scope selector — which file the next change writes.
    const scopeFieldset = doc.createElement("fieldset");
    scopeFieldset.className = "settings-scope";
    const legend = doc.createElement("legend");
    legend.textContent = "Apply to";
    scopeFieldset.appendChild(legend);
    const scopeText: Record<GateScope, string> = {
      workspace: "This workspace default",
      user: "All my workspaces",
    };
    for (const scope of ["workspace", "user"] as GateScope[]) {
      const label = doc.createElement("label");
      label.className = "settings-scope-option";
      const input = doc.createElement("input");
      input.type = "radio";
      input.name = "gate-scope";
      input.value = scope;
      if (scope === "workspace") input.checked = true;
      const span = doc.createElement("span");
      span.textContent = scopeText[scope];
      label.append(input, span);
      this.scopeInputs.set(scope, input);
      scopeFieldset.appendChild(label);
    }
    this.popover.appendChild(scopeFieldset);

    this.status = doc.createElement("p");
    this.status.className = "settings-status";
    this.status.setAttribute("role", "status");
    this.popover.appendChild(this.status);
  }

  /** The wrapper (gear + popover) to append into the header. */
  mount(): HTMLElement {
    const wrap = this.doc.createElement("div");
    wrap.className = "settings-wrap";
    wrap.append(this.button, this.popover);
    return wrap;
  }

  /** Fetch the effective mode, render it, and — on first run (nothing set
   *  anywhere: source === "default") — surface the panel once so the human sets
   *  it the first time. */
  async load(): Promise<void> {
    try {
      this.current = await this.api.getSettings();
    } catch {
      this.effectiveLine.textContent = "Gate settings unavailable.";
      return;
    }
    this.render();
    if (this.current.gate.source === "default") {
      this.button.classList.add("first-run");
      this.show();
    }
  }

  private selectedScope(): GateScope {
    for (const [scope, input] of this.scopeInputs) {
      if (input.checked) return scope;
    }
    return "workspace";
  }

  private async apply(mode: GateMode): Promise<void> {
    const scope = this.selectedScope();
    this.status.textContent = "Saving…";
    try {
      this.current = await this.api.postSettings({ gate: mode, scope });
    } catch {
      this.status.textContent = "Could not save — try again.";
      return;
    }
    this.button.classList.remove("first-run");
    this.render();
    const where = SOURCE_LABEL[this.current.gate.source];
    this.status.textContent = `Saved — ${MODE_LABEL[this.current.gate.effective]} for ${where}. Applies to the next artifact.`;
  }

  private render(): void {
    if (!this.current) return;
    const { effective, source } = this.current.gate;
    this.effectiveLine.textContent = `${MODE_LABEL[effective]} · ${SOURCE_LABEL[source]}`;
    this.microcopy.textContent = MICROCOPY[effective];
    for (const [mode, b] of this.modeButtons) {
      const active = mode === effective;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  private toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  private show(): void {
    this.open = true;
    this.popover.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
  }

  private hide(): void {
    this.open = false;
    this.popover.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }
}
