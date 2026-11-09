import { jsonError, type Guard, type RequestContext } from "./guard.ts";

export interface RateLimit {
  limit: number;
  windowMs: number;
}

const UNITS: Record<string, number> = { s: 1000, sec: 1000, min: 60_000, h: 3_600_000 };

// "60/min", "5/s", "1000/h".
export function parseRate(value: string, name = "rate"): RateLimit {
  const match = /^\s*(\d+)\s*\/\s*(s|sec|min|h)\s*$/.exec(value);
  const limit = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`${name}: expected a rate like 60/min, got ${JSON.stringify(value)}`);
  return { limit, windowMs: UNITS[match[2]!]! };
}

interface Bucket {
  tokens: number;
  at: number;
}

// Token bucket per key: bursts up to `limit`, refills at limit per window.
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    readonly rate: RateLimit,
    private now: () => number = Date.now,
    private maxKeys = 10_000,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    const perMs = this.rate.limit / this.rate.windowMs;
    const old = this.buckets.get(key);
    const tokens = old ? Math.min(this.rate.limit, old.tokens + (now - old.at) * perMs) : this.rate.limit;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > this.maxKeys) this.sweep(now, perMs);
    return { ok: true };
  }

  get size() {
    return this.buckets.size;
  }

  // Full buckets carry no state, so dropping them bounds memory without loosening any limit.
  private sweep(now: number, perMs: number) {
    for (const [key, b] of this.buckets) if (b.tokens + (now - b.at) * perMs >= this.rate.limit) this.buckets.delete(key);
  }
}

export function rateLimit(limiter: RateLimiter, keyOf: (ctx: RequestContext) => string | undefined): Guard {
  return (_req, ctx) => {
    const key = keyOf(ctx);
    if (key === undefined) return null;
    const r = limiter.take(key);
    if (r.ok) return null;
    return jsonError(429, "rate_limited", `too many requests; retry in ${r.retryAfterSec} s`, { "retry-after": String(r.retryAfterSec) });
  };
}
