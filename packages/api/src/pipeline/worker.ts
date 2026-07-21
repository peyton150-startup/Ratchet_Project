// Runnable pipeline worker: relay the outbox to the stream, then consume the stream into tasks.
// Not exercised by CI (it's an infinite loop); the pieces it composes are tested in pipeline.test.ts.
import { ADMIN_DATABASE_URL, DATABASE_URL } from '../config';
import { createPool } from '../db';
import { createRedis } from '../redis';
import { drainOutbox } from './relay';
import { ensureGroup, consumeBatch } from './consumer';
import { RulesEngine } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';

const STREAM = process.env.RATCHET_STREAM ?? 'ratchet:events';
const GROUP = process.env.RATCHET_GROUP ?? 'rules-workers';
const CONSUMER = process.env.HOSTNAME ?? 'worker-1';

async function main(): Promise<void> {
  const admin = createPool(ADMIN_DATABASE_URL);
  const app = createPool(DATABASE_URL);
  const redis = createRedis(process.env.REDIS_URL);
  const engine = new RulesEngine(app);
  const processor = new TaskProcessor(app);

  await ensureGroup(redis, STREAM, GROUP);
  console.log(`pipeline worker started (stream=${STREAM}, group=${GROUP}, consumer=${CONSUMER})`);

  for (;;) {
    const relayed = await drainOutbox(admin, redis, { streamKey: STREAM });
    const processed = await consumeBatch(
      { redis, appPool: app, engine, processor },
      { streamKey: STREAM, group: GROUP, consumer: CONSUMER },
    );
    if (relayed === 0 && processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
