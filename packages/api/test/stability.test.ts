import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, withTimeout, TimeoutError } from '../src/stability';
import { WebhookDispatcher, type Sender } from '../src/webhooks/dispatcher';
import type { Resolver } from '../src/webhooks/urlGuard';
import { adminPool, appPool, seedTenant } from './helpers';

const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

after(async () => {
  await appPool.end();
  await adminPool.end();
});

// ---- timeouts --------------------------------------------------------------------------------

test('withTimeout rejects a call that never settles', async () => {
  const hangs = new Promise<string>(() => {}); // never resolves — models a hung endpoint
  await assert.rejects(withTimeout(hangs, 20), (err) => err instanceof TimeoutError);
});

test('withTimeout passes through a fast result and a fast failure', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100), /boom/);
});

// ---- circuit breaker -------------------------------------------------------------------------

test('circuit opens after the failure threshold and fails fast', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
  assert.equal(breaker.canAttempt('a'), true);

  breaker.recordFailure('a');
  breaker.recordFailure('a');
  assert.equal(breaker.state('a'), 'closed', 'still closed below the threshold');
  assert.equal(breaker.canAttempt('a'), true);

  breaker.recordFailure('a');
  assert.equal(breaker.state('a'), 'open');
  assert.equal(breaker.canAttempt('a'), false, 'open circuit fails fast');
});

test('circuit half-opens after the reset window and closes on success', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
  const t0 = 10_000;
  breaker.recordFailure('a', t0);
  assert.equal(breaker.canAttempt('a', t0 + 500), false, 'still open inside the window');

  assert.equal(breaker.canAttempt('a', t0 + 1500), true, 'probe allowed after the window');
  assert.equal(breaker.state('a'), 'half-open');

  breaker.recordSuccess('a');
  assert.equal(breaker.state('a'), 'closed', 'a successful probe closes the circuit');
});

test('a failed probe re-opens the circuit', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
  const t0 = 10_000;
  breaker.recordFailure('a', t0);
  breaker.canAttempt('a', t0 + 1500); // -> half-open
  breaker.recordFailure('a', t0 + 1600);
  assert.equal(breaker.state('a'), 'open');
  assert.equal(breaker.canAttempt('a', t0 + 1700), false);
});

test('circuits are isolated per target', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
  breaker.recordFailure('dead-endpoint');
  assert.equal(breaker.canAttempt('dead-endpoint'), false);
  assert.equal(breaker.canAttempt('healthy-endpoint'), true, 'one bad target does not affect others');
});

// ---- dispatcher integration ------------------------------------------------------------------

test('dispatcher stops calling an endpoint once its circuit opens', async () => {
  const t = await seedTenant('breaker');
  await adminPool.query(
    "INSERT INTO webhooks (tenant_id, url, secret, events) VALUES ($1, 'https://dead.example.com/hook', 's', $2)",
    [t.tenantId, ['task.created']],
  );

  let calls = 0;
  const failing: Sender = async () => {
    calls += 1;
    return { status: 500 };
  };
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
  const dispatcher = new WebhookDispatcher(
    appPool,
    { maxAttempts: 2, baseDelayMs: 0 },
    failing,
    async () => {},
    publicResolver,
    breaker,
  );

  await dispatcher.dispatch(t.tenantId, 'task.created', { id: 1 });
  const afterFirst = calls;
  assert.ok(afterFirst > 0, 'first dispatch attempts delivery');

  // Circuit is now open: the second dispatch must not touch the network at all.
  await dispatcher.dispatch(t.tenantId, 'task.created', { id: 2 });
  assert.equal(calls, afterFirst, 'no further calls once the circuit is open');

  const rows = await adminPool.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM webhook_deliveries WHERE tenant_id = $1 AND status = 'failed'",
    [t.tenantId],
  );
  assert.equal(rows.rows[0]!.c, 2, 'both attempts are recorded as failed deliveries');
});

test('a hanging endpoint is timed out rather than blocking the worker', async () => {
  const t = await seedTenant('wh-timeout');
  await adminPool.query(
    "INSERT INTO webhooks (tenant_id, url, secret, events) VALUES ($1, 'https://slow.example.com/hook', 's', $2)",
    [t.tenantId, ['task.created']],
  );

  const hanging: Sender = () => new Promise(() => {}); // never settles
  const dispatcher = new WebhookDispatcher(
    appPool,
    { maxAttempts: 1, baseDelayMs: 0 },
    hanging,
    async () => {},
    publicResolver,
    new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1000 }),
    25, // 25ms timeout
  );

  const started = Date.now();
  await dispatcher.dispatch(t.tenantId, 'task.created', { id: 1 });
  assert.ok(Date.now() - started < 2000, 'dispatch returned instead of hanging');

  const rows = await adminPool.query<{ status: string }>(
    'SELECT status FROM webhook_deliveries WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(rows.rows[0]!.status, 'failed');
});

// ---- database constraints --------------------------------------------------------------------

test('the database rejects an invalid task state', async () => {
  const t = await seedTenant('chk-state');
  await assert.rejects(
    adminPool.query(
      `INSERT INTO tasks (tenant_id, dedup_key, rule_key, rule_version, queue, template, state)
       VALUES ($1, 'chk-1', 'R1', 1, 'intake', 'tpl', 'not-a-real-state')`,
      [t.tenantId],
    ),
    /tasks_state_chk/,
    'the state machine is enforced by the database, not just the app',
  );
});

test('the database rejects an invalid queue strategy and non-positive capacity', async () => {
  const t = await seedTenant('chk-routing');
  await assert.rejects(
    adminPool.query("INSERT INTO queues (tenant_id, name, strategy) VALUES ($1, 'q', 'telepathy')", [
      t.tenantId,
    ]),
    /queues_strategy_chk/,
  );
  await assert.rejects(
    adminPool.query("INSERT INTO agents (tenant_id, name, capacity) VALUES ($1, 'A', 0)", [t.tenantId]),
    /agents_capacity_positive/,
  );
});
