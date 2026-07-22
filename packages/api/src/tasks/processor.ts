import type { Pool } from 'pg';
import { withTenant } from '../db';
import type { Decision } from '../rules/engine';
import {
  createTaskFromDecision,
  cancelTasksForApplication,
  insertDeadLetter,
  type CreateResult,
} from './service';

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

export type ProcessResult =
  | { kind: 'created'; task: CreateResult }
  | { kind: 'cancelled'; taskIds: string[] };

/**
 * Process one engine decision with retry/backoff; poison messages are dead-lettered. Dispatches on
 * the action kind: create_task creates a task (exactly-once, so retries never duplicate);
 * cancel_tasks cancels an application's non-terminal tasks (R12). The application is taken from the
 * decision subject (applicationId, falling back to entityId).
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
  ): Promise<RetryOutcome<ProcessResult>> {
    const handler = (): Promise<ProcessResult> =>
      withTenant(this.pool, tenantId, async (c): Promise<ProcessResult> => {
        if (decision.action.kind === 'cancel_tasks') {
          const applicationId =
            (decision.subject['applicationId'] as string | undefined) ??
            (decision.subject['entityId'] as string | undefined) ??
            '';
          const taskIds = await cancelTasksForApplication(c, applicationId);
          return { kind: 'cancelled', taskIds };
        }
        const task = await createTaskFromDecision(c, tenantId, eventId, decision);
        return { kind: 'created', task };
      });

    return processWithRetry(
      this.policy,
      handler,
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
