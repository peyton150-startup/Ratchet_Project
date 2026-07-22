import type { Pool } from 'pg';
import { withTenant } from '../db';

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
    slaDueAt: r.sla_due_at,
    subject: r.subject,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, rule_key, rule_version, queue, template, priority, state, assignee,
                 sla_due_at, subject, created_at, updated_at`;

export interface TaskFilter {
  queue?: string;
  state?: string;
  limit?: number;
}

export async function listTasks(pool: Pool, tenantId: string, filter: TaskFilter): Promise<TaskView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.queue) {
      params.push(filter.queue);
      conditions.push(`queue = $${params.length}`);
    }
    if (filter.state) {
      params.push(filter.state);
      conditions.push(`state = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(filter.limit ?? 100, 500));
    const r = await c.query<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks ${where}
        ORDER BY priority DESC, created_at ASC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toView);
  });
}

export async function getTask(pool: Pool, tenantId: string, id: string): Promise<TaskView | null> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<TaskRow>(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
    return r.rowCount === 0 ? null : toView(r.rows[0]!);
  });
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
