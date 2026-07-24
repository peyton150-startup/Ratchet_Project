import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '../db';
import { entityTypeFor } from './eventTypes';
import type { EventInput } from './schema';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

/** Raised when an idempotency key is reused with a different request body. */
export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key reused with a different payload: ${idempotencyKey}`);
    this.name = 'IdempotencyConflictError';
  }
}

// Stable serialization (sorted keys) so the same logical body always hashes the same.
function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalize(o[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v ?? null);
}

function requestHash(input: EventInput): string {
  return createHash('sha256')
    .update(
      canonicalize({
        type: input.type,
        entityId: input.entityId,
        occurredAt: input.occurredAt ?? null,
        schemaVersion: input.schemaVersion ?? 1,
        delta: input.delta ?? {},
        payload: input.payload ?? {},
      }),
    )
    .digest('hex');
}

/**
 * Append an event and its outbox row in a single transaction (ADR-001), guarded by an idempotency
 * key. Exactly-once effect: UNIQUE(tenant_id, idempotency_key) collapses duplicates and concurrent
 * identical posts to a single event. A reused key with the SAME body replays (duplicate:true); a
 * reused key with a DIFFERENT body raises IdempotencyConflictError (surfaced as 409).
 */
export async function ingestEvent(
  pool: Pool,
  tenantId: string,
  input: EventInput,
): Promise<IngestResult> {
  return withTenant(pool, tenantId, async (client) => {
    const eventId = randomUUID();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const hash = requestHash(input);

    const claimed = await client.query<{ event_id: string }>(
      `INSERT INTO event_idempotency (tenant_id, idempotency_key, event_id, occurred_at, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING event_id`,
      [tenantId, input.idempotencyKey, eventId, occurredAt, hash],
    );

    if (claimed.rowCount === 0) {
      // Key already used (duplicate, concurrent poster, or a mismatched retry): compare fingerprints.
      const existing = await client.query<{ event_id: string; request_hash: string | null }>(
        `SELECT event_id, request_hash FROM event_idempotency
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, input.idempotencyKey],
      );
      const row = existing.rows[0];
      const storedHash = row?.request_hash ?? null;
      // storedHash null = legacy row without a fingerprint: treat as a replay, never a false conflict.
      if (storedHash !== null && storedHash !== hash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return { eventId: row?.event_id ?? eventId, duplicate: true };
    }

    await client.query(
      `INSERT INTO events
         (id, tenant_id, event_type, entity_type, entity_id, occurred_at, schema_version, delta, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        eventId,
        tenantId,
        input.type,
        entityTypeFor(input.type),
        input.entityId,
        occurredAt,
        input.schemaVersion ?? 1,
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
