import type { Pool } from 'pg';
import type { Redis } from '../redis';

export interface DlqRedriveOptions {
  streamKey: string;
  /** Max rows to re-drive in one call (default 100). */
  limit?: number;
  /** Which dead-letter source to re-drive (default 'pipeline'). */
  source?: string;
}

interface DlqRow {
  id: string;
  tenant_id: string;
  reference: string | null;
}

/**
 * Re-drive dead-lettered pipeline messages back onto the stream for reprocessing — the missing half
 * of the EIP Dead Letter Channel (a DLQ you can only write to is a data grave). Runs on the admin
 * connection (cross-tenant, bypasses RLS), like the outbox relay. Re-enqueue is safe because task
 * creation is idempotent: a message that now succeeds creates its task; one that still fails is simply
 * dead-lettered again. Rows are deleted only after a successful re-enqueue, inside the same
 * transaction, so a crash mid-flight leaves the row to be re-driven next run.
 *
 * Deliberately on-demand (CLI / operator action), never auto-looped in the worker, so a genuine
 * poison message cannot re-drive itself forever.
 */
export async function redriveDeadLetters(
  admin: Pool,
  redis: Redis,
  opts: DlqRedriveOptions,
): Promise<number> {
  const limit = opts.limit ?? 100;
  const source = opts.source ?? 'pipeline';
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<DlqRow>(
      `SELECT id, tenant_id, reference
         FROM dead_letter
        WHERE source = $2 AND reference IS NOT NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit, source],
    );
    let redriven = 0;
    for (const row of rows.rows) {
      await redis.xadd(
        opts.streamKey,
        '*',
        'tenantId',
        row.tenant_id,
        'eventId',
        row.reference!,
        'topic',
        'events',
      );
      await client.query('DELETE FROM dead_letter WHERE id = $1', [row.id]);
      redriven += 1;
    }
    await client.query('COMMIT');
    return redriven;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
