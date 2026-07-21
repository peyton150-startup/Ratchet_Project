import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../src/db';
import { ingestEvent } from '../src/events/ingest';
import { adminPool, appPool, seedTenant } from './helpers';

after(async () => {
  await appPool.end();
  await adminPool.end();
});

// ADR-005 hard invariant: every table carrying a tenant_id must have RLS enabled AND forced.
// Partition children are excluded (access is enforced through the partitioned parent).
test('every tenant table has RLS enabled and forced', async () => {
  const offenders = await adminPool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        )
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
  );
  assert.deepEqual(
    offenders.rows.map((r) => r.relname),
    [],
    'these tenant tables are missing forced RLS',
  );
});

// Prove the policy actually isolates: one tenant cannot see another's events.
test('RLS isolates events between tenants', async () => {
  const a = await seedTenant('TenantA');
  const b = await seedTenant('TenantB');

  await ingestEvent(appPool, a.tenantId, {
    idempotencyKey: 'a-1',
    type: 'application.submitted',
    entityId: 'app-a',
  });
  await ingestEvent(appPool, b.tenantId, {
    idempotencyKey: 'b-1',
    type: 'application.submitted',
    entityId: 'app-b',
  });

  const seenByA = await withTenant(appPool, a.tenantId, (c) =>
    c.query<{ c: number }>('SELECT count(*)::int AS c FROM events'),
  );
  assert.equal(seenByA.rows[0]!.c, 1, 'tenant A must see only its own event');

  // Admin (superuser) bypasses RLS and sees both tenants' events (scoped to A and B).
  const adminCount = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM events WHERE tenant_id IN ($1, $2)',
    [a.tenantId, b.tenantId],
  );
  assert.equal(adminCount.rows[0]!.c, 2, 'admin sees both tenants events');
});
