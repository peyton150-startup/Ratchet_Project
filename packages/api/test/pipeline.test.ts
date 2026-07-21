import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedis } from '../src/redis';
import { drainOutbox } from '../src/pipeline/relay';
import { ensureGroup, consumeBatch, type ConsumeDeps } from '../src/pipeline/consumer';
import { RulesEngine } from '../src/rules/engine';
import { TaskProcessor } from '../src/tasks/processor';
import { ingestEvent } from '../src/events/ingest';
import type { Rule } from '../src/rules/types';
import { adminPool, appPool, seedTenant, seedRule } from './helpers';

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
