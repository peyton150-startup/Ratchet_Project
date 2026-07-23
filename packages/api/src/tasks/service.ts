import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';
import type { Decision } from '../rules/engine';
import { nextState, slaDueAt, type TaskAction, type TaskState } from './stateMachine';
import { ACTIVE_STATES_SQL, TERMINAL_STATES_SQL } from './stateSql';

export interface CreateResult {
  taskId: string;
  created: boolean;
}

/**
 * Raised when an INSERT loses the dedup race but the winning row is no longer matchable (e.g. a
 * scheduled task closed, or was purged, between our INSERT and the follow-up SELECT). It is
 * retryable: re-running the whole transaction re-inserts cleanly (and, for scheduled rules, correctly
 * re-fires now that the prior task is terminal).
 */
export class DedupRaceError extends Error {
  constructor(public readonly dedupKey: string) {
    super(`dedup conflict on ${dedupKey} but no matching row found (concurrent close/purge); retry`);
    this.name = 'DedupRaceError';
  }
}

function dedupKey(eventId: string | null, decision: Decision): string {
  if (eventId) return `${eventId}:${decision.ruleKey}`;
  // Scheduled rules: identify the subject. Prefer a stable business id; otherwise hash the whole
  // subject so distinct subjects never collapse onto one task (a bare 'na' fallback silently merged
  // every subject that lacked documentId/entityId into a single task).
  const subject =
    (decision.subject['documentId'] as string | undefined) ??
    (decision.subject['entityId'] as string | undefined) ??
    's:' + createHash('sha256').update(JSON.stringify(decision.subject ?? {})).digest('hex').slice(0, 32);
  return `${decision.ruleKey}:${subject}`;
}

/**
 * Create a task from a create_task decision. Event rules are exactly-once per (event, rule) for all
 * time (partial unique index tasks_dedup_event_uk). Scheduled rules keep at most one ACTIVE task per
 * (rule, subject) (partial unique index tasks_dedup_sched_uk) and re-fire once the prior task closes.
 * Concurrent or repeated calls collapse to a single task; losers return the existing id with
 * created=false. A lost race whose winner is no longer matchable raises DedupRaceError (retryable).
 */
export async function createTaskFromDecision(
  client: PoolClient,
  tenantId: string,
  eventId: string | null,
  decision: Decision,
  now: Date = new Date(),
): Promise<CreateResult> {
  if (decision.action.kind !== 'create_task') {
    throw new Error(`createTaskFromDecision requires a create_task action, got ${decision.action.kind}`);
  }
  const action = decision.action;
  const key = dedupKey(eventId, decision);
  const due = slaDueAt(now, action.sla);

  // The ON CONFLICT arbiter and the follow-up SELECT must target the SAME partial index as the path
  // being inserted, or the conflict is neither collapsed nor found.
  const scope =
    eventId !== null
      ? 'event_id IS NOT NULL'
      : `event_id IS NULL AND state IN (${ACTIVE_STATES_SQL})`;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks
       (tenant_id, dedup_key, rule_key, rule_version, event_id, queue, template, priority, subject, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, dedup_key) WHERE ${scope} DO NOTHING
     RETURNING id`,
    [
      tenantId,
      key,
      decision.ruleKey,
      decision.ruleVersion,
      eventId,
      action.queue,
      action.template,
      action.priority ?? 0,
      JSON.stringify(decision.subject),
      due.toISOString(),
    ],
  );

  if (inserted.rowCount && inserted.rowCount > 0) {
    return { taskId: inserted.rows[0]!.id, created: true };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM tasks WHERE tenant_id = $1 AND dedup_key = $2 AND ${scope}`,
    [tenantId, key],
  );
  const row = existing.rows[0];
  if (!row) throw new DedupRaceError(key);
  return { taskId: row.id, created: false };
}

/** Apply a state-machine transition to a task, enforcing legal transitions. */
export async function transitionTask(
  client: PoolClient,
  taskId: string,
  action: TaskAction,
): Promise<TaskState> {
  const current = await client.query<{ state: TaskState }>(
    `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  if (current.rowCount === 0) throw new Error(`task not found: ${taskId}`);
  const to = nextState(current.rows[0]!.state, action); // throws IllegalTransitionError
  await client.query(`UPDATE tasks SET state = $2, updated_at = now() WHERE id = $1`, [taskId, to]);
  return to;
}

/** Cancel all non-terminal tasks for an application (R12). Returns the cancelled task ids. */
export async function cancelTasksForApplication(
  client: PoolClient,
  applicationId: string,
): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `UPDATE tasks SET state = 'cancelled', updated_at = now()
      WHERE subject->>'applicationId' = $1 AND state IN (${ACTIVE_STATES_SQL})
    RETURNING id`,
    [applicationId],
  );
  return res.rows.map((r) => r.id);
}

export interface DeadLetterInput {
  source: string;
  reference: string | null;
  payload: unknown;
  error: string;
  attempts: number;
}

export async function insertDeadLetter(
  client: PoolClient,
  tenantId: string,
  rec: DeadLetterInput,
): Promise<void> {
  await client.query(
    `INSERT INTO dead_letter (tenant_id, source, reference, payload, error, attempts)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, rec.source, rec.reference, JSON.stringify(rec.payload ?? {}), rec.error, rec.attempts],
  );
}

/** Thin convenience wrapper that runs each operation in its own tenant transaction. */
export class TaskService {
  constructor(private readonly pool: Pool) {}

  createTask(tenantId: string, eventId: string | null, decision: Decision, now?: Date): Promise<CreateResult> {
    return withTenant(this.pool, tenantId, (c) => createTaskFromDecision(c, tenantId, eventId, decision, now));
  }

  transition(tenantId: string, taskId: string, action: TaskAction): Promise<TaskState> {
    return withTenant(this.pool, tenantId, (c) => transitionTask(c, taskId, action));
  }

  findBreached(tenantId: string, now: Date): Promise<string[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM tasks
          WHERE sla_due_at < $1 AND state NOT IN (${TERMINAL_STATES_SQL})`,
        [now.toISOString()],
      );
      return res.rows.map((r) => r.id);
    });
  }

  /** R12: cancel all non-terminal tasks for an application. Returns the cancelled task ids. */
  cancelForApplication(tenantId: string, applicationId: string): Promise<string[]> {
    return withTenant(this.pool, tenantId, (c) => cancelTasksForApplication(c, applicationId));
  }
}
