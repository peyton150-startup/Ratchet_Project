import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskService } from '../src/tasks/service';
import { TaskProcessor, processWithRetry } from '../src/tasks/processor';
import { IllegalTransitionError } from '../src/tasks/stateMachine';
import type { Decision } from '../src/rules/engine';
import { adminPool, appPool, seedTenant } from './helpers';

const tasks = new TaskService(appPool);

after(async () => {
  await appPool.end();
  await adminPool.end();
});

function createDecision(overrides: Partial<Decision['action']> = {}): Decision {
  return {
    ruleKey: 'R1',
    ruleVersion: 1,
    action: {
      kind: 'create_task',
      queue: 'intake',
      sla: '4h',
      template: 'Initial completeness check',
      ...overrides,
    },
    subject: { entityId: 'app-1', applicationId: 'app-1' },
  };
}

async function taskState(id: string): Promise<string> {
  const r = await adminPool.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [id]);
  return r.rows[0]!.state;
}

// Exactly-once per (event, rule): concurrent + repeated creation collapse to one task.
test('exactly-once task creation per (event, rule)', async () => {
  const t = await seedTenant('tasks-eo');
  const eventId = randomUUID();
  const decision = createDecision();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => tasks.createTask(t.tenantId, eventId, decision)),
  );

  const ids = new Set(results.map((r) => r.taskId));
  assert.equal(ids.size, 1, 'all attempts resolve to one task id');
  assert.equal(results.filter((r) => r.created).length, 1, 'exactly one create won');

  const count = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM tasks WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(count.rows[0]!.c, 1);
});

// Illegal state transitions are rejected and leave the task unchanged; legal path works.
test('state machine enforces legal transitions', async () => {
  const t = await seedTenant('tasks-sm');
  const { taskId } = await tasks.createTask(t.tenantId, randomUUID(), createDecision());

  // Cannot complete an unclaimed (open) task.
  await assert.rejects(
    () => tasks.transition(t.tenantId, taskId, 'complete'),
    (err) => err instanceof IllegalTransitionError,
  );
  assert.equal(await taskState(taskId), 'open', 'state unchanged after illegal transition');

  // Legal path: open -> claimed -> completed.
  assert.equal(await tasks.transition(t.tenantId, taskId, 'claim'), 'claimed');
  assert.equal(await tasks.transition(t.tenantId, taskId, 'complete'), 'completed');

  // Cannot act on a terminal task.
  await assert.rejects(
    () => tasks.transition(t.tenantId, taskId, 'claim'),
    (err) => err instanceof IllegalTransitionError,
  );
});

// Poison message: a handler that always fails is retried then dead-lettered.
test('poison message is retried and dead-lettered', async () => {
  const t = await seedTenant('tasks-dlq');
  const processor = new TaskProcessor(appPool, { maxAttempts: 3, baseDelayMs: 0 });

  let calls = 0;
  const noopSleep = async () => {};
  const outcome = await processWithRetry(
    { maxAttempts: 3, baseDelayMs: 0 },
    async () => {
      calls += 1;
      throw new Error('boom');
    },
    async (attempts, error) => {
      const { insertDeadLetter } = await import('../src/tasks/service');
      const { withTenant } = await import('../src/db');
      await withTenant(appPool, t.tenantId, (c) =>
        insertDeadLetter(c, t.tenantId, {
          source: 'test',
          reference: null,
          payload: { poison: true },
          error,
          attempts,
        }),
      );
    },
    noopSleep,
  );

  assert.equal(outcome.status, 'dead_lettered');
  assert.equal(outcome.attempts, 3);
  assert.equal(calls, 3, 'handler attempted exactly maxAttempts times');

  const dl = await adminPool.query<{ c: number; attempts: number }>(
    'SELECT count(*)::int AS c, max(attempts) AS attempts FROM dead_letter WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(dl.rows[0]!.c, 1);
  assert.equal(dl.rows[0]!.attempts, 3);

  // Sanity: the processor's real path dead-letters a malformed decision (invalid SLA duration).
  const bad = createDecision({ sla: 'not-a-duration' });
  const res = await processor.processDecision(t.tenantId, randomUUID(), bad, noopSleep);
  assert.equal(res.status, 'dead_lettered');
});

// R12: a cancel_tasks decision cancels all of an application's non-terminal tasks.
test('processor cancels an application tasks on a cancel_tasks decision', async () => {
  const t = await seedTenant('tasks-r12');
  const proc = new TaskProcessor(appPool, { maxAttempts: 3, baseDelayMs: 0 });
  const forApp: Decision['subject'] = { entityId: 'app-9', applicationId: 'app-9' };

  await proc.processDecision(t.tenantId, randomUUID(), { ...createDecision(), subject: forApp });
  await proc.processDecision(t.tenantId, randomUUID(), { ...createDecision(), subject: forApp });

  const cancel: Decision = {
    ruleKey: 'R12',
    ruleVersion: 1,
    action: { kind: 'cancel_tasks', scope: 'application' },
    subject: forApp,
  };
  const res = await proc.processDecision(t.tenantId, randomUUID(), cancel);
  assert.equal(res.status, 'ok');
  assert.ok(res.result && res.result.kind === 'cancelled');
  assert.equal((res.result as { taskIds: string[] }).taskIds.length, 2);

  const cancelled = await adminPool.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM tasks WHERE tenant_id = $1 AND state = 'cancelled'",
    [t.tenantId],
  );
  assert.equal(cancelled.rows[0]!.c, 2);
});

// SLA due date is computed from the SLA string; breached tasks are found; priority is stored.
test('SLA timers and priority', async () => {
  const t = await seedTenant('tasks-sla');

  // Created "10h ago" with a 4h SLA -> due 6h ago -> breached.
  const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000);
  const breached = await tasks.createTask(
    t.tenantId,
    randomUUID(),
    createDecision({ sla: '4h', priority: 5 }),
    tenHoursAgo,
  );
  // A fresh task with a long SLA -> not breached.
  await tasks.createTask(t.tenantId, randomUUID(), { ...createDecision({ sla: '72h' }), ruleKey: 'R8', subject: { entityId: 'c-1' } });

  const breachedIds = await tasks.findBreached(t.tenantId, new Date());
  assert.deepEqual(breachedIds, [breached.taskId], 'only the overdue task is breached');

  const row = await adminPool.query<{ priority: number; sla_due_at: string }>(
    'SELECT priority, sla_due_at FROM tasks WHERE id = $1',
    [breached.taskId],
  );
  assert.equal(row.rows[0]!.priority, 5, 'priority stored');
  const due = new Date(row.rows[0]!.sla_due_at).getTime();
  assert.equal(due, tenHoursAgo.getTime() + 4 * 3_600_000, 'sla_due_at = created + 4h');
});
