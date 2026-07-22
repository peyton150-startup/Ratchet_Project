import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedis } from '../src/redis';
import { drainOutbox } from '../src/pipeline/relay';
import { ensureGroup, consumeBatch, reclaimPending, type ConsumeDeps } from '../src/pipeline/consumer';
import { Scheduler } from '../src/pipeline/scheduler';
import { RulesEngine } from '../src/rules/engine';
import { TaskProcessor } from '../src/tasks/processor';
import { RoutingService } from '../src/routing/assign';
import { ingestEvent } from '../src/events/ingest';
import type { Rule } from '../src/rules/types';
import { adminPool, appPool, seedTenant, seedRule, seedEvent } from './helpers';

const redis = createRedis(process.env.REDIS_URL);
const engine = new RulesEngine(appPool);
const processor = new TaskProcessor(appPool, { maxAttempts: 3, baseDelayMs: 0 });
const deps: ConsumeDeps = { redis, appPool, engine, processor };

after(async () => {
  await redis.quit();
  await appPool.end();
  await adminPool.end();
});

const r1: Rule = {
  ruleKey: 'R1',
  version: 1,
  trigger: { type: 'event', event: 'application.submitted' },
  condition: null,
  action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial completeness check' },
};

async function taskCount(tenantId: string): Promise<number> {
  const r = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM tasks WHERE tenant_id = $1',
    [tenantId],
  );
  return r.rows[0]!.c;
}

// End-to-end: ingest -> outbox -> relay -> stream -> consumer -> engine -> task.
test('outbox relay drives an event through to a task', async () => {
  const t = await seedTenant('pipe');
  await seedRule(t.tenantId, r1);
  const stream = `ratchet:test:${randomUUID()}`;
  const group = 'g1';
  await ensureGroup(redis, stream, group);

  await ingestEvent(appPool, t.tenantId, {
    idempotencyKey: 'p-1',
    type: 'application.submitted',
    entityId: 'app-1',
    payload: {},
  });

  // The relay is a global system process (drains all tenants), so assert on our tenant's outcome,
  // not global relay/consume counts, which other concurrent tests also contribute to.
  const relayed = await drainOutbox(adminPool, redis, { streamKey: stream });
  assert.ok(relayed >= 1, 'at least our outbox row was relayed');

  await consumeBatch(deps, { streamKey: stream, group, consumer: 'c1' });
  assert.equal(await taskCount(t.tenantId), 1, 'a task was created from our event');

  // Reprocessing is safe: relay + consume again, still exactly one task for our tenant (exactly-once).
  await drainOutbox(adminPool, redis, { streamKey: stream });
  await consumeBatch(deps, { streamKey: stream, group, consumer: 'c1' });
  assert.equal(await taskCount(t.tenantId), 1, 'still exactly one task for our tenant');
});

// A message whose event cannot be found is dead-lettered and acked (no poison loop).
test('pipeline dead-letters a message whose event is missing', async () => {
  const t = await seedTenant('pipe-dlq');
  const stream = `ratchet:test:${randomUUID()}`;
  const group = 'g1';
  await ensureGroup(redis, stream, group);

  await redis.xadd(stream, '*', 'tenantId', t.tenantId, 'eventId', randomUUID(), 'topic', 'events');

  const processed = await consumeBatch(deps, { streamKey: stream, group, consumer: 'c1' });
  assert.equal(processed, 1);

  const dl = await adminPool.query<{ c: number; source: string }>(
    "SELECT count(*)::int AS c, max(source) AS source FROM dead_letter WHERE tenant_id = $1",
    [t.tenantId],
  );
  assert.equal(dl.rows[0]!.c, 1);
  assert.equal(dl.rows[0]!.source, 'pipeline');
  assert.equal(await taskCount(t.tenantId), 0, 'no task created for a missing event');
});

// Auto-assignment: when routing is supplied, a created task is assigned to an eligible agent.
test('consumer auto-assigns created tasks when routing is configured', async () => {
  const t = await seedTenant('pipe-assign');
  await seedRule(t.tenantId, r1);
  const agent = await adminPool.query<{ id: string }>(
    "INSERT INTO agents (tenant_id, name) VALUES ($1, 'A') RETURNING id",
    [t.tenantId],
  );
  const agentId = agent.rows[0]!.id;
  await adminPool.query(
    "INSERT INTO queues (tenant_id, name, strategy) VALUES ($1, 'intake', 'round_robin')",
    [t.tenantId],
  );
  await adminPool.query(
    "INSERT INTO queue_members (tenant_id, queue, agent_id) VALUES ($1, 'intake', $2)",
    [t.tenantId, agentId],
  );

  const stream = `ratchet:test:${randomUUID()}`;
  const group = 'g1';
  await ensureGroup(redis, stream, group);
  await ingestEvent(appPool, t.tenantId, {
    idempotencyKey: 'pa-1',
    type: 'application.submitted',
    entityId: 'app-1',
    payload: {},
  });
  await drainOutbox(adminPool, redis, { streamKey: stream });
  const depsWithRouting: ConsumeDeps = { redis, appPool, engine, processor, routing: new RoutingService(appPool) };
  await consumeBatch(depsWithRouting, { streamKey: stream, group, consumer: 'c1' });

  const r = await adminPool.query<{ assignee: string | null }>(
    'SELECT assignee FROM tasks WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0]!.assignee, agentId, 'task auto-assigned to the only eligible agent');
});

// PEL reclaim: a message read by a consumer that crashed before ack is recovered and processed.
test('reclaimPending reprocesses a message stuck in the pending list', async () => {
  const t = await seedTenant('pipe-pel');
  await seedRule(t.tenantId, r1);
  const stream = `ratchet:test:${randomUUID()}`;
  const group = 'g1';
  await ensureGroup(redis, stream, group);
  await ingestEvent(appPool, t.tenantId, {
    idempotencyKey: 'pel-1',
    type: 'application.submitted',
    entityId: 'app-1',
    payload: {},
  });
  await drainOutbox(adminPool, redis, { streamKey: stream });

  // Simulate a consumer that read the message but crashed before processing/acking.
  await redis.xreadgroup('GROUP', group, 'crashed', 'COUNT', 50, 'STREAMS', stream, '>');
  assert.equal(await taskCount(t.tenantId), 0, 'not processed by the crashed consumer');

  const reclaimed = await reclaimPending(deps, { streamKey: stream, group, consumer: 'rescuer', minIdleMs: 0 });
  assert.ok(reclaimed >= 1);
  assert.equal(await taskCount(t.tenantId), 1, 'reclaimed message produced the task');
});

// Scheduler drives an R11 sweep all the way to a task (engine -> processor).
test('scheduler runs an R11 sweep into a task', async () => {
  const t = await seedTenant('pipe-sched');
  await seedEvent(t.tenantId, {
    type: 'application.updated',
    entityId: 'app-s',
    payload: { stage: 'underwriting' },
    occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  });
  await seedEvent(t.tenantId, {
    type: 'document.uploaded',
    entityId: 'doc-s',
    payload: { applicationId: 'app-s', documentId: 'doc-s', issuedDate: new Date(Date.now() - 90 * 86_400_000).toISOString() },
  });
  await seedRule(t.tenantId, {
    ruleKey: 'R11',
    version: 1,
    trigger: { type: 'schedule', cron: '0 0 * * *', scan: 'stale_documents_at_underwriting' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '24h', template: 'Request updated document' },
  });

  const scheduler = new Scheduler({ admin: adminPool, engine, processor });
  const n = await scheduler.runForTenant(t.tenantId, new Date());
  assert.equal(n, 1, 'one scheduled decision');
  assert.equal(await taskCount(t.tenantId), 1, 'sweep created a task');
});
