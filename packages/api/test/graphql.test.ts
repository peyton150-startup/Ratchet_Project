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
