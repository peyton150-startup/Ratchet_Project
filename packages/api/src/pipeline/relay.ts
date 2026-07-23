import type { Pool } from 'pg';
import type { Redis } from '../redis';
import { metrics } from '../observability';

export interface RelayOptions {
  streamKey: string;
  batchSize?: number;
  maxLen?: number; // approximate MAXLEN cap for the stream
}

export interface RedriveOptions extends RelayOptions {
  /** Re-deliver rows relayed but not consumed at least this long ago (default 300s). */
  staleSeconds?: number;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_id: string;
  topic: string;
}

async function pushToStream(redis: Redis, row: OutboxRow, opts: RelayOptions): Promise<void> {
  // MAXLEN ~ bounds stream growth (approximate trim). Trimming is now safe: an entry lost before a
  // consumer processes it is re-delivered by redriveStaleOutbox from the outbox (Postgres is the
  // source of delivery truth), and idempotent task creation collapses the duplicate.
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
      await pushToStream(redis, row, opts);
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

/**
 * Reconciliation redrive (ADR-001, EIP Guaranteed Delivery). Re-delivers outbox rows that were
 * relayed but never marked consumed within `staleSeconds` — i.e. their stream entry was trimmed or
 * lost before a consumer processed it. Runs on the admin connection (cross-tenant, bypasses RLS),
 * same as the relay. `relayed_at` is bumped on each redrive so a row is not re-picked every tick;
 * idempotent task creation makes repeated delivery a no-op. A row that keeps coming back here is a
 * genuine stuck message worth alerting on (watch ratchet_outbox_redriven_total).
 */
export async function redriveStaleOutbox(
  admin: Pool,
  redis: Redis,
  opts: RedriveOptions,
): Promise<number> {
  const batchSize = opts.batchSize ?? 100;
  const staleSeconds = opts.staleSeconds ?? 300;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<OutboxRow>(
      `SELECT id, tenant_id, event_id, topic
         FROM outbox
        WHERE status = 'relayed'
          AND relayed_at < now() - ($2 || ' seconds')::interval
        ORDER BY relayed_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize, String(staleSeconds)],
    );
    for (const row of rows.rows) {
      await pushToStream(redis, row, opts);
      await client.query(`UPDATE outbox SET relayed_at = now() WHERE id = $1`, [row.id]);
    }
    await client.query('COMMIT');
    const n = rows.rowCount ?? 0;
    if (n > 0) metrics.outboxRedriven.inc({}, n);
    return n;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
