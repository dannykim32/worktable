// Poll-wake listener park (GET /api/askbacks/await): the parked long-poll
// waiters an idle terminal agent leaves behind as a backgrounded job. When an
// ask-back is enqueued the park wakes every waiter, the job exits, and the
// Agent Host re-invokes the agent — no keystroke needed.
//
// STRICTLY read-only over the queue (ADR-0010): waking a listener never marks
// delivery — check_askbacks stays the only drain. Purely in-memory: a waiter is
// just an unresolved HTTP response, so a crash or restart loses nothing (the
// queue on disk is the source of truth and the CLI re-arms or goes idle).
//
// "Listening" is defined here: the agent is listening while ≥1 waiter is
// parked. The 0↔≥1 transitions drive the canvas's `listening` SSE event.

export type AwaitResult =
  | { status: "ask"; pending: number }
  | { status: "timeout" };

export const AWAIT_TIMEOUT_MIN_MS = 5_000;
export const AWAIT_TIMEOUT_MAX_MS = 240_000;
export const AWAIT_TIMEOUT_DEFAULT_MS = 240_000;
/** Parked-waiter bound (one server == one workspace). The 9th arrival resolves
 *  the OLDEST waiter with a timeout rather than refusing the newest — the
 *  newest is the one the live agent just armed. */
export const AWAIT_WAITER_CAP = 8;

/** Clamp a raw `timeout_ms` query value to [min, max]; absent/junk → default. */
export function clampAwaitTimeoutMs(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    return AWAIT_TIMEOUT_DEFAULT_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return AWAIT_TIMEOUT_DEFAULT_MS;
  return Math.min(
    AWAIT_TIMEOUT_MAX_MS,
    Math.max(AWAIT_TIMEOUT_MIN_MS, Math.floor(n)),
  );
}

interface ParkedWaiter {
  timer: NodeJS.Timeout;
  resolve: (result: AwaitResult) => void;
}

export class ListenerPark {
  /** Insertion-ordered: index 0 is the oldest waiter (the cap's victim). */
  private readonly waiters: ParkedWaiter[] = [];

  constructor(
    /** Fired on every 0↔≥1 transition (the canvas `listening` broadcast). */
    private readonly onTransition: (listening: boolean) => void = () => {},
  ) {}

  get listening(): boolean {
    return this.waiters.length > 0;
  }

  /** Park a waiter for up to `timeoutMs`. Returns an unpark handle the route
   *  wires to the response's `close` event, so a killed job or dropped socket
   *  never leaves a phantom "listening" state. */
  park(timeoutMs: number, resolve: (result: AwaitResult) => void): () => void {
    const wasListening = this.listening;
    if (this.waiters.length >= AWAIT_WAITER_CAP) {
      const oldest = this.waiters.shift()!;
      this.settle(oldest, { status: "timeout" });
    }
    const waiter: ParkedWaiter = {
      resolve,
      timer: setTimeout(() => this.expire(waiter), timeoutMs),
    };
    waiter.timer.unref?.();
    this.waiters.push(waiter);
    if (!wasListening) this.onTransition(true);
    return () => this.drop(waiter);
  }

  /** A new ask-back was enqueued: wake EVERY parked waiter with the pending
   *  count. The waiters only learn that questions exist — draining them stays
   *  with check_askbacks. */
  wake(pending: number): void {
    this.settleAll({ status: "ask", pending });
  }

  /** Server shutdown: end every parked response cleanly (as a timeout) instead
   *  of severing the sockets mid-park. */
  close(): void {
    this.settleAll({ status: "timeout" });
  }

  /** The waiter's own timer fired. */
  private expire(waiter: ParkedWaiter): void {
    if (!this.remove(waiter)) return;
    waiter.resolve({ status: "timeout" });
    if (this.waiters.length === 0) this.onTransition(false);
  }

  /** The client vanished (response closed): forget the waiter, resolve nothing. */
  private drop(waiter: ParkedWaiter): void {
    if (!this.remove(waiter)) return; // already settled — idempotent
    clearTimeout(waiter.timer);
    if (this.waiters.length === 0) this.onTransition(false);
  }

  private settleAll(result: AwaitResult): void {
    if (this.waiters.length === 0) return;
    const settling = this.waiters.splice(0);
    for (const waiter of settling) this.settle(waiter, result);
    this.onTransition(false);
  }

  private settle(waiter: ParkedWaiter, result: AwaitResult): void {
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  private remove(waiter: ParkedWaiter): boolean {
    const i = this.waiters.indexOf(waiter);
    if (i === -1) return false;
    this.waiters.splice(i, 1);
    return true;
  }
}
