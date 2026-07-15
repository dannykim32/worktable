// The Component Vocabulary's render seam (settled 2026-07-14): renderers are
// pure DOM-building functions over artifact JSON. This interface is the
// contract a future dedicated visual library must fit behind.
//
// Security invariant: model-influenced strings reach the DOM exclusively via
// textContent / createElement — never innerHTML.
import type { ArtifactContent, ArtifactType } from "../../shared/artifacts.js";
import { renderAbsence } from "./absence.js";
import { renderDocument } from "./document.js";
import { renderSvg } from "./svg.js";

export type ComponentRenderer = (
  content: ArtifactContent,
  mount: HTMLElement,
) => void;

export const componentRegistry: Record<ArtifactType, ComponentRenderer> = {
  document: renderDocument,
  absence: renderAbsence,
  svg: renderSvg,
};
