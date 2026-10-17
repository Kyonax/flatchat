// SPDX-License-Identifier: AGPL-3.0-or-later
// Rate limits: one token bucket per key (an address, an account, an email), refilled over time.
// One core process holds them in memory; a restart forgets them, which only ever loosens a limit
// for a moment.

export interface LimitSpec {
  /** Requests allowed at once. */
  burst: number;
  /** Then one more every this many milliseconds. */
  everyMs: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly spec: LimitSpec;

  constructor(spec: LimitSpec) {
    this.spec = spec;
  }

  /** Takes one token for `key` at time `now` (ms); false when the bucket is empty. */
  take(key: string, now: number): boolean {
    const b = this.fill(key, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Milliseconds until `key` may try again (0 when it may now). */
  retryAfter(key: string, now: number): number {
    const b = this.fill(key, now);
    return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) * this.spec.everyMs);
  }

  private fill(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.spec.burst, at: now };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.sweep(now);
      return b;
    }
    b.tokens = Math.min(this.spec.burst, b.tokens + (now - b.at) / this.spec.everyMs);
    b.at = now;
    return b;
  }

  /** Forgets full buckets, so a flood of one-off keys cannot grow the map forever. */
  private sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) / this.spec.everyMs >= this.spec.burst) this.buckets.delete(key);
    }
  }
}

/** The core's limits (per minute unless noted): generous for people, tight for scripts. */
export const LIMITS = {
  /** Sign-in attempts per address. */
  signinByAddress: { burst: 10, everyMs: 6_000 },
  /** Sign-in attempts per email, whoever tries: 5, then one a minute. */
  signinByEmail: { burst: 5, everyMs: 60_000 },
  /** Sign-up attempts per address: 5, then one every 10 minutes. */
  signupByAddress: { burst: 5, everyMs: 600_000 },
  /** Login requests and code exchanges per address. */
  loginByAddress: { burst: 30, everyMs: 2_000 },
  /** Token refreshes per address. */
  refreshByAddress: { burst: 60, everyMs: 1_000 },
  /** Connect tokens per account. */
  joinByAccount: { burst: 30, everyMs: 2_000 },
  /** World host connections per address. */
  hostByAddress: { burst: 10, everyMs: 6_000 },
  /** Reports from the client per account: 10, then one every 6 minutes (S3.02). */
  reportByAccount: { burst: 10, everyMs: 360_000 },
  /** Reports from the public form per address: 5, then one every 10 minutes. */
  reportByAddress: { burst: 5, everyMs: 600_000 },
  /** Avatar uploads per account: 10, then one every 2.4 hours (ten a day, S4.01). */
  uploadByAccount: { burst: 10, everyMs: 8_640_000 },
  /** Any other API call per address. */
  apiByAddress: { burst: 120, everyMs: 250 },
} satisfies Record<string, LimitSpec>;
