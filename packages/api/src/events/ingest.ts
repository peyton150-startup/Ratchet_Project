import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '../db';
import { entityTypeFor } from './eventTypes';
import type { EventInput } from './schema';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

/**
 * Append an event and its outbox row in a single transaction (ADR-001), guarded by an
 * idempotency key (ADR-005 tenant context applied via withTenant). Exactly-once effect:
 * the UNIQUE(tenant_id, idempotency_key) on event_idempotency collapses duplicates and
 * concurrent identical posts to a single event; losers return the winner's event id.
 */
export async function ingestEvent(
  pool: Pool,
  tenantId: string,
  input: EventInput,
): Promise<IngestResult> {
  return withTenant(pool, tenantId, async (client) => {
    const eventId = randomUUID();
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    const claimed = await client.query<{ event_id: string }>(
      `INSERT INTO event_idempotency (tenant_id, idempotency_key, event_id, occurred_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING event_id`,
      [tenantId, input.idempotencyKey, eventId, occurredAt],
    );

    if (claimed.rowCount === 0) {
      // Key already used (duplicate, or a concurrent poster committed first): return the winner.
      const existing = await client.query<{ event_id: string }>(
        `SELECT event_id FROM event_idempotency WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, input.idempotencyKey],
      );
      const winnerId = existing.rows[0]?.event_id ?? eventId;
      return { eventId: winnerId, duplicate: true };
    }

    await client.query(
      `INSERT INTO events
         (id, tenant_id, event_type, entity_type, entity_id, occurred_at, delta, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        tenantId,
        input.type,
        entityTypeFor(input.type),
        input.entityId,
        occurredAt,
        JSON.stringify(input.delta ?? {}),
        JSON.stringify(input.payload ?? {}),
      ],
    );

    await client.query(
      `INSERT INTO outbox (tenant_id, event_id, occurred_at, topic, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        eventId,
        occurredAt,
        'events',
        JSON.stringify({ eventId, type: input.type, entityId: input.entityId }),
      ],
    );

    return { eventId, duplicate: false };
  });
}
