import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, parseJsonObject, rulesListeningTo, sampleFor } from './events';

test('every event type has a sample with an entity id and an object payload', () => {
  for (const type of EVENT_TYPES) {
    const sample = sampleFor(type);
    assert.ok(sample.entityId.length > 0, `${type} has an entity id`);
    assert.equal(typeof sample.payload, 'object');
    assert.equal(typeof sample.delta, 'object');
  }
  // The delta-based rule (R10) only fires when the changed field is in delta.
  assert.ok('amount' in sampleFor('application.updated').delta);
});

test('parseJsonObject accepts objects, treats blank as empty, and rejects the rest', () => {
  assert.deepEqual(parseJsonObject('{"amount": 750000}'), { ok: true, value: { amount: 750000 } });
  assert.deepEqual(parseJsonObject('   '), { ok: true, value: {} });
  assert.equal(parseJsonObject('{amount: 1}').ok, false);
  // The API's envelope requires a record: an array or a bare value would be a 400.
  assert.equal(parseJsonObject('[1, 2]').ok, false);
  assert.equal(parseJsonObject('42').ok, false);
  assert.equal(parseJsonObject('null').ok, false);
});

const rule = (overrides: Record<string, unknown>) => ({
  ruleKey: 'R1',
  trigger: { type: 'event', event: 'application.submitted' },
  condition: null,
  action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial completeness check' },
  active: true,
  ...overrides,
});

test('rulesListeningTo lists only active rules triggered by that event type', () => {
  const rules = [
    rule({ ruleKey: 'R10', trigger: { type: 'event', event: 'application.updated' } }),
    rule({ ruleKey: 'R2', condition: { gt: ['payload.amount', 500000] } }),
    rule({ ruleKey: 'R1' }),
    rule({ ruleKey: 'R1', active: false }), // a superseded version
    rule({ ruleKey: 'R11', trigger: { type: 'schedule', cron: '0 2 * * *', scan: 's' } }),
  ];
  const listening = rulesListeningTo('application.submitted', rules);
  assert.deepEqual(
    listening.map((r) => r.ruleKey),
    ['R1', 'R2'],
  );
  assert.equal(listening[0]!.condition, 'always');
  assert.equal(listening[1]!.condition, 'payload.amount gt 500000');
  assert.equal(listening[0]!.outcome, 'creates "Initial completeness check" in intake');
});

test('rulesListeningTo describes a cancel rule', () => {
  const listening = rulesListeningTo('application.withdrawn', [
    rule({
      ruleKey: 'R12',
      trigger: { type: 'event', event: 'application.withdrawn' },
      action: { kind: 'cancel_tasks', scope: 'application' },
    }),
  ]);
  assert.equal(listening[0]!.outcome, 'cancels open tasks for the application');
});
