// Review Moment coordinator (issue 14, ADR-0004 amendment). request_review is a
// live subscription to the single ask-back queue (ADR-0010): a blocked call
// registers a waiter for one artifact; when an ask-back anchored to that
// artifact is appended, the POST handler notifies the coordinator, which wakes
// exactly one matching waiter. Purely in-memory — the queue on disk stays the
// source of truth, so a timeout degrades into an ordinary pending ask-back.
import type { Askback } from "../shared/artifacts.js";

interface Waiter {
  artifactId: string;
  resolve: (askback: Askback) => void;
}

export class ReviewCoordinator {
  private readonly waiters = new Set<Waiter>();

  /** Register interest in the next ask-back for `artifactId`. The returned
   *  handle must be passed to `unregister` on timeout to avoid a leak. */
  register(artifactId: string, resolve: (askback: Askback) => void): Waiter {
    const waiter: Waiter = { artifactId, resolve };
    this.waiters.add(waiter);
    return waiter;
  }

  unregister(waiter: Waiter): void {
    this.waiters.delete(waiter);
  }

  /** Wake the first waiter watching this ask-back's artifact. Returns true iff a
   *  waiter consumed it (the caller need not do anything either way — the item
   *  is already on the queue). One ask-back resolves at most one review. */
  onAskback(askback: Askback): boolean {
    for (const waiter of this.waiters) {
      if (waiter.artifactId === askback.anchor.artifact_id) {
        this.waiters.delete(waiter);
        waiter.resolve(askback);
        return true;
      }
    }
    return false;
  }
}
