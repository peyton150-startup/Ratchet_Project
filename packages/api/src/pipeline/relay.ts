import type { Pool } from 'pg';
import type { Redis } from '../redis';

export interface RelayOptions {
  streamKey: string;
  batchSize?: number;
  maxLen?: number; // approximate MAXLEN cap for the stream
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_id: string;
  topic: string;
}

/**
 * Transactional-outbox relay (ADR-001). Drains pending outbox rows and pushes them to a Redis
 * Stream, then marks them relayed. Runs as a system process on an admin connection (bypasses RLS
 * to see all tenants — ADR-005 rule 5); the stream message carries tenant_id so the consumer
 * re-establishes tenant context. SKIP LOCKED lets multiple relays run safely.
 *
 * Delivery is at-least-once: XADD happens before the row is marked relayed, so a crash in between
 * re-drains the row (a duplicate the consumer collapses via exactly-once task creation).
 */
export async function drainOutbox(admin: Pool, redis: Redis, opts: RelayOptions): Promise<number> {
  const batchSize = opts.batchSize ?? 100;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<OutboxRow>(
      `SELECT id, tenant_id, event_id, topic
         FROM outbox
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const row of rows.rows) {
      // MAXLEN ~ bounds stream growth (approximate trim; consumed entries are the source of truth
      // for delivery, the event log is the source of truth for data).
      await redis.xadd(
        opts.streamKey,
        'MAXLEN',
        '~',
        opts.maxLen ?? 100_000,
        '*',
        'tenantId',
        row.tenant_id,
        'eventId',
        row.event_id,
        'topic',
        row.topic,
      );
      await client.query(`UPDATE outbox SET status = 'relayed', relayed_at = now() WHERE id = $1`, [
        row.id,
      ]);
    }
    await client.query('COMMIT');
    return rows.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
