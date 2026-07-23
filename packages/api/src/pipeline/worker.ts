// Runnable pipeline worker: relay the outbox to the stream, consume the stream into tasks
// (auto-assigned), periodically reclaim crashed-consumer messages, and run scheduled sweeps.
// The backoff policy is unit-tested in backoff.ts; the loop itself is not run by CI.
import { ADMIN_DATABASE_URL, DATABASE_URL } from '../config';
import { createPool } from '../db';
import { createRedis } from '../redis';
import { drainOutbox, redriveStaleOutbox } from './relay';
import { ensureGroup, consumeBatch, reclaimPending, type ConsumeDeps } from './consumer';
import { Scheduler } from './scheduler';
import { RulesEngine } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import { RoutingService } from '../routing/assign';
import { TaskPubSub } from '../pubsub';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import { log, metrics } from '../observability';
import { nextLoopState, IDLE_SLEEP_MS } from './backoff';

const STREAM = process.env.RATCHET_STREAM ?? 'ratchet:events';
const GROUP = process.env.RATCHET_GROUP ?? 'rules-workers';
const CONSUMER = process.env.HOSTNAME ?? 'worker-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const admin = createPool(ADMIN_DATABASE_URL);
  const app = createPool(DATABASE_URL);
  const redis = createRedis(process.env.REDIS_URL);
  const engine = new RulesEngine(app);
  const processor = new TaskProcessor(app);
  const routing = new RoutingService(app);
  const pubsub = new TaskPubSub(createRedis(process.env.REDIS_URL), process.env.REDIS_URL);
  const webhooks = new WebhookDispatcher(app);
  const scheduler = new Scheduler({ admin, engine, processor, routing });
  const deps: ConsumeDeps = { redis, appPool: app, engine, processor, routing, pubsub, webhooks };

  await ensureGroup(redis, STREAM, GROUP);
  log.info('pipeline worker started', { stream: STREAM, group: GROUP, consumer: CONSUMER });

  let running = true;
  let lastReclaim = 0;
  let lastSweep = 0;
  let lastRedrive = 0;
  let failures = 0;

  const shutdown = async (signal: string): Promise<void> => {
    if (!running) return;
    running = false;
    log.info('worker shutting down', { signal });
    try {
      redis.disconnect();
      await Promise.all([app.end(), admin.end()]);
    } catch (err) {
      log.error('error during worker shutdown', { error: String(err) });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  while (running) {
    let outcome: { ok: boolean; didWork: boolean };
    try {
      const relayed = await drainOutbox(admin, redis, { streamKey: STREAM });
      const processed = await consumeBatch(deps, { streamKey: STREAM, group: GROUP, consumer: CONSUMER });
      if (processed > 0) metrics.pipelineMessages.inc({}, processed);

      const now = Date.now();
      if (now - lastReclaim > 30_000) {
        await reclaimPending(deps, { streamKey: STREAM, group: GROUP, consumer: CONSUMER });
        lastReclaim = now;
      }
      if (now - lastSweep > 60_000) {
        await scheduler.runAll(new Date());
        lastSweep = now;
      }
      // Reconciliation: re-deliver outbox rows relayed but never consumed (stream trimmed/lost).
      if (now - lastRedrive > 60_000) {
        await redriveStaleOutbox(admin, redis, { streamKey: STREAM });
        lastRedrive = now;
      }
      outcome = { ok: true, didWork: relayed > 0 || processed > 0 };
    } catch (err) {
      // A transient Postgres/Redis failure must not kill the worker: without this the entire
      // pipeline stops silently on one blip. Back off exponentially and keep going.
      metrics.pipelineErrors.inc({});
      log.error('worker iteration failed; backing off', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: failures + 1,
      });
      outcome = { ok: false, didWork: false };
    }

    const state = nextLoopState(failures, outcome);
    failures = state.consecutiveFailures;
    if (state.backoffMs > 0) await sleep(state.backoffMs);
  }
}

main().catch((err) => {
  log.error('worker failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
