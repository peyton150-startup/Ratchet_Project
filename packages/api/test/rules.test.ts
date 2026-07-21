import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RulesEngine, type EngineEvent } from '../src/rules/engine';
import type { Rule } from '../src/rules/types';
import { adminPool, appPool, seedTenant, seedEvent, seedRule, auditFor } from './helpers';

const engine = new RulesEngine(appPool);

after(async () => {
  await appPool.end();
  await adminPool.end();
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function eventFor(partial: Partial<EngineEvent> & Pick<EngineEvent, 'type' | 'entityId'>): EngineEvent {
  return {
    entityType: 'LoanApplication',
    occurredAt: new Date().toISOString(),
    payload: {},
    delta: {},
    ...partial,
  };
}

// R10 — delta-based: fires only when `amount` changed AND the application is past underwriting.
test('R10: delta-based rule fires only when amount changed', async () => {
  const t = await seedTenant('R10');
  // Prior state: application currently at "conditions" (rank 4, past underwriting rank 3).
  await seedEvent(t.tenantId, {
    type: 'application.updated',
    entityId: 'app-r10',
    payload: { stage: 'conditions' },
    occurredAt: daysAgo(1),
  });
  const r10: Rule = {
    ruleKey: 'R10',
    version: 1,
    trigger: { type: 'event', event: 'application.updated' },
    condition: { and: [{ changed: 'amount' }, { gt: ['state.application_stage_rank', 3] }] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Re-underwrite' },
  };
  await seedRule(t.tenantId, r10);

  const withAmount = await engine.evaluateEvent(
    t.tenantId,
    eventFor({ type: 'application.updated', entityId: 'app-r10', delta: { amount: 600000 } }),
  );
  assert.equal(withAmount.length, 1, 'should fire when amount changed');
  assert.equal(withAmount[0]!.ruleKey, 'R10');

  const withoutAmount = await engine.evaluateEvent(
    t.tenantId,
    eventFor({ type: 'application.updated', entityId: 'app-r10', delta: { stage: 'closing' } }),
  );
  assert.equal(withoutAmount.length, 0, 'should not fire when amount did not change');

  // Audit captured both evaluations with the rule version that fired.
  const audit = await auditFor(t.tenantId);
  assert.equal(audit.length, 2);
  assert.deepEqual(
    audit.map((a) => [a.rule_key, a.rule_version, a.matched]),
    [
      ['R10', 1, true],
      ['R10', 1, false],
    ],
  );
});

// R7 — state-querying across entities: fires when all required doc types are verified.
test('R7: state-querying rule fires when all required docs verified', async () => {
  const t = await seedTenant('R7');
  const r7: Rule = {
    ruleKey: 'R7',
    version: 1,
    trigger: { type: 'event', event: 'verification.completed' },
    condition: { state: 'all_required_docs_verified' },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Run underwriting' },
  };
  await seedRule(t.tenantId, r7);

  // Only income verified so far -> not all required docs.
  await seedEvent(t.tenantId, {
    type: 'verification.completed',
    entityId: 'vr-1',
    payload: { applicationId: 'app-r7', docType: 'paystub', outcome: 'pass' },
  });
  const partial = await engine.evaluateEvent(
    t.tenantId,
    eventFor({ type: 'verification.completed', entityId: 'vr-1', payload: { applicationId: 'app-r7' } }),
  );
  assert.equal(partial.length, 0, 'should not fire until assets verified too');

  // Now assets verified as well -> all required docs verified.
  await seedEvent(t.tenantId, {
    type: 'verification.completed',
    entityId: 'vr-2',
    payload: { applicationId: 'app-r7', docType: 'bank_statement', outcome: 'pass' },
  });
  const complete = await engine.evaluateEvent(
    t.tenantId,
    eventFor({ type: 'verification.completed', entityId: 'vr-2', payload: { applicationId: 'app-r7' } }),
  );
  assert.equal(complete.length, 1, 'should fire once all required docs verified');
  assert.equal(complete[0]!.ruleKey, 'R7');
});

// R11 — time-triggered sweep: finds stale documents on applications at underwriting.
test('R11: scheduled sweep finds stale documents at underwriting', async () => {
  const t = await seedTenant('R11');
  await seedEvent(t.tenantId, {
    type: 'application.updated',
    entityId: 'app-r11',
    payload: { stage: 'underwriting' },
    occurredAt: daysAgo(5),
  });
  await seedEvent(t.tenantId, {
    type: 'document.uploaded',
    entityId: 'doc-old',
    payload: { applicationId: 'app-r11', documentId: 'doc-old', issuedDate: daysAgo(90) },
  });
  await seedEvent(t.tenantId, {
    type: 'document.uploaded',
    entityId: 'doc-fresh',
    payload: { applicationId: 'app-r11', documentId: 'doc-fresh', issuedDate: daysAgo(10) },
  });
  const r11: Rule = {
    ruleKey: 'R11',
    version: 1,
    trigger: { type: 'schedule', cron: '0 0 * * *', scan: 'stale_documents_at_underwriting' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '24h', template: 'Request updated document' },
  };
  await seedRule(t.tenantId, r11);

  const decisions = await engine.runSchedule(t.tenantId, new Date());
  assert.equal(decisions.length, 1, 'only the 90-day-old document is stale');
  assert.equal(decisions[0]!.subject['documentId'], 'doc-old');

  const audit = await auditFor(t.tenantId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.trigger_type, 'schedule');
});

// Dry-run evaluates and returns decisions without writing any audit record.
test('dry-run returns decisions but persists no audit', async () => {
  const t = await seedTenant('dry');
  await seedRule(t.tenantId, {
    ruleKey: 'R1',
    version: 1,
    trigger: { type: 'event', event: 'application.submitted' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial completeness check' },
  });

  const decisions = await engine.evaluateEvent(
    t.tenantId,
    eventFor({ type: 'application.submitted', entityId: 'app-dry' }),
    { dryRun: true },
  );
  assert.equal(decisions.length, 1, 'dry-run still computes the decision');
  assert.equal((await auditFor(t.tenantId)).length, 0, 'dry-run writes no audit');
});
