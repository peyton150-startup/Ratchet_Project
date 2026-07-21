import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';
import type { Decision } from '../rules/engine';
import { nextState, slaDueAt, type TaskAction, type TaskState } from './stateMachine';

export interface CreateResult {
  taskId: string;
  created: boolean;
}

function dedupKey(eventId: string | null, decision: Decision): string {
  if (eventId) return `${eventId}:${decision.ruleKey}`;
  const subject =
    (decision.subject['documentId'] as string | undefined) ??
    (decision.subject['entityId'] as string | undefined) ??
    'na';
  return `${decision.ruleKey}:${subject}`;
}

/**
 * Create a task from a create_task decision, exactly-once per (event, rule) — or per
 * (rule, subject) for scheduled rules — via UNIQUE(tenant_id, dedup_key). Concurrent or repeated
 * calls collapse to a single task; losers return the existing task id with created=false.
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

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks
       (tenant_id, dedup_key, rule_key, rule_version, event_id, queue, template, priority, subject, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, dedup_key) DO NOTHING
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
    `SELECT id FROM tasks WHERE tenant_id = $1 AND dedup_key = $2`,
    [tenantId, key],
  );
  return { taskId: existing.rows[0]!.id, created: false };
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
          WHERE sla_due_at < $1 AND state NOT IN ('completed', 'cancelled')`,
        [now.toISOString()],
      );
      return res.rows.map((r) => r.id);
    });
  }

  /** R12: cancel all non-terminal tasks for an application. Returns the cancelled task ids. */
  cancelForApplication(tenantId: string, applicationId: string): Promise<string[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `UPDATE tasks SET state = 'cancelled', updated_at = now()
          WHERE subject->>'applicationId' = $1 AND state IN ('open', 'claimed', 'blocked')
        RETURNING id`,
        [applicationId],
      );
      return res.rows.map((r) => r.id);
    });
  }
}
