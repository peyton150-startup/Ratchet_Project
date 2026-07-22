// Runnable pipeline worker: relay the outbox to the stream, consume the stream into tasks
// (auto-assigned), periodically reclaim crashed-consumer messages, and run scheduled sweeps.
// Not exercised by CI (it's an infinite loop); the pieces it composes are tested individually.
import { ADMIN_DATABASE_URL, DATABASE_URL } from '../config';
import { createPool } from '../db';
import { createRedis } from '../redis';
import { drainOutbox } from './relay';
import { ensureGroup, consumeBatch, reclaimPending } from './consumer';
import { Scheduler } from './scheduler';
import { RulesEngine } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import { RoutingService } from '../routing/assign';

const STREAM = process.env.RATCHET_STREAM ?? 'ratchet:events';
const GROUP = process.env.RATCHET_GROUP ?? 'rules-workers';
const CONSUMER = process.env.HOSTNAME ?? 'worker-1';
const RECLAIM_EVERY_MS = 30_000;
const SWEEP_EVERY_MS = 60_000;

async function main(): Promise<void> {
  const admin = createPool(ADMIN_DATABASE_URL);
  const app = createPool(DATABASE_URL);
  const redis = createRedis(process.env.REDIS_URL);
  const engine = new RulesEngine(app);
  const processor = new TaskProcessor(app);
  const routing = new RoutingService(app);
  const scheduler = new Scheduler({ admin, engine, processor, routing });
  const deps = { redis, appPool: app, engine, processor, routing };

  await ensureGroup(redis, STREAM, GROUP);
  console.log(`pipeline worker started (stream=${STREAM}, group=${GROUP}, consumer=${CONSUMER})`);

  let lastReclaim = 0;
  let lastSweep = 0;
  for (;;) {
    const relayed = await drainOutbox(admin, redis, { streamKey: STREAM });
    const processed = await consumeBatch(deps, { streamKey: STREAM, group: GROUP, consumer: CONSUMER });

    const now = Date.now();
    if (now - lastReclaim > RECLAIM_EVERY_MS) {
      await reclaimPending(deps, { streamKey: STREAM, group: GROUP, consumer: CONSUMER });
      lastReclaim = now;
    }
    if (now - lastSweep > SWEEP_EVERY_MS) {
      await scheduler.runAll(new Date());
      lastSweep = now;
    }
    if (relayed === 0 && processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
