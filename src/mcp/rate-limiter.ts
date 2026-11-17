/** Small fixed-window limiter with bounded client state and lazy expiration. */
export class HttpRateLimiter {
  private readonly clients = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
    private readonly maxClients = 4_096,
    private readonly now: () => number = Date.now,
  ) {
    if (![limit, windowMs, maxClients].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError('Rate limiter settings must be positive safe integers.');
    }
  }

  allow(client: string): boolean {
    const now = this.now();
    for (const [key, state] of this.clients) {
      if (now - state.windowStartedAt >= this.windowMs) this.clients.delete(key);
    }
    let state = this.clients.get(client);
    if (state === undefined) {
      if (this.clients.size >= this.maxClients) return false;
      state = { windowStartedAt: now, count: 0 };
      this.clients.set(client, state);
    }
    if (now - state.windowStartedAt >= this.windowMs) {
      state.windowStartedAt = now;
      state.count = 0;
    }
    state.count += 1;
    return state.count <= this.limit;
  }

  get size(): number { return this.clients.size; }
}
