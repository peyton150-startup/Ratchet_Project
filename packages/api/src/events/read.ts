import type { Pool } from 'pg';
import { withTenant } from '../db';

export interface EventView {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  delta: Record<string, unknown>;
  payload: Record<string, unknown>;
}

interface EventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  occurred_at: Date;
  delta: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function toView(r: EventRow): EventView {
  return {
    id: r.id,
    type: r.event_type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    occurredAt: r.occurred_at,
    delta: r.delta,
    payload: r.payload,
  };
}

/**
 * Event history for one entity, newest first — powers the console's task-detail view. Tenant-scoped
 * by RLS; uses the (tenant_id, entity_id) index from ADR-002.
 */
export async function listEventsForEntity(
  pool: Pool,
  tenantId: string,
  entityId: string,
  limit = 50,
): Promise<EventView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<EventRow>(
      `SELECT id, event_type, entity_type, entity_id, occurred_at, delta, payload
         FROM events
        WHERE entity_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [entityId, Math.min(limit, 200)],
    );
    return r.rows.map(toView);
  });
}
