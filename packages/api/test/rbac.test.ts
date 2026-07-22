import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/authz';
import { buildApp } from '../src/app';
import {
  adminPool,
  appPool,
  seedTenant,
  seedKey,
  startServer,
  postEvent,
  type RunningServer,
  type SeededTenant,
} from './helpers';

let server: RunningServer;
let tenant: SeededTenant;

before(async () => {
  server = await startServer(buildApp(appPool));
});

after(async () => {
  await server.close();
  await appPool.end();
  await adminPool.end();
});

beforeEach(async () => {
  tenant = await seedTenant('rbac');
});

// Pure permission matrix.
test('role permissions matrix', () => {
  assert.equal(can('integrator', 'events:ingest'), true);
  assert.equal(can('integrator', 'tasks:work'), false);
  assert.equal(can('integrator', 'rules:write'), false);

  assert.equal(can('operator', 'tasks:work'), true);
  assert.equal(can('operator', 'rules:read'), true);
  assert.equal(can('operator', 'rules:write'), false);
  assert.equal(can('operator', 'events:ingest'), false);

  assert.equal(can('admin', 'rules:write'), true);
  assert.equal(can('admin', 'queues:manage'), true);
  assert.equal(can('admin', 'events:ingest'), true);
});

const validEvent = {
  idempotencyKey: 'rbac-1',
  type: 'application.submitted',
  entityId: 'app-1',
  payload: {},
};

// The ingest route is gated by events:ingest.
test('integrator key may ingest events', async () => {
  const key = await seedKey(tenant.tenantId, 'integrator');
  const res = await postEvent(server.url, key, validEvent);
  assert.equal(res.status, 201);
});

test('operator key is forbidden from ingesting events', async () => {
  const key = await seedKey(tenant.tenantId, 'operator');
  const res = await postEvent(server.url, key, validEvent);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
});

test('unauthenticated request is rejected before RBAC', async () => {
  const res = await fetch(`${server.url}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validEvent),
  });
  assert.equal(res.status, 401);
});
