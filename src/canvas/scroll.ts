// Robust "locate" scrolling for the canvas. A plain smooth `scrollIntoView`
// races the HTML cards' late height re-measures: the animation aims at a marker,
// an iframe ABOVE it grows mid-flight (load, the 50/250/800/2000ms re-measures,
// fonts.ready), and the target slides out from under the animation — landing
// off-screen (verified in-browser: 646px off). scrollToStable keeps the smooth
// motion, then re-asserts the target across the window where those re-measures
// land, so navigation lands AND stays on the marker.

/** True if the viewer asked the OS to reduce motion (best-effort; false when the
 *  query is unavailable, e.g. the test DOM). */
export function prefersReducedMotion(win: Window | null): boolean {
  try {
    return win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** Scroll `el` into view with `block` alignment, then hold it in view for a
 *  bounded window against late layout shifts. The initial scroll is smooth (or
 *  instant under reduced motion); corrections use `block:"nearest"` so they only
 *  move the page when the target actually drifted OUT of view — a stable page
 *  schedules zero visible motion. The correction is INTERRUPTIBLE: any manual
 *  wheel/touch/keydown from the human cancels it, so we never fight a deliberate
 *  scroll (a programmatic scroll does not dispatch those events, so our own
 *  corrections never self-cancel). No-op past the initial scroll in a non-browser
 *  env (`win` null / no `setTimeout`). */
export function scrollToStable(
  el: HTMLElement,
  block: ScrollLogicalPosition,
  win: Window | null,
): void {
  const into = (behavior: ScrollBehavior, b: ScrollLogicalPosition): void => {
    if (typeof el.scrollIntoView !== "function") return;
    try {
      el.scrollIntoView({ behavior, block: b });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* non-browser env */
      }
    }
  };

  into(prefersReducedMotion(win) ? "auto" : "smooth", block);
  if (!win || typeof win.setTimeout !== "function") return;

  let cancelled = false;
  const events = ["wheel", "touchmove", "keydown"] as const;
  const opts = { capture: true, passive: true } as AddEventListenerOptions;
  const teardown = (): void => {
    for (const ev of events) win.removeEventListener(ev, cancel, opts);
  };
  function cancel(): void {
    cancelled = true;
    teardown();
  }
  for (const ev of events) win.addEventListener(ev, cancel, opts);

  const checkpoints = [450, 750, 1100, 1500, 2000, 2400];
  checkpoints.forEach((ms, i) => {
    win.setTimeout(() => {
      if (cancelled) return;
      if (!el.isConnected) {
        teardown();
        return;
      }
      into("auto", "nearest");
      if (i === checkpoints.length - 1) teardown();
    }, ms);
  });
}
