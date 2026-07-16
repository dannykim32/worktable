// Canvas gate-settings panel (issue 20). Renders the effective mode + source,
// POSTs the toggle live and re-renders from the response, builds every node with
// createElement/textContent (never innerHTML), and surfaces itself once on
// first run (source === "default").
import { describe, expect, test } from "bun:test";
import { SettingsPanel } from "../src/canvas/settings.js";
import type { GateSettings } from "../src/canvas/api.js";
import { makeDom } from "./dom.js";

function fakeApi(initial: GateSettings) {
  const calls: Array<{ gate: string; scope: string }> = [];
  let state = initial;
  return {
    calls,
    setNext(next: GateSettings) {
      state = next;
    },
    getSettings: () => Promise.resolve(state),
    postSettings: (body: { gate: "report" | "enforce"; scope: "workspace" | "user" }) => {
      calls.push(body);
      state = { gate: { effective: body.gate, source: body.scope } };
      return Promise.resolve(state);
    },
  };
}

describe("SettingsPanel", () => {
  test("renders the effective mode + source as text after load", async () => {
    const { document, mount } = makeDom();
    const api = fakeApi({ gate: { effective: "enforce", source: "workspace" } });
    const panel = new SettingsPanel(document, api);
    mount.appendChild(panel.mount());
    await panel.load();

    const effective = mount.querySelector(".settings-effective")!;
    expect(effective.textContent).toBe("Enforce · this workspace");
    // textContent-only: the line carries no injected element children.
    expect(effective.children.length).toBe(0);
    // The active mode button reflects the effective mode.
    const active = mount.querySelector(".settings-mode.active")!;
    expect(active.textContent).toBe("Enforce");
  });

  test("toggling a mode POSTs the chosen scope and re-renders live", async () => {
    const { document, mount } = makeDom();
    const api = fakeApi({ gate: { effective: "report", source: "user" } });
    const panel = new SettingsPanel(document, api);
    mount.appendChild(panel.mount());
    await panel.load();

    // Pick the "all my workspaces" (user) scope, then click Enforce.
    (mount.querySelector('input[value="user"]') as HTMLInputElement).checked = true;
    (mount.querySelector('input[value="workspace"]') as HTMLInputElement).checked =
      false;
    const enforceBtn = [...mount.querySelectorAll(".settings-mode")].find(
      (b) => b.textContent === "Enforce",
    ) as HTMLButtonElement;
    enforceBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.calls).toEqual([{ gate: "enforce", scope: "user" }]);
    expect(mount.querySelector(".settings-effective")!.textContent).toBe(
      "Enforce · all my workspaces",
    );
  });

  test("first run (source === default) surfaces the panel; a set mode does not", async () => {
    // Default: popover opens on load and the gear is flagged first-run.
    const first = makeDom();
    const firstApi = fakeApi({ gate: { effective: "report", source: "default" } });
    const firstPanel = new SettingsPanel(first.document, firstApi);
    first.mount.appendChild(firstPanel.mount());
    await firstPanel.load();
    expect(
      (first.mount.querySelector(".settings-popover") as HTMLElement).hidden,
    ).toBe(false);
    expect(
      first.mount.querySelector(".settings-gear")!.classList.contains("first-run"),
    ).toBe(true);

    // Already set: the panel stays closed (no nag).
    const set = makeDom();
    const setApi = fakeApi({ gate: { effective: "enforce", source: "workspace" } });
    const setPanel = new SettingsPanel(set.document, setApi);
    set.mount.appendChild(setPanel.mount());
    await setPanel.load();
    expect(
      (set.mount.querySelector(".settings-popover") as HTMLElement).hidden,
    ).toBe(true);
  });
});
