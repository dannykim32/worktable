// happy-dom bootstrap for renderer unit tests (dev-only dependency; the
// issue's testing plan requires a DOM implementation for jsdom-style tests).
import { Window } from "happy-dom";

export interface Dom {
  window: Window;
  document: Document;
  mount: HTMLElement;
}

export function makeDom(): Dom {
  const window = new Window();
  const document = window.document as unknown as Document;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  return { window, document, mount };
}
