import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export interface PoolOptions {
  /** Max connections. Set per-process so the API and worker act as separate bulkheads. */
  max?: number;
  /** Server-side cap on any single statement — stops a runaway query holding a connection. */
  statementTimeoutMs?: number;
  /** Fail fast when the pool is exhausted rather than queueing forever. */
  connectionTimeoutMillis?: number;
  /** Cap on a session left idle inside a transaction (a common source of bloat under MVCC). */
  idleInTransactionTimeoutMs?: number;
}

/**
 * Pool with timeouts on every axis. Without these a single slow query holds a connection
 * indefinitely, callers queue behind it, and the pool becomes the bottleneck that takes the whole
 * service down (Nygard: blocked threads / slow responses). Idle-in-transaction is capped because
 * long transactions also block vacuum and grow bloat under MVCC.
 */
export function createPool(connectionString: string | undefined, opts: PoolOptions = {}): Pool {
  const statementTimeout = opts.statementTimeoutMs ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000);
  const idleInTx = opts.idleInTransactionTimeoutMs ?? Number(process.env.PG_IDLE_IN_TX_TIMEOUT_MS ?? 15_000);

  const pool = new Pool({
    connectionString,
    max: opts.max ?? Number(process.env.PG_POOL_MAX ?? 10),
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
    statement_timeout: statementTimeout,
    idle_in_transaction_session_timeout: idleInTx,
  });
  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });
  return pool;
}

/**
 * Run `fn` inside a transaction with the tenant RLS context set for its duration.
 * Uses SET LOCAL (via set_config(..., true)) so it is scoped to the transaction and
 * safe under transaction-level connection pooling (ADR-005 rule 2).
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
