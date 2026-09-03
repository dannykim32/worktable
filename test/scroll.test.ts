// scrollToStable: the canvas "locate" scroll that holds a target in view against
// the HTML cards' late height re-measures, and yields to any manual scroll. The
// browser-level proof (a smooth scroll stranded 646px off-target by a mid-flight
// iframe growth; re-assert restores it) lives in the release notes; these cover
// the logic — initial vs correction behavior, reduced motion, cancel-on-input,
// detached-target, and non-browser safety — with an injected fake window so the
// timer/event paths run deterministically.
import { describe, expect, test } from "bun:test";
import { scrollToStable } from "../src/canvas/scroll.js";

interface Call {
  behavior: string;
  block: string;
}

function makeEl(connected = true): {
  el: HTMLElement;
  calls: Call[];
} {
  const calls: Call[] = [];
  const el = {
    isConnected: connected,
    scrollIntoView(opts: { behavior: string; block: string }) {
      calls.push({ behavior: opts.behavior, block: opts.block });
    },
  } as unknown as HTMLElement;
  return { el, calls };
}

/** A fake Window that records timers + listeners so a test can flush/dispatch
 *  them synchronously — happy-dom's real timers would need wall-clock waits. */
function makeWin(reducedMotion = false) {
  const timers: Array<() => void> = [];
  const listeners = new Map<string, Set<EventListener>>();
  const removed: string[] = [];
  const win = {
    matchMedia: (q: string) => ({
      matches: reducedMotion && q.includes("reduce"),
    }),
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
      removed.push(type);
    },
  } as unknown as Window;
  return {
    win,
    flush: () => timers.splice(0).forEach((fn) => fn()),
    dispatch: (type: string) =>
      listeners.get(type)?.forEach((fn) => fn({} as Event)),
    listenerCount: () =>
      [...listeners.values()].reduce((n, s) => n + s.size, 0),
    removed,
  };
}

describe("scrollToStable", () => {
  test("initial pass is smooth + the requested block; corrections snap to nearest", () => {
    const { el, calls } = makeEl();
    const w = makeWin();
    scrollToStable(el, "center", w.win);

    expect(calls[0]).toEqual({ behavior: "smooth", block: "center" });
    expect(calls).toHaveLength(1); // corrections are deferred to timers

    w.flush();
    // Six correction checkpoints, each a nearest/auto re-assert while connected.
    const corrections = calls.slice(1);
    expect(corrections).toHaveLength(6);
    expect(corrections.every((c) => c.behavior === "auto" && c.block === "nearest")).toBe(true);
    // The window is torn down after the last checkpoint.
    expect(w.listenerCount()).toBe(0);
  });

  test("reduced motion makes the initial pass instant", () => {
    const { el, calls } = makeEl();
    const w = makeWin(true);
    scrollToStable(el, "start", w.win);
    expect(calls[0]).toEqual({ behavior: "auto", block: "start" });
  });

  test("a manual scroll cancels every pending correction and unbinds", () => {
    const { el, calls } = makeEl();
    const w = makeWin();
    scrollToStable(el, "center", w.win);
    expect(calls).toHaveLength(1);
    expect(w.listenerCount()).toBe(3); // wheel + touchmove + keydown

    w.dispatch("wheel"); // human takes over
    expect(w.listenerCount()).toBe(0); // listeners removed on cancel
    w.flush(); // pending timers must now no-op
    expect(calls).toHaveLength(1);
  });

  test("a detached target skips corrections (no scroll into a removed node)", () => {
    const { el, calls } = makeEl(false);
    const w = makeWin();
    scrollToStable(el, "center", w.win);
    expect(calls).toHaveLength(1); // the initial pass still ran
    w.flush();
    expect(calls).toHaveLength(1); // every correction bailed on !isConnected
    expect(w.listenerCount()).toBe(0);
  });

  test("no window (non-browser env) scrolls once and schedules nothing", () => {
    const { el, calls } = makeEl();
    expect(() => scrollToStable(el, "center", null)).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ behavior: "smooth", block: "center" });
  });
});
