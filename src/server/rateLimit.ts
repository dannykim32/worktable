// Rate limiting for the single browser→agent write channel (ADR-0010 names
// this as a purpose of having exactly one door). Fixed 60s window per key,
// in-memory — the queue itself is the durable part.
export const ASKBACK_RATE_LIMIT = 60; // requests
export const ASKBACK_RATE_WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  /** Whole seconds until the window resets (Retry-After) when not allowed. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request against `key` and decide. */
  consume(key: string): RateDecision {
    const at = this.now();
    const window = this.windows.get(key);
    if (!window || at - window.start >= this.windowMs) {
      this.windows.set(key, { start: at, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (window.count < this.limit) {
      window.count++;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.start + this.windowMs - at) / 1000),
      ),
    };
  }
}
