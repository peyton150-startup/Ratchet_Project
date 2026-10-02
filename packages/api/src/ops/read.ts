import type { Pool } from 'pg';
import { withTenant } from '../db.js';
import { ACTIVE_STATES_SQL } from '../tasks/stateSql.js';

// Read models for the console's operations views: why a task exists (the rule audit trail), what
// failed for good (dead letters), and who work is routed to (agents). Read-only; every query runs
// in the caller's tenant transaction, so RLS scopes it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(limit ?? fallback, max));
}

// ---- rule audit --------------------------------------------------------------------------------

export interface AuditView {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  triggerType: string;
  eventId: string | null;
  /** The triggering event, when there was one and it is still within retention. */
  eventType: string | null;
  entityId: string | null;
  matched: boolean;
  decision: unknown;
  createdAt: Date;
}

export interface AuditFilter {
  ruleKey?: string;
  eventId?: string;
  /** Every rule evaluated for the event that created this task. */
  taskId?: string;
  limit?: number;
}

/**
 * Rule evaluations, newest first. Each event writes one row per rule it woke, matched or not, so
 * filtering by a task's event answers both "why does this task exist" and "which rules looked at
 * that event and declined".
 */
export async function listRuleAudit(pool: Pool, tenantId: string, filter: AuditFilter): Promise<AuditView[]> {
  // An id that is not a uuid cannot match anything; answer that rather than fail the uuid cast.
  if ((filter.eventId && !UUID.test(filter.eventId)) || (filter.taskId && !UUID.test(filter.taskId))) {
    return [];
  }
  return withTenant(pool, tenantId, async (c) => {
    const conditions = ['a.dry_run = false'];
    const params: unknown[] = [];
    if (filter.ruleKey) {
      params.push(filter.ruleKey);
      conditions.push(`a.rule_key = $${params.length}`);
    }
    if (filter.eventId) {
      params.push(filter.eventId);
      conditions.push(`a.event_id = $${params.length}`);
    }
    if (filter.taskId) {
      params.push(filter.taskId);
      // A scheduled task has no event, so the subquery is NULL and nothing matches.
      conditions.push(`a.event_id = (SELECT t.event_id FROM tasks t WHERE t.id = $${params.length})`);
    }
    params.push(clampLimit(filter.limit, 50, 200));
    const r = await c.query<{
      id: string;
      rule_key: string;
      rule_version: number;
      trigger_type: string;
      event_id: string | null;
      event_type: string | null;
      entity_id: string | null;
      matched: boolean;
      decision: unknown;
      created_at: Date;
    }>(
      `SELECT a.id, a.rule_key, a.rule_version, a.trigger_type, a.event_id, a.matched, a.decision,
              a.created_at, e.event_type, e.entity_id
         FROM rule_audit a
         LEFT JOIN events e ON e.id = a.event_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC, a.rule_key
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      id: row.id,
      ruleKey: row.rule_key,
      ruleVersion: row.rule_version,
      triggerType: row.trigger_type,
      eventId: row.event_id,
      eventType: row.event_type,
      entityId: row.entity_id,
      matched: row.matched,
      decision: row.decision,
      createdAt: row.created_at,
    }));
  });
}

// ---- dead letters ------------------------------------------------------------------------------

export interface DeadLetterView {
  id: string;
  source: string;
  reference: string | null;
  error: string;
  attempts: number;
  payload: unknown;
  createdAt: Date;
}

/** Messages that exhausted their retries, newest first. */
export async function listDeadLetters(pool: Pool, tenantId: string, limit?: number): Promise<DeadLetterView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<{
      id: string;
      source: string;
      reference: string | null;
      error: string;
      attempts: number;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT id, source, reference, error, attempts, payload, created_at
         FROM dead_letter
        ORDER BY created_at DESC
        LIMIT $1`,
      [clampLimit(limit, 50, 200)],
    );
    return r.rows.map((row) => ({
      id: row.id,
      source: row.source,
      reference: row.reference,
      error: row.error,
      attempts: row.attempts,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  });
}

// ---- agents ------------------------------------------------------------------------------------

export interface AgentView {
  id: string;
  name: string;
  skills: string[];
  capacity: number;
  /** Active (open, claimed or blocked) tasks routed to this agent: what capacity is measured against. */
  load: number;
  active: boolean;
  queues: string[];
  lastAssignedAt: Date | null;
}

export async function listAgents(pool: Pool, tenantId: string): Promise<AgentView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<{
      id: string;
      name: string;
      skills: string[];
      capacity: number;
      load: number;
      active: boolean;
      queues: string[];
      last_assigned_at: Date | null;
    }>(
      `SELECT a.id, a.name, a.skills, a.capacity, a.active, a.last_assigned_at,
              (SELECT count(*)::int FROM tasks t
                WHERE t.assignee = a.id AND t.state IN (${ACTIVE_STATES_SQL})) AS load,
              COALESCE((SELECT array_agg(m.queue ORDER BY m.queue) FROM queue_members m
                         WHERE m.agent_id = a.id), '{}') AS queues
         FROM agents a
        ORDER BY a.name`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      skills: row.skills,
      capacity: row.capacity,
      load: row.load,
      active: row.active,
      queues: row.queues,
      lastAssignedAt: row.last_assigned_at,
    }));
  });
}
