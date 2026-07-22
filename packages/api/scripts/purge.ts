/**
 * Retention purge — the "steady state" requirement: a system must be able to run indefinitely
 * without a human intervening. rule_audit, webhook_deliveries, dead_letter and relayed outbox rows
 * are append-only and otherwise grow until the disk fills.
 *
 * Deletes are batched and capped so the purge never takes a long lock or a giant transaction
 * (a single huge DELETE is itself an outage risk). Run it on a schedule.
 *
 *   pnpm --filter @workspace/api purge -- --days 30
 *
 * Note: the events table is NOT purged here. It is the append-only source of truth and is
 * range-partitioned by month (ADR-002), so its retention is DETACH/DROP of an old partition —
 * cheaper and safer than row deletes. That job belongs with the partition automation.
 */
import { Client } from 'pg';
import { log } from '../src/observability';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface PurgeTarget {
  table: string;
  column: string;
  where?: string;
}

const TARGETS: PurgeTarget[] = [
  { table: 'rule_audit', column: 'created_at' },
  { table: 'webhook_deliveries', column: 'created_at' },
  { table: 'dead_letter', column: 'created_at' },
  // Relayed outbox rows have already been handed to the stream; only pending rows matter.
  { table: 'outbox', column: 'relayed_at', where: "status = 'relayed'" },
];

const BATCH_SIZE = 5_000;
const MAX_BATCHES = 200; // hard stop so one run cannot become unbounded work

export async function purgeTable(
  client: Client,
  target: PurgeTarget,
  days: number,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const res = await client.query(
      `DELETE FROM ${target.table}
        WHERE ctid IN (
          SELECT ctid FROM ${target.table}
           WHERE ${target.column} < now() - ($1 || ' days')::interval
             ${target.where ? `AND ${target.where}` : ''}
           LIMIT ${BATCH_SIZE}
        )`,
      [String(days)],
    );
    const count = res.rowCount ?? 0;
    deleted += count;
    if (count < BATCH_SIZE) break; // drained
  }
  return deleted;
}

async function main(): Promise<void> {
  const days = Number(arg('days') ?? process.env.RETENTION_DAYS ?? 30);
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive number');
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL must be set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const target of TARGETS) {
      const deleted = await purgeTable(client, target, days);
      log.info('purged', { table: target.table, olderThanDays: days, deleted });
    }
  } finally {
    await client.end();
  }
}

// Only run when invoked directly, so the batching logic can be imported by tests.
if (process.argv[1]?.includes('purge')) {
  main().catch((err) => {
    log.error('purge failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
