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

/** How long after refocus the guard holds the scroll position (ms). Covers the
 *  ~300ms a resuming smooth scroll takes to run, with margin. */
const REFOCUS_GUARD_MS = 1200;

/** The page must never auto-scroll when the canvas tab/window regains focus.
 *
 *  A smooth scroll started INSIDE an artifact iframe chains out to move the
 *  parent page; when the tab is backgrounded mid-animation and later refocused,
 *  the animation resumes and runs the page toward the bottom with NO user input
 *  — confirmed by scroll-trace (on refocus scrollY ramps to the bottom, no
 *  gesture, page height static). `overflow-anchor` doesn't touch this: it's a
 *  real scroll, not scroll anchoring. It's also invisible to a parent-side probe
 *  because the call originates in the sandboxed frame's own realm.
 *
 *  So we guard at the layer that owns the page scroll: on regaining focus, snap
 *  back to where the human left off and hold that for a short window against any
 *  scroll they didn't drive. The FIRST gesture (wheel/key/touch/pointer) aborts
 *  the guard entirely, so a deliberate scroll — or a locate the human clicks
 *  right after refocus — is never fought. Keyed on window blur/focus (an
 *  app-switch from the terminal keeps the tab "visible", so visibilitychange
 *  alone would miss it) plus visibilitychange (tab switches). */
export function installRefocusScrollGuard(win: Window, doc: Document): void {
  if (typeof win.requestAnimationFrame !== "function") return; // non-browser env
  const now = (): number => win.performance?.now?.() ?? Date.now();
  const GESTURES = [
    "wheel",
    "keydown",
    "touchstart",
    "touchmove",
    "pointerdown",
    "mousedown",
  ];
  let savedY = win.scrollY;
  // Only the newest guard run is live; an earlier one bails when it sees a newer
  // generation (rapid focus/blur/focus must not stack competing rAF loops).
  let generation = 0;

  const leaving = (): void => {
    savedY = win.scrollY;
  };

  const returning = (): void => {
    const gen = ++generation;
    const until = now() + REFOCUS_GUARD_MS;
    let aborted = false;
    const abort = (): void => {
      aborted = true;
    };
    const opts = { passive: true, capture: true } as AddEventListenerOptions;
    for (const ev of GESTURES)
      win.addEventListener(ev, abort, { ...opts, once: true });
    const cleanup = (): void => {
      for (const ev of GESTURES) win.removeEventListener(ev, abort, opts);
    };
    // Interrupt the resuming scroll immediately, then hold each frame.
    if (win.scrollY !== savedY) win.scrollTo(0, savedY);
    const hold = (): void => {
      if (gen !== generation || aborted || now() > until) {
        cleanup();
        return;
      }
      if (win.scrollY !== savedY) win.scrollTo(0, savedY);
      win.requestAnimationFrame(hold);
    };
    win.requestAnimationFrame(hold);
  };

  win.addEventListener("blur", leaving);
  win.addEventListener("focus", returning);
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") leaving();
    else returning();
  });
}
