import { describe, expect, it } from "bun:test";
import { isOrphaned } from "../src/server/lifecycle.js";

describe("isOrphaned", () => {
  it("is true when a child of a real parent gets reparented to init", () => {
    // Host died: ppid was a real pid, now it's 1.
    expect(isOrphaned(4242, 1)).toBe(true);
  });

  it("is false while the parent is still alive", () => {
    expect(isOrphaned(4242, 4242)).toBe(false);
  });

  it("is false when started directly under init (never had a host)", () => {
    // A server launched by init (ppid 1 from the start, e.g. a container entry
    // point) must NOT self-terminate.
    expect(isOrphaned(1, 1)).toBe(false);
  });

  it("is false when reparented to something other than init", () => {
    expect(isOrphaned(4242, 9001)).toBe(false);
  });
});
