import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db.js';
import { ACTIVE_STATES_SQL } from './stateSql.js';

// GraphQL-facing task shape (camelCase), mapped from the tasks table.
export interface TaskView {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  queue: string;
  template: string;
  priority: number;
  state: string;
  assignee: string | null;
  assigneeName: string | null;
  slaDueAt: Date | null;
  subject: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskRow {
  id: string;
  rule_key: string;
  rule_version: number;
  queue: string;
  template: string;
  priority: number;
  state: string;
  assignee: string | null;
  assignee_name: string | null;
  sla_due_at: Date | null;
  subject: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function toView(r: TaskRow): TaskView {
  return {
    id: r.id,
    ruleKey: r.rule_key,
    ruleVersion: r.rule_version,
    queue: r.queue,
    template: r.template,
    priority: r.priority,
    state: r.state,
    assignee: r.assignee,
    assigneeName: r.assignee_name,
    slaDueAt: r.sla_due_at,
    subject: r.subject,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// The agent's name rides along with every task read, so the console can show who a task is routed to
// without a separate agents API. LEFT JOIN: an unassigned task still has to come back.
const SELECT_TASKS = `SELECT t.id, t.rule_key, t.rule_version, t.queue, t.template, t.priority, t.state,
                             t.assignee, a.name AS assignee_name,
                             t.sla_due_at, t.subject, t.created_at, t.updated_at
                        FROM tasks t
                        LEFT JOIN agents a ON a.id = t.assignee`;

export interface TaskFilter {
  queue?: string;
  state?: string;
  /** Only tasks that can still be worked (open, claimed, blocked). */
  activeOnly?: boolean;
  limit?: number;
}

export async function listTasks(pool: Pool, tenantId: string, filter: TaskFilter): Promise<TaskView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.queue) {
      params.push(filter.queue);
      conditions.push(`t.queue = $${params.length}`);
    }
    if (filter.state) {
      params.push(filter.state);
      conditions.push(`t.state = $${params.length}`);
    }
    if (filter.activeOnly) conditions.push(`t.state IN (${ACTIVE_STATES_SQL})`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(filter.limit ?? 100, 500));
    const r = await c.query<TaskRow>(
      `${SELECT_TASKS} ${where}
        ORDER BY t.priority DESC, t.created_at ASC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toView);
  });
}

/** Read a task inside an existing tenant transaction (no new connection/transaction). */
export async function getTaskTx(client: PoolClient, id: string): Promise<TaskView | null> {
  const r = await client.query<TaskRow>(`${SELECT_TASKS} WHERE t.id = $1`, [id]);
  return r.rowCount === 0 ? null : toView(r.rows[0]!);
}

export async function getTask(pool: Pool, tenantId: string, id: string): Promise<TaskView | null> {
  return withTenant(pool, tenantId, (c) => getTaskTx(c, id));
}

export interface QueueView {
  name: string;
  strategy: string;
  requiredSkill: string | null;
  active: boolean;
}

export async function listQueues(pool: Pool, tenantId: string): Promise<QueueView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<{ name: string; strategy: string; required_skill: string | null; active: boolean }>(
      `SELECT name, strategy, required_skill, active FROM queues ORDER BY name`,
    );
    return r.rows.map((row) => ({
      name: row.name,
      strategy: row.strategy,
      requiredSkill: row.required_skill,
      active: row.active,
    }));
  });
}
