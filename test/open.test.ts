import { describe, expect, it } from "bun:test";
import { shouldOpenCanvas } from "../src/server/open.js";

const DEBOUNCE = 4000;

describe("shouldOpenCanvas", () => {
  it("opens when no tab is watching and the debounce has elapsed", () => {
    expect(shouldOpenCanvas(0, 5000, DEBOUNCE)).toBe(true);
  });

  it("opens on the first ever call (no prior open)", () => {
    expect(shouldOpenCanvas(0, Number.POSITIVE_INFINITY, DEBOUNCE)).toBe(true);
  });

  it("does NOT open when a tab is already connected", () => {
    // A live tab reconnects and receives the SSE event on its own.
    expect(shouldOpenCanvas(1, 5000, DEBOUNCE)).toBe(false);
    expect(shouldOpenCanvas(3, Number.POSITIVE_INFINITY, DEBOUNCE)).toBe(false);
  });

  it("does NOT re-open within the debounce window (tab still loading)", () => {
    expect(shouldOpenCanvas(0, 1000, DEBOUNCE)).toBe(false);
    expect(shouldOpenCanvas(0, 0, DEBOUNCE)).toBe(false);
  });

  it("opens exactly at the debounce boundary", () => {
    expect(shouldOpenCanvas(0, DEBOUNCE, DEBOUNCE)).toBe(true);
  });
});
