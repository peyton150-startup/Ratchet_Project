import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { graphql } from 'graphql';
import { schema } from '../src/graphql/schema';
import { buildApp } from '../src/app';
import {
  adminPool,
  appPool,
  seedTenant,
  startServer,
  type RunningServer,
} from './helpers';

let server: RunningServer;

before(async () => {
  server = await startServer(buildApp(appPool));
});

after(async () => {
  await server.close();
  await appPool.end();
  await adminPool.end();
});

async function seedTask(tenantId: string, queue = 'intake', state = 'open'): Promise<string> {
  const r = await adminPool.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, dedup_key, rule_key, rule_version, queue, template, state)
     VALUES ($1, $2, 'R1', 1, $3, 'tpl', $4) RETURNING id`,
    [tenantId, randomUUID(), queue, state],
  );
  return r.rows[0]!.id;
}

interface ExecResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

function exec(
  source: string,
  ctx: { pool: typeof appPool; tenantId?: string; role?: string },
  variableValues?: Record<string, unknown>,
): Promise<ExecResult> {
  return graphql({ schema, source, contextValue: ctx, variableValues }) as Promise<ExecResult>;
}

test('tasks query returns the tenant tasks (tasks:read)', async () => {
  const t = await seedTenant('gql-read');
  await seedTask(t.tenantId);
  await seedTask(t.tenantId);
  const res = await exec('{ tasks { id state queue } }', { pool: appPool, tenantId: t.tenantId, role: 'admin' });
  assert.equal(res.errors, undefined);
  assert.equal((res.data!['tasks'] as unknown[]).length, 2);
});

test('a role without permission is forbidden', async () => {
  const t = await seedTenant('gql-forbid');
  const res = await exec('{ tasks { id } }', { pool: appPool, tenantId: t.tenantId, role: 'integrator' });
  assert.ok(res.errors && res.errors.length > 0);
  assert.equal(res.errors[0]!.extensions?.code, 'FORBIDDEN');
});

test('an unauthenticated context is rejected', async () => {
  const res = await exec('{ tasks { id } }', { pool: appPool });
  assert.ok(res.errors && res.errors.length > 0);
  assert.equal(res.errors[0]!.extensions?.code, 'UNAUTHENTICATED');
});

test('viewer reports the key role and its permissions, for every role', async () => {
  const t = await seedTenant('gql-viewer');
  const ask = (role: string): Promise<ExecResult> =>
    exec('{ viewer { role permissions } }', { pool: appPool, tenantId: t.tenantId, role });

  const admin = (await ask('admin')).data!['viewer'] as { role: string; permissions: string[] };
  assert.equal(admin.role, 'admin');
  assert.ok(admin.permissions.includes('rules:write'));

  // An integrator can read nothing else over GraphQL, but must still be able to ask who it is.
  const integrator = await ask('integrator');
  assert.equal(integrator.errors, undefined);
  assert.deepEqual(
    [...(integrator.data!['viewer'] as { permissions: string[] }).permissions].sort(),
    ['events:ingest', 'webhooks:manage'],
  );

  const anonymous = await exec('{ viewer { role } }', { pool: appPool });
  assert.equal(anonymous.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
});

test('claimTask transitions open -> claimed (tasks:work)', async () => {
  const t = await seedTenant('gql-claim');
  const id = await seedTask(t.tenantId);
  const res = await exec(
    'mutation($id: ID!) { claimTask(id: $id) { id state } }',
    { pool: appPool, tenantId: t.tenantId, role: 'operator' },
    { id },
  );
  assert.equal(res.errors, undefined);
  assert.equal((res.data!['claimTask'] as { state: string }).state, 'claimed');
});

test('an illegal transition surfaces as a GraphQL error', async () => {
  const t = await seedTenant('gql-illegal');
  const id = await seedTask(t.tenantId); // open
  const res = await exec(
    'mutation($id: ID!) { completeTask(id: $id) { state } }',
    { pool: appPool, tenantId: t.tenantId, role: 'operator' },
    { id },
  );
  assert.ok(res.errors && res.errors.length > 0);
  assert.equal(res.errors[0]!.extensions?.code, 'ILLEGAL_TRANSITION');
});

test('unblock, release and cancel are reachable through the API', async () => {
  const t = await seedTenant('gql-lifecycle');
  const ctx = { pool: appPool, tenantId: t.tenantId, role: 'operator' };
  const run = async (field: string, id: string): Promise<ExecResult> =>
    exec(`mutation($id: ID!) { ${field}(id: $id) { state } }`, ctx, { id });

  const blocked = await seedTask(t.tenantId, 'intake', 'blocked');
  const unblocked = await run('unblockTask', blocked);
  assert.equal(unblocked.errors, undefined);
  assert.equal((unblocked.data!['unblockTask'] as { state: string }).state, 'claimed');

  const released = await run('releaseTask', blocked);
  assert.equal((released.data!['releaseTask'] as { state: string }).state, 'open');

  const cancelled = await run('cancelTask', blocked);
  assert.equal((cancelled.data!['cancelTask'] as { state: string }).state, 'cancelled');

  // Terminal: the shared transition table, not the resolver, decides this is illegal.
  const again = await run('unblockTask', blocked);
  assert.equal(again.errors?.[0]?.extensions?.code, 'ILLEGAL_TRANSITION');
});

test('lifecycle mutations require tasks:work', async () => {
  const t = await seedTenant('gql-lifecycle-rbac');
  const id = await seedTask(t.tenantId);
  const res = await exec(
    'mutation($id: ID!) { cancelTask(id: $id) { state } }',
    { pool: appPool, tenantId: t.tenantId, role: 'integrator' },
    { id },
  );
  assert.equal(res.errors?.[0]?.extensions?.code, 'FORBIDDEN');
});

test('tasks(activeOnly) leaves out completed and cancelled tasks', async () => {
  const t = await seedTenant('gql-active-only');
  const ctx = { pool: appPool, tenantId: t.tenantId, role: 'operator' };
  for (const state of ['open', 'claimed', 'blocked', 'completed', 'cancelled']) {
    await seedTask(t.tenantId, 'intake', state);
  }

  const active = await exec('{ tasks(activeOnly: true) { state } }', ctx);
  assert.equal(active.errors, undefined);
  const states = (active.data!['tasks'] as Array<{ state: string }>).map((x) => x.state).sort();
  assert.deepEqual(states, ['blocked', 'claimed', 'open']);

  const all = await exec('{ tasks { state } }', ctx);
  assert.equal((all.data!['tasks'] as unknown[]).length, 5, 'the default still returns every state');
});

test('a task carries the name of its assigned agent', async () => {
  const t = await seedTenant('gql-assignee-name');
  const ctx = { pool: appPool, tenantId: t.tenantId, role: 'operator' };
  const agent = await adminPool.query<{ id: string }>(
    "INSERT INTO agents (tenant_id, name) VALUES ($1, 'Ava Intake') RETURNING id",
    [t.tenantId],
  );
  const assigned = await seedTask(t.tenantId);
  await adminPool.query('UPDATE tasks SET assignee = $2 WHERE id = $1', [assigned, agent.rows[0]!.id]);
  const unassigned = await seedTask(t.tenantId);

  const res = await exec('{ tasks { id assigneeName } }', ctx);
  assert.equal(res.errors, undefined);
  const byId = new Map(
    (res.data!['tasks'] as Array<{ id: string; assigneeName: string | null }>).map((x) => [x.id, x.assigneeName]),
  );
  assert.equal(byId.get(assigned), 'Ava Intake');
  assert.equal(byId.get(unassigned), null);

  // The single-task read (used after every mutation and by the worker's publish) carries it too.
  const one = await exec('query($id: ID!) { task(id: $id) { assigneeName } }', ctx, { id: assigned });
  assert.equal((one.data!['task'] as { assigneeName: string }).assigneeName, 'Ava Intake');
});

test('assignTask routes a task to an eligible agent', async () => {
  const t = await seedTenant('gql-assign');
  const agent = await adminPool.query<{ id: string }>(
    "INSERT INTO agents (tenant_id, name) VALUES ($1, 'A') RETURNING id",
    [t.tenantId],
  );
  const agentId = agent.rows[0]!.id;
  await adminPool.query("INSERT INTO queues (tenant_id, name, strategy) VALUES ($1, 'intake', 'round_robin')", [t.tenantId]);
  await adminPool.query("INSERT INTO queue_members (tenant_id, queue, agent_id) VALUES ($1, 'intake', $2)", [t.tenantId, agentId]);
  const id = await seedTask(t.tenantId);

  const res = await exec(
    'mutation($id: ID!) { assignTask(id: $id) { assignee } }',
    { pool: appPool, tenantId: t.tenantId, role: 'admin' },
    { id },
  );
  assert.equal(res.errors, undefined);
  assert.equal((res.data!['assignTask'] as { assignee: string }).assignee, agentId);
});

test('events query returns entity history for the task detail view', async () => {
  const t = await seedTenant('gql-events');
  await adminPool.query(
    `INSERT INTO events (tenant_id, event_type, entity_type, entity_id, occurred_at, payload)
     VALUES ($1, 'application.submitted', 'LoanApplication', 'app-hist', now() - interval '2 hours', '{}'),
            ($1, 'application.updated',   'LoanApplication', 'app-hist', now() - interval '1 hour',  '{}'),
            ($1, 'application.updated',   'LoanApplication', 'other-app', now(), '{}')`,
    [t.tenantId],
  );

  const res = await exec(
    'query($id: String!) { events(entityId: $id) { id type occurredAt } }',
    { pool: appPool, tenantId: t.tenantId, role: 'operator' },
    { id: 'app-hist' },
  );
  assert.equal(res.errors, undefined);
  const events = res.data!['events'] as Array<{ type: string }>;
  assert.equal(events.length, 2, 'only this entity history');
  assert.equal(events[0]!.type, 'application.updated', 'newest first');
});

const draftRule = {
  ruleKey: 'R99',
  trigger: { type: 'event', event: 'application.submitted' },
  condition: null,
  action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Check' },
};

test('createRuleVersion publishes versions and supersedes the previous one', async () => {
  const t = await seedTenant('gql-rules');
  const ctx = { pool: appPool, tenantId: t.tenantId, role: 'admin' };
  const mutation =
    'mutation($input: RuleVersionInput!) { createRuleVersion(input: $input) { ruleKey version active } }';

  const v1 = await exec(mutation, ctx, { input: draftRule });
  assert.equal(v1.errors, undefined);
  assert.equal((v1.data!['createRuleVersion'] as { version: number }).version, 1);

  const v2 = await exec(mutation, ctx, {
    input: { ...draftRule, action: { ...draftRule.action, sla: '8h' } },
  });
  assert.equal((v2.data!['createRuleVersion'] as { version: number }).version, 2);

  const listed = await exec('{ rules { ruleKey version active } }', ctx);
  const rules = listed.data!['rules'] as Array<{ version: number; active: boolean }>;
  assert.equal(rules.length, 2, 'history keeps superseded versions');
  assert.equal(rules.find((r) => r.version === 2)!.active, true);
  assert.equal(rules.find((r) => r.version === 1)!.active, false, 'previous version deactivated');
});

test('createRuleVersion rejects an invalid rule', async () => {
  const t = await seedTenant('gql-rules-bad');
  const res = await exec(
    'mutation($input: RuleVersionInput!) { createRuleVersion(input: $input) { version } }',
    { pool: appPool, tenantId: t.tenantId, role: 'admin' },
    { input: { ...draftRule, action: { ...draftRule.action, sla: 'whenever' } } },
  );
  assert.ok(res.errors && res.errors.length > 0);
  assert.equal(res.errors[0]!.extensions?.code, 'INVALID_RULE');
});

test('rules mutations require rules:write', async () => {
  const t = await seedTenant('gql-rules-rbac');
  // operator has rules:read but not rules:write
  const read = await exec('{ rules { version } }', { pool: appPool, tenantId: t.tenantId, role: 'operator' });
  assert.equal(read.errors, undefined, 'operator may read rules');

  const write = await exec(
    'mutation($input: RuleVersionInput!) { createRuleVersion(input: $input) { version } }',
    { pool: appPool, tenantId: t.tenantId, role: 'operator' },
    { input: draftRule },
  );
  assert.equal(write.errors?.[0]?.extensions?.code, 'FORBIDDEN');
});

test('dryRunRule evaluates a draft without persisting it', async () => {
  const t = await seedTenant('gql-dryrun');
  const ctx = { pool: appPool, tenantId: t.tenantId, role: 'admin' };
  const res = await exec(
    'mutation($rule: JSON!, $event: JSON!) { dryRunRule(rule: $rule, event: $event) { matched decision } }',
    ctx,
    {
      rule: { ...draftRule, version: 1 },
      event: { type: 'application.submitted', entityId: 'app-1', entityType: 'LoanApplication' },
    },
  );
  assert.equal(res.errors, undefined);
  assert.equal((res.data!['dryRunRule'] as { matched: boolean }).matched, true);

  // Nothing was stored: the draft never becomes a rule version, and no audit row is written.
  const stored = await exec('{ rules { version } }', ctx);
  assert.equal((stored.data!['rules'] as unknown[]).length, 0);
  const audit = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM rule_audit WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(audit.rows[0]!.c, 0, 'dry run writes no audit');
});

test('HTTP /graphql endpoint works end-to-end with auth', async () => {
  const t = await seedTenant('gql-http');
  await seedTask(t.tenantId);
  const resp = await fetch(`${server.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, application/graphql-response+json',
      authorization: `Bearer ${t.rawKey}`,
    },
    body: JSON.stringify({ query: '{ tasks { id state } }' }),
  });
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as ExecResult;
  assert.equal(body.errors, undefined);
  assert.equal((body.data!['tasks'] as unknown[]).length, 1);
});
