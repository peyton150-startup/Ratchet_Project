import type { Pool } from 'pg';
import { withTenant } from '../db';
import type { Decision } from '../rules/engine';
import { createTaskFromDecision, insertDeadLetter, type CreateResult } from './service';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface RetryOutcome<T> {
  status: 'ok' | 'dead_lettered';
  attempts: number;
  result?: T;
  error?: string;
}

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `handler` with bounded retries and exponential backoff. On exhaustion, invoke
 * `onDeadLetter` (the poison-message sink) and report dead_lettered. Pure and injectable:
 * tests pass baseDelayMs: 0 and/or a no-op sleep to avoid real waiting.
 */
export async function processWithRetry<T>(
  policy: RetryPolicy,
  handler: () => Promise<T>,
  onDeadLetter: (attempts: number, error: string) => Promise<void>,
  sleep: Sleep = defaultSleep,
): Promise<RetryOutcome<T>> {
  let lastError = '';
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const result = await handler();
      return { status: 'ok', attempts: attempt, result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < policy.maxAttempts) {
        await sleep(policy.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  await onDeadLetter(policy.maxAttempts, lastError);
  return { status: 'dead_lettered', attempts: policy.maxAttempts, error: lastError };
}

/**
 * Process one engine decision into a task with retry/backoff; poison messages are dead-lettered.
 * Task creation is exactly-once, so a retry that follows a partial failure will not duplicate.
 */
export class TaskProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 50 },
  ) {}

  processDecision(
    tenantId: string,
    eventId: string | null,
    decision: Decision,
    sleep?: Sleep,
  ): Promise<RetryOutcome<CreateResult>> {
    return processWithRetry(
      this.policy,
      () => withTenant(this.pool, tenantId, (c) => createTaskFromDecision(c, tenantId, eventId, decision)),
      (attempts, error) =>
        withTenant(this.pool, tenantId, (c) =>
          insertDeadLetter(c, tenantId, {
            source: 'task_processing',
            reference: eventId,
            payload: decision,
            error,
            attempts,
          }),
        ),
      sleep,
    );
  }
}
