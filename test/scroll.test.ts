// scrollToStable: the canvas "locate" scroll that holds a target in view against
// the HTML cards' late height re-measures, and yields to any manual scroll. The
// browser-level proof (a smooth scroll stranded 646px off-target by a mid-flight
// iframe growth; re-assert restores it) lives in the release notes; these cover
// the logic — initial vs correction behavior, reduced motion, cancel-on-input,
// detached-target, and non-browser safety — with an injected fake window so the
// timer/event paths run deterministically.
import { describe, expect, test } from "bun:test";
import {
  installRefocusScrollGuard,
  scrollToStable,
} from "../src/canvas/scroll.js";

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

/** A fake window + document with a controllable clock, rAF queue, and event bus,
 *  so the refocus guard's frame loop runs deterministically. */
function makeGuardEnv() {
  let y = 0;
  let clock = 0;
  const raf: Array<() => void> = [];
  const bus = new Map<string, Set<EventListener>>();
  const on = (key: string) => bus.get(key) ?? bus.set(key, new Set()).get(key)!;
  const win = {
    get scrollY() {
      return y;
    },
    scrollTo: (_x: number, ny: number) => {
      y = ny;
    },
    performance: { now: () => clock },
    requestAnimationFrame: (fn: () => void) => raf.push(fn),
    addEventListener: (t: string, fn: EventListener) => on("w:" + t).add(fn),
    removeEventListener: (t: string, fn: EventListener) => on("w:" + t).delete(fn),
  } as unknown as Window;
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (t: string, fn: EventListener) => on("d:" + t).add(fn),
  } as unknown as Document;
  return {
    win,
    doc,
    setY: (v: number) => (y = v),
    getY: () => y,
    advance: (ms: number) => (clock += ms),
    fireWin: (t: string) => on("w:" + t).forEach((fn) => fn({} as Event)),
    fireVisible: (state: DocumentVisibilityState) => {
      (doc as { visibilityState: DocumentVisibilityState }).visibilityState = state;
      on("d:visibilitychange").forEach((fn) => fn({} as Event));
    },
    // Each "frame" runs the queued rAF callbacks (which re-queue the next one).
    frame: (n = 1) => {
      for (let i = 0; i < n; i++) raf.splice(0).forEach((fn) => fn());
    },
  };
}

describe("installRefocusScrollGuard", () => {
  test("holds the pre-blur position against a non-gesture scroll on refocus", () => {
    const env = makeGuardEnv();
    installRefocusScrollGuard(env.win, env.doc);

    env.setY(3000); // the human reads here, then app-switches away
    env.fireWin("blur"); // → savedY = 3000

    env.setY(5000); // a resuming iframe scroll yanks the page down
    env.fireWin("focus"); // guard snaps back immediately
    expect(env.getY()).toBe(3000);

    env.setY(6000); // …and keeps yanking over the next frames
    env.frame();
    expect(env.getY()).toBe(3000);
    env.setY(6500);
    env.frame();
    expect(env.getY()).toBe(3000);
  });

  test("the first real gesture aborts the guard — a deliberate scroll is never fought", () => {
    const env = makeGuardEnv();
    installRefocusScrollGuard(env.win, env.doc);
    env.setY(3000);
    env.fireWin("blur");
    env.fireWin("focus");

    env.fireWin("wheel"); // the human takes over
    env.setY(7000); // their own scroll
    env.frame(2);
    expect(env.getY()).toBe(7000); // guard stood down, did not snap back
  });

  test("the guard stops after its window elapses", () => {
    const env = makeGuardEnv();
    installRefocusScrollGuard(env.win, env.doc);
    env.setY(3000);
    env.fireWin("blur");
    env.fireWin("focus");
    env.frame(); // still guarding
    env.advance(1300); // past the ~1200ms window
    env.setY(8000);
    env.frame();
    expect(env.getY()).toBe(8000); // no longer holding
  });

  test("a hidden→visible visibilitychange arms the guard too (tab switches)", () => {
    const env = makeGuardEnv();
    installRefocusScrollGuard(env.win, env.doc);
    env.setY(1200);
    env.fireVisible("hidden"); // → savedY = 1200
    env.setY(4000);
    env.fireVisible("visible");
    expect(env.getY()).toBe(1200);
  });

  test("no requestAnimationFrame (non-browser env) is a silent no-op", () => {
    const bare = {
      scrollY: 0,
      addEventListener: () => {},
    } as unknown as Window;
    const doc = { addEventListener: () => {} } as unknown as Document;
    expect(() => installRefocusScrollGuard(bare, doc)).not.toThrow();
  });
});
