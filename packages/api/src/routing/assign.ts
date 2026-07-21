import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';

export type Strategy = 'round_robin' | 'skill_tag' | 'capacity';

export interface AssignResult {
  assigned: boolean;
  agentId?: string;
  reason?: string;
}

interface Candidate {
  id: string;
  capacity: number;
  load: number;
  skills: string[];
  lastAssignedAt: Date | null;
}

interface QueueConfig {
  strategy: Strategy;
  requiredSkill: string | null;
}

async function loadQueue(client: PoolClient, queue: string): Promise<QueueConfig | null> {
  const r = await client.query<{ strategy: Strategy; required_skill: string | null }>(
    `SELECT strategy, required_skill FROM queues WHERE name = $1 AND active`,
    [queue],
  );
  if (r.rowCount === 0) return null;
  return { strategy: r.rows[0]!.strategy, requiredSkill: r.rows[0]!.required_skill };
}

async function loadCandidates(client: PoolClient, queue: string): Promise<Candidate[]> {
  const r = await client.query<{
    id: string;
    capacity: number;
    load: number;
    skills: string[];
    last_assigned_at: Date | null;
  }>(
    `SELECT a.id, a.capacity, a.skills, a.last_assigned_at,
            (SELECT count(*)::int FROM tasks t
              WHERE t.assignee = a.id AND t.state IN ('open','claimed','blocked')) AS load
       FROM agents a
       JOIN queue_members m ON m.agent_id = a.id AND m.queue = $1
      WHERE a.active`,
    [queue],
  );
  return r.rows.map((row) => ({
    id: row.id,
    capacity: row.capacity,
    load: row.load,
    skills: row.skills,
    lastAssignedAt: row.last_assigned_at,
  }));
}

// Round-robin fairness: least-recently-assigned first (nulls first), id as a deterministic tiebreak.
function byRoundRobin(a: Candidate, b: Candidate): number {
  const at = a.lastAssignedAt?.getTime() ?? -1;
  const bt = b.lastAssignedAt?.getTime() ?? -1;
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : 1;
}

function pick(strategy: Strategy, requiredSkill: string | null, candidates: Candidate[]): Candidate | null {
  let eligible = candidates;
  if (strategy === 'skill_tag') {
    eligible = requiredSkill ? candidates.filter((c) => c.skills.includes(requiredSkill)) : [];
  } else if (strategy === 'capacity') {
    eligible = candidates.filter((c) => c.load < c.capacity);
  }
  if (eligible.length === 0) return null;

  if (strategy === 'capacity') {
    // Most remaining capacity first, then round-robin fairness as a tiebreak.
    return [...eligible].sort((a, b) => {
      const ra = a.capacity - a.load;
      const rb = b.capacity - b.load;
      if (ra !== rb) return rb - ra;
      return byRoundRobin(a, b);
    })[0]!;
  }
  return [...eligible].sort(byRoundRobin)[0]!;
}

/**
 * Assign one task to an eligible agent in its queue using the queue's strategy. Returns
 * {assigned:false} with a reason when the queue is unconfigured, the task is terminal, or no agent
 * is eligible. Updates the agent's last_assigned_at so round-robin rotates.
 */
export async function assignTask(
  client: PoolClient,
  taskId: string,
): Promise<AssignResult> {
  const task = await client.query<{ queue: string; state: string }>(
    `SELECT queue, state FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  if (task.rowCount === 0) return { assigned: false, reason: 'task_not_found' };
  if (['completed', 'cancelled'].includes(task.rows[0]!.state)) {
    return { assigned: false, reason: 'task_terminal' };
  }

  const queue = await loadQueue(client, task.rows[0]!.queue);
  if (!queue) return { assigned: false, reason: 'queue_not_configured' };

  const candidates = await loadCandidates(client, task.rows[0]!.queue);
  const chosen = pick(queue.strategy, queue.requiredSkill, candidates);
  if (!chosen) return { assigned: false, reason: 'no_eligible_agent' };

  await client.query(`UPDATE tasks SET assignee = $2, assigned_at = now() WHERE id = $1`, [
    taskId,
    chosen.id,
  ]);
  await client.query(`UPDATE agents SET last_assigned_at = now() WHERE id = $1`, [chosen.id]);
  return { assigned: true, agentId: chosen.id };
}

/** Convenience wrapper that assigns within a tenant transaction. */
export class RoutingService {
  constructor(private readonly pool: Pool) {}

  assign(tenantId: string, taskId: string): Promise<AssignResult> {
    return withTenant(this.pool, tenantId, (c) => assignTask(c, taskId));
  }
}
