import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app';
import {
  adminPool,
  appPool,
  seedTenant,
  countFor,
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

// Each test gets a fresh, unique tenant; all assertions are scoped to it, so tests are
// independent and safe under the test runner's concurrent file execution (no global truncate).
beforeEach(async () => {
  tenant = await seedTenant('Acme');
});

// The three tests that matter for Phase 2a (design doc §12).

test('duplicate event: same idempotency key is ingested once', async () => {
  const body = {
    idempotencyKey: 'dup-1',
    type: 'application.submitted',
    entityId: 'app-1',
    payload: { amount: 100 },
  };

  const first = await postEvent(server.url, tenant.rawKey, body);
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);

  const second = await postEvent(server.url, tenant.rawKey, body);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(second.json.eventId, first.json.eventId);

  assert.deepEqual(await countFor(tenant.tenantId), { events: 1, outbox: 1 });
});

test('malformed payload: rejected with 400 and nothing is written', async () => {
  const unknownType = await postEvent(server.url, tenant.rawKey, {
    idempotencyKey: 'bad-1',
    type: 'not.a.real.event',
    entityId: 'x',
  });
  assert.equal(unknownType.status, 400);

  const missingEntity = await postEvent(server.url, tenant.rawKey, {
    idempotencyKey: 'bad-2',
    type: 'document.uploaded',
  });
  assert.equal(missingEntity.status, 400);

  assert.deepEqual(await countFor(tenant.tenantId), { events: 0, outbox: 0 });
});

test('idempotency key reused with a different body is rejected with 409', async () => {
  const body = {
    idempotencyKey: 'conflict-1',
    type: 'application.submitted',
    entityId: 'app-1',
    payload: { amount: 100 },
  };
  const first = await postEvent(server.url, tenant.rawKey, body);
  assert.equal(first.status, 201);

  // Same key, different payload -> conflict.
  const different = await postEvent(server.url, tenant.rawKey, {
    ...body,
    payload: { amount: 999 },
  });
  assert.equal(different.status, 409);

  // Same key, same body -> still a clean replay.
  const same = await postEvent(server.url, tenant.rawKey, body);
  assert.equal(same.status, 200);
  assert.equal(same.json.eventId, first.json.eventId);
});

test('concurrent identical events: exactly one event and one outbox row', async () => {
  const body = {
    idempotencyKey: 'race-1',
    type: 'document.uploaded',
    entityId: 'doc-1',
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => postEvent(server.url, tenant.rawKey, body)),
  );

  for (const r of results) {
    assert.ok(r.status === 200 || r.status === 201, `unexpected status ${r.status}`);
  }
  const eventIds = new Set(results.map((r) => r.json.eventId));
  assert.equal(eventIds.size, 1, 'all concurrent posts must resolve to one event id');

  assert.deepEqual(await countFor(tenant.tenantId), { events: 1, outbox: 1 });
});
