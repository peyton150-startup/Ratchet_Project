import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribe, parse } from 'graphql';
import { createRedis } from '../src/redis';
import { TaskPubSub } from '../src/pubsub';
import { schema } from '../src/graphql/schema';
import type { TaskView } from '../src/tasks/read';
import { adminPool, appPool, seedTenant } from './helpers';

const pubRedis = createRedis(process.env.REDIS_URL);
const pubsub = new TaskPubSub(pubRedis, process.env.REDIS_URL);

after(async () => {
  pubRedis.disconnect();
  await appPool.end();
  await adminPool.end();
});

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: randomUUID(),
    ruleKey: 'R1',
    ruleVersion: 1,
    queue: 'intake',
    template: 't',
    priority: 0,
    state: 'open',
    assignee: null,
    slaDueAt: null,
    subject: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

test('pubsub delivers a task change to the tenant subscriber', async () => {
  const tenantId = randomUUID();
  const sub = pubsub.subscribe(tenantId);
  await sub.ready();
  await pubsub.publish(tenantId, task({ state: 'claimed' }));
  const r = await withTimeout(sub.next(), 2000);
  assert.equal(r.value.state, 'claimed');
  await sub.return();
});

test('subscribers are tenant-isolated', async () => {
  const a = randomUUID();
  const b = randomUUID();
  const sub = pubsub.subscribe(a);
  await sub.ready();
  await pubsub.publish(b, task()); // different tenant
  await assert.rejects(withTimeout(sub.next(), 500), /timeout/);
  await sub.return();
});

test('queue filter only yields matching tasks', async () => {
  const tenantId = randomUUID();
  const sub = pubsub.subscribe(tenantId, 'underwriting');
  await sub.ready();
  await pubsub.publish(tenantId, task({ queue: 'intake' })); // filtered out
  await pubsub.publish(tenantId, task({ queue: 'underwriting', state: 'blocked' }));
  const r = await withTimeout(sub.next(), 2000);
  assert.equal(r.value.queue, 'underwriting');
  assert.equal(r.value.state, 'blocked');
  await sub.return();
});

test('subscription resolver enforces permission', async () => {
  const t = await seedTenant('sub-perm');
  const result = await subscribe({
    schema,
    document: parse('subscription { queueUpdated { id } }'),
    contextValue: { pool: appPool, tenantId: t.tenantId, role: 'integrator', pubsub },
  });
  assert.ok('errors' in result && result.errors);
  assert.equal(result.errors[0]!.extensions?.['code'], 'FORBIDDEN');
});

test('queueUpdated subscription receives a published change', async () => {
  const t = await seedTenant('sub-recv');
  const result = await subscribe({
    schema,
    document: parse('subscription { queueUpdated(queue: "intake") { id state queue } }'),
    contextValue: { pool: appPool, tenantId: t.tenantId, role: 'operator', pubsub },
  });
  assert.ok(Symbol.asyncIterator in result, 'subscribe returned an async iterator');
  const iterator = result as AsyncIterableIterator<{ data?: { queueUpdated: TaskView } }>;

  // Let the underlying Redis subscription become active before publishing.
  await new Promise((r) => setTimeout(r, 200));
  await pubsub.publish(t.tenantId, task({ queue: 'intake', state: 'claimed' }));

  const r = await withTimeout(iterator.next(), 2000);
  assert.equal(r.value.data?.queueUpdated.state, 'claimed');
  await iterator.return?.();
});
