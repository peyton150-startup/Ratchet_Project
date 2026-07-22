/**
 * Stability primitives (Nygard, Release It!).
 *
 * The risk these address: every integration point can hang, and a slow response is worse than a
 * fast failure because it holds resources. Ratchet calls tenant-controlled webhook endpoints from
 * the worker, so a single unresponsive endpoint could otherwise stall the pipeline.
 */
import { log, metrics } from './observability';

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Reject if `promise` has not settled within `ms`. Every outbound call must be wrapped. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** How long to stay open before allowing a probe. */
  resetTimeoutMs: number;
}

interface BreakerEntry {
  failures: number;
  state: BreakerState;
  openedAt: number;
}

/**
 * Circuit breaker keyed by target (one webhook endpoint = one circuit).
 *
 * Without this, a permanently dead endpoint is retried on every single event forever, burning
 * worker time on calls that cannot succeed. After `failureThreshold` consecutive failures the
 * circuit opens and calls fail fast; after `resetTimeoutMs` one probe is allowed (half-open), and a
 * success closes it again.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, BreakerEntry>();

  constructor(private readonly opts: BreakerOptions) {}

  /** Whether a call to `key` should be attempted right now. */
  canAttempt(key: string, now: number = Date.now()): boolean {
    const entry = this.circuits.get(key);
    if (!entry || entry.state === 'closed') return true;
    if (entry.state === 'half-open') return true;
    // open: allow a single probe once the reset window has elapsed
    if (now - entry.openedAt >= this.opts.resetTimeoutMs) {
      entry.state = 'half-open';
      return true;
    }
    return false;
  }

  state(key: string): BreakerState {
    return this.circuits.get(key)?.state ?? 'closed';
  }

  recordSuccess(key: string): void {
    const entry = this.circuits.get(key);
    if (!entry) return;
    if (entry.state !== 'closed') {
      log.info('circuit closed', { target: key });
    }
    this.circuits.delete(key);
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const entry = this.circuits.get(key) ?? { failures: 0, state: 'closed' as BreakerState, openedAt: 0 };
    entry.failures += 1;
    // A failed probe re-opens immediately; otherwise open once the threshold is crossed.
    if (entry.state === 'half-open' || entry.failures >= this.opts.failureThreshold) {
      if (entry.state !== 'open') {
        log.warn('circuit opened', { target: key, failures: entry.failures });
        metrics.circuitOpened.inc({});
      }
      entry.state = 'open';
      entry.openedAt = now;
    }
    this.circuits.set(key, entry);
  }
}
