import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoutingService, type Strategy } from '../src/routing/assign';
import { adminPool, appPool, seedTenant } from './helpers';

const routing = new RoutingService(appPool);

after(async () => {
  await appPool.end();
  await adminPool.end();
});

async function seedAgent(
  tenantId: string,
  name: string,
  skills: string[] = [],
  capacity = 5,
): Promise<string> {
  const r = await adminPool.query<{ id: string }>(
    'INSERT INTO agents (tenant_id, name, skills, capacity) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, name, skills, capacity],
  );
  return r.rows[0]!.id;
}

async function seedQueue(
  tenantId: string,
  name: string,
  strategy: Strategy,
  requiredSkill: string | null = null,
): Promise<void> {
  await adminPool.query(
    'INSERT INTO queues (tenant_id, name, strategy, required_skill) VALUES ($1, $2, $3, $4)',
    [tenantId, name, strategy, requiredSkill],
  );
}

async function addMember(tenantId: string, queue: string, agentId: string): Promise<void> {
  await adminPool.query(
    'INSERT INTO queue_members (tenant_id, queue, agent_id) VALUES ($1, $2, $3)',
    [tenantId, queue, agentId],
  );
}

async function seedTask(tenantId: string, queue: string): Promise<string> {
  const r = await adminPool.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, dedup_key, rule_key, rule_version, queue, template)
     VALUES ($1, $2, 'R1', 1, $3, 'tpl') RETURNING id`,
    [tenantId, randomUUID(), queue],
  );
  return r.rows[0]!.id;
}

async function loadByAgent(tenantId: string): Promise<Record<string, number>> {
  const r = await adminPool.query<{ assignee: string; c: number }>(
    `SELECT assignee, count(*)::int AS c FROM tasks
      WHERE tenant_id = $1 AND assignee IS NOT NULL GROUP BY assignee`,
    [tenantId],
  );
  return Object.fromEntries(r.rows.map((row) => [row.assignee, row.c]));
}

test('round_robin distributes evenly across agents', async () => {
  const t = await seedTenant('rr');
  const a = await seedAgent(t.tenantId, 'A');
  const b = await seedAgent(t.tenantId, 'B');
  await seedQueue(t.tenantId, 'intake', 'round_robin');
  await addMember(t.tenantId, 'intake', a);
  await addMember(t.tenantId, 'intake', b);

  for (let i = 0; i < 4; i++) {
    const res = await routing.assign(t.tenantId, await seedTask(t.tenantId, 'intake'));
    assert.ok(res.assigned, 'each task should be assigned');
  }
  const byAgent = await loadByAgent(t.tenantId);
  assert.deepEqual(Object.values(byAgent).sort(), [2, 2], 'four tasks split 2/2');
});

test('skill_tag assigns only to agents with the required skill', async () => {
  const t = await seedTenant('skill');
  const a = await seedAgent(t.tenantId, 'A', ['income']);
  const b = await seedAgent(t.tenantId, 'B', []);
  await seedQueue(t.tenantId, 'verification', 'skill_tag', 'income');
  await addMember(t.tenantId, 'verification', a);
  await addMember(t.tenantId, 'verification', b);

  const r1 = await routing.assign(t.tenantId, await seedTask(t.tenantId, 'verification'));
  const r2 = await routing.assign(t.tenantId, await seedTask(t.tenantId, 'verification'));
  assert.equal(r1.agentId, a);
  assert.equal(r2.agentId, a, 'only the skilled agent is eligible');

  // A queue whose required skill nobody has -> no eligible agent.
  await seedQueue(t.tenantId, 'special', 'skill_tag', 'blockchain');
  await addMember(t.tenantId, 'special', a);
  await addMember(t.tenantId, 'special', b);
  const none = await routing.assign(t.tenantId, await seedTask(t.tenantId, 'special'));
  assert.equal(none.assigned, false);
  assert.equal(none.reason, 'no_eligible_agent');
});

test('capacity fills by remaining capacity and refuses when full', async () => {
  const t = await seedTenant('cap');
  const a = await seedAgent(t.tenantId, 'A', [], 1);
  const b = await seedAgent(t.tenantId, 'B', [], 2);
  await seedQueue(t.tenantId, 'underwriting', 'capacity');
  await addMember(t.tenantId, 'underwriting', a);
  await addMember(t.tenantId, 'underwriting', b);

  // Total capacity is 3; the 4th assignment has nowhere to go.
  const outcomes = [];
  for (let i = 0; i < 4; i++) {
    outcomes.push(await routing.assign(t.tenantId, await seedTask(t.tenantId, 'underwriting')));
  }
  assert.equal(outcomes.filter((o) => o.assigned).length, 3, 'three assigned up to total capacity');
  assert.equal(outcomes[3]!.assigned, false);
  assert.equal(outcomes[3]!.reason, 'no_eligible_agent');

  const byAgent = await loadByAgent(t.tenantId);
  assert.equal(byAgent[a], 1, 'A (cap 1) holds 1');
  assert.equal(byAgent[b], 2, 'B (cap 2) holds 2');
});

test('unconfigured queue cannot assign', async () => {
  const t = await seedTenant('noq');
  const res = await routing.assign(t.tenantId, await seedTask(t.tenantId, 'ghost'));
  assert.equal(res.assigned, false);
  assert.equal(res.reason, 'queue_not_configured');
});
