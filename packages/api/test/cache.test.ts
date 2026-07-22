import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RulesCache } from '../src/rules/cache';
import { RulesEngine } from '../src/rules/engine';
import { withTenant } from '../src/db';
import type { Rule } from '../src/rules/types';
import { adminPool, appPool, seedTenant, seedRule } from './helpers';

after(async () => {
  await appPool.end();
  await adminPool.end();
});

const r1: Rule = {
  ruleKey: 'R1',
  version: 1,
  trigger: { type: 'event', event: 'application.submitted' },
  condition: null,
  action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial completeness check' },
};

function event(type = 'application.submitted') {
  return {
    type,
    entityId: 'app-1',
    entityType: 'LoanApplication',
    occurredAt: new Date().toISOString(),
    payload: {},
    delta: {},
  };
}

test('cache serves repeat lookups and invalidate() forces a reload', async () => {
  const t = await seedTenant('cache-inval');
  await seedRule(t.tenantId, r1);
  const cache = new RulesCache(60_000); // long TTL: only invalidate() should clear it

  const first = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'application.submitted'),
  );
  assert.equal(first.length, 1);

  // Deactivate the rule. The cache still holds the old answer (this is the documented staleness).
  await adminPool.query('UPDATE rules SET active = false WHERE tenant_id = $1', [t.tenantId]);
  const stale = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'application.submitted'),
  );
  assert.equal(stale.length, 1, 'stale window: deactivated rule still cached');

  // Explicit invalidation is the primary mechanism — after it, the rule is gone.
  cache.invalidate(t.tenantId);
  const fresh = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'application.submitted'),
  );
  assert.equal(fresh.length, 0, 'after invalidate the deactivated rule is gone');
});

test('TTL expiry reloads rules without an explicit invalidate', async () => {
  const t = await seedTenant('cache-ttl');
  await seedRule(t.tenantId, r1);
  const cache = new RulesCache(50);

  const t0 = Date.now();
  const first = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'application.submitted', t0),
  );
  assert.equal(first.length, 1);

  await adminPool.query('UPDATE rules SET active = false WHERE tenant_id = $1', [t.tenantId]);
  // Past the TTL, the cache reloads even though nobody called invalidate() — the cross-process backstop.
  const afterTtl = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'application.submitted', t0 + 1_000),
  );
  assert.equal(afterTtl.length, 0, 'TTL expiry bounds the stale window');
});

test('dry-run bypasses the cache and sees current rules', async () => {
  const t = await seedTenant('cache-dryrun');
  await seedRule(t.tenantId, r1);
  const engine = new RulesEngine(appPool, new RulesCache(60_000));

  // Warm the cache through a normal evaluation.
  const warm = await engine.evaluateEvent(t.tenantId, event());
  assert.equal(warm.length, 1);

  await adminPool.query('UPDATE rules SET active = false WHERE tenant_id = $1', [t.tenantId]);

  // Cached path still fires (stale), but dry-run must read fresh and see the deactivation.
  const cached = await engine.evaluateEvent(t.tenantId, event());
  assert.equal(cached.length, 1, 'cached path is stale within the TTL');

  const dry = await engine.evaluateEvent(t.tenantId, event(), { dryRun: true });
  assert.equal(dry.length, 0, 'dry-run bypasses the cache');
});

test('rules for other event types are not returned', async () => {
  const t = await seedTenant('cache-filter');
  await seedRule(t.tenantId, r1); // triggers on application.submitted
  const cache = new RulesCache();

  const other = await withTenant(appPool, t.tenantId, (c) =>
    cache.getForEvent(c, t.tenantId, 'document.uploaded'),
  );
  assert.equal(other.length, 0, 'SQL filter excludes non-matching triggers');
});
