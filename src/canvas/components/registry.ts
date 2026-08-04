// The Component Vocabulary's render seam (settled 2026-07-14): renderers are
// pure DOM-building functions over artifact JSON. This interface is the
// contract a future dedicated visual library must fit behind.
//
// The artifact surface is {html, prose, absence} (issue 26). `html` is NOT a
// component renderer (see below); prose and absence are the two pure renderers.
//
// Security invariant: model-influenced strings reach the DOM exclusively via
// textContent / createElement — never innerHTML.
import type { ArtifactContent, ArtifactType } from "../../shared/artifacts.js";
import { renderAbsence } from "./absence.js";
import { renderProse } from "./prose.js";

export type ComponentRenderer = (
  content: ArtifactContent,
  mount: HTMLElement,
) => void;

// `html` is deliberately NOT a component renderer: it is not trusted structured
// data drawn into the host DOM, but a sandboxed, origin-split iframe (issue 25).
// The gallery special-cases it (renderHtmlCard) because it needs live deps (api,
// frame origin, ask-back threading) a pure renderer cannot carry.
export type ComponentType = Exclude<ArtifactType, "html">;

export const componentRegistry: Record<ComponentType, ComponentRenderer> = {
  absence: renderAbsence,
  prose: renderProse,
};
