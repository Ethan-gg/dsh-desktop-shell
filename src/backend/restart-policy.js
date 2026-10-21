'use strict';

/**
 * Deterministic restart budget:
 *   1st failure -> retry after 2s
 *   2nd failure -> retry after 5s
 *   3rd failure -> retry after 15s
 *   4th failure -> give up and ask the user / attempt a profile rollback.
 *
 * Any period of stable uptime (default 60s) resets the budget, so a once-a-day
 * crash never accumulates into an eventual give-up.
 */
class RestartPolicy {
  constructor({ delays = [2_000, 5_000, 15_000], stableMs = 60_000 } = {}) {
    if (!Array.isArray(delays) || delays.length === 0) throw new Error('delays must be a non-empty array');
    if (!delays.every((delay) => Number.isFinite(delay) && delay >= 0)) throw new Error('delays must be non-negative numbers');
    this.delays = [...delays];
    this.stableMs = stableMs;
    this.failures = 0;
    this.startedAt = null;
  }

  start(now = Date.now()) {
    this.startedAt = now;
    return this;
  }

  isStable(now = Date.now()) {
    return this.startedAt !== null && now - this.startedAt >= this.stableMs;
  }

  fail(now = Date.now()) {
    if (this.isStable(now)) this.reset();
    this.failures += 1;
    const index = this.failures - 1;
    if (index >= this.delays.length) {
      return { giveUp: true, failures: this.failures, delayMs: 0, attempt: null };
    }
    return {
      giveUp: false,
      failures: this.failures,
      delayMs: this.delays[index],
      attempt: this.failures,
    };
  }

  reset() {
    this.failures = 0;
    this.startedAt = null;
    return this;
  }
}

module.exports = { RestartPolicy };
