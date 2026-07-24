/**
 * Dead-letter redrive — the operator half of the Dead Letter Channel. Re-enqueues dead-lettered
 * pipeline messages onto the stream for reprocessing. Safe to run repeatedly: task creation is
 * idempotent, and a message that still fails is simply dead-lettered again.
 *
 *   pnpm --filter @workspace/api redrive-dlq -- --limit 500
 *
 * Run it after you have fixed whatever caused the poison (a bad rule, a schema mismatch); left alone,
 * dead letters do not reprocess themselves.
 */
import { redriveDeadLetters } from '../src/pipeline/dlq';
import { createPool } from '../src/db';
import { createRedis } from '../src/redis';
import { log } from '../src/observability';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL must be set');
  const streamKey = arg('stream') ?? process.env.RATCHET_STREAM ?? 'ratchet:events';
  const source = arg('source') ?? 'pipeline';
  const limit = Number(arg('limit') ?? 100);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive number');

  const admin = createPool(connectionString);
  const redis = createRedis(process.env.REDIS_URL);
  try {
    const redriven = await redriveDeadLetters(admin, redis, { streamKey, source, limit });
    log.info('dead letters redriven', { source, redriven, streamKey });
  } finally {
    redis.disconnect();
    await admin.end();
  }
}

if (process.argv[1]?.includes('redriveDlq')) {
  main().catch((err) => {
    log.error('dlq redrive failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
