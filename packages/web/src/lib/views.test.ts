import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleViews } from './views';

const ids = (permissions: string[] | null): string[] => visibleViews(permissions).map((v) => v.id);

test('each role sees the views it can use', () => {
  // The three roles, as the API's authz table defines them.
  const admin = [
    'events:ingest',
    'tasks:read',
    'tasks:work',
    'rules:read',
    'rules:write',
    'queues:manage',
    'webhooks:manage',
    'ops:read',
  ];
  const operator = ['tasks:read', 'tasks:work', 'rules:read'];
  const integrator = ['events:ingest', 'webhooks:manage'];

  assert.deepEqual(ids(admin), ['operator', 'admin', 'events', 'webhooks', 'ops']);
  // An operator can read rules but not publish them, so the authoring view is not offered.
  assert.deepEqual(ids(operator), ['operator']);
  assert.deepEqual(ids(integrator), ['events', 'webhooks']);
});

test('unknown permissions show every view rather than locking the key out', () => {
  assert.deepEqual(ids(null), ['operator', 'admin', 'events', 'webhooks', 'ops']);
});
