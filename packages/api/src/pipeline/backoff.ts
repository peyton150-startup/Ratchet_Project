export const IDLE_SLEEP_MS = 500;
export const MAX_BACKOFF_MS = 30_000;

export interface LoopState {
  consecutiveFailures: number;
  backoffMs: number;
}

/**
 * How long the worker waits after one loop iteration.
 *
 * Extracted from the loop so the failure policy is testable without running forever: transient
 * failures must back off exponentially (capped), and any success must reset the backoff — otherwise
 * a single blip degrades the pipeline indefinitely.
 */
export function nextLoopState(
  previousFailures: number,
  outcome: { ok: boolean; didWork: boolean },
): LoopState {
  if (outcome.ok) {
    return { consecutiveFailures: 0, backoffMs: outcome.didWork ? 0 : IDLE_SLEEP_MS };
  }
  const consecutiveFailures = previousFailures + 1;
  return {
    consecutiveFailures,
    backoffMs: Math.min(IDLE_SLEEP_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS),
  };
}
