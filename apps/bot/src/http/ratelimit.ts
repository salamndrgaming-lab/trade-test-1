/**
 * Sliding-window limiter: at most `max` calls in any `windowMs`. Calls queue in order.
 * Also honours a server-requested pause (429 / x-ratelimit-reset).
 */
export class RateLimiter {
  /** Clock used when none is passed. Tests swap in a simulated clock so long runs take no real time. */
  static defaultClock: { now(): number; sleep(ms: number): Promise<void> } | null = null;
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private pausedUntil = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = RateLimiter.defaultClock ?? realClock,
  ) {}

  /** Resolves when the caller may make one request. */
  take(): Promise<void> {
    const next = this.chain.then(() => this.waitTurn());
    this.chain = next.catch(() => undefined);
    return next;
  }

  pauseUntil(t: number) {
    this.pausedUntil = Math.max(this.pausedUntil, t);
  }

  private async waitTurn() {
    for (;;) {
      const now = this.clock.now();
      if (now < this.pausedUntil) {
        await this.clock.sleep(this.pausedUntil - now);
        continue;
      }
      this.stamps = this.stamps.filter((s) => now - s < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      await this.clock.sleep(this.stamps[0]! + this.windowMs - now + 1);
    }
  }
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
