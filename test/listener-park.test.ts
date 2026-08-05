// ListenerPark's announced-state debounce: the await CLI loops ~4-minute polls
// inside one arming, and the milliseconds-wide gap between polls must NOT flap
// the canvas's "listening" indicator. Off is announced lazily (after a grace)
// for quiet expiries/disconnects, and immediately for real ends (wake/close).
import { describe, expect, test } from "bun:test";
import { ListenerPark } from "../src/server/listeners.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makePark(graceMs: number) {
  const transitions: boolean[] = [];
  const park = new ListenerPark((on) => transitions.push(on), graceMs);
  return { park, transitions };
}

describe("ListenerPark announced-state debounce", () => {
  test("re-park within the grace gap → one continuous listening session", async () => {
    const { park, transitions } = makePark(60);
    park.park(40, () => {});
    expect(transitions).toEqual([true]);

    await sleep(50); // waiter expired; zero parked, but grace is pending
    expect(park.listening).toBe(true); // announced state holds through the gap
    expect(transitions).toEqual([true]); // no off fired

    park.park(40, () => {}); // the CLI's next inner poll re-parks
    await sleep(20);
    expect(transitions).toEqual([true]); // still one session, no flap

    // Let the second waiter expire AND the grace elapse → off exactly once.
    await sleep(120);
    expect(transitions).toEqual([true, false]);
    expect(park.listening).toBe(false);
  });

  test("wake is a real end: off announced immediately, no grace", async () => {
    const { park, transitions } = makePark(5_000); // long grace would be visible
    let result: unknown;
    park.park(10_000, (r) => (result = r));
    expect(transitions).toEqual([true]);

    park.wake(2);
    expect(result).toEqual({ status: "ask", pending: 2 });
    expect(transitions).toEqual([true, false]); // no 5s wait
    expect(park.listening).toBe(false);
  });

  test("close during a grace gap forces the off announcement", async () => {
    const { park, transitions } = makePark(5_000);
    park.park(30, () => {});
    await sleep(45); // expired → grace pending, still announced on
    expect(park.listening).toBe(true);

    park.close();
    expect(transitions).toEqual([true, false]);
    expect(park.listening).toBe(false);
  });
});
