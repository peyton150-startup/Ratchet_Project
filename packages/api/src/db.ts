import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export function createPool(connectionString: string | undefined): Pool {
  const pool = new Pool({ connectionString });
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
