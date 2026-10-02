import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditOutcome, auditTrigger, describeStrategy } from './audit';

test('auditOutcome says what the rule did', () => {
  assert.equal(auditOutcome({ matched: false, decision: null }), 'did not match');
  assert.equal(
    auditOutcome({
      matched: true,
      decision: { ruleKey: 'R2', action: { kind: 'create_task', template: 'Senior review', queue: 'underwriting' } },
    }),
    'created "Senior review" in underwriting',
  );
  assert.equal(
    auditOutcome({ matched: true, decision: { action: { kind: 'cancel_tasks', scope: 'application' } } }),
    'cancelled open tasks',
  );
  // A matched row whose decision was not stored still reads sensibly.
  assert.equal(auditOutcome({ matched: true, decision: null }), 'matched');
});

test('auditTrigger names the event, a sweep, or an event that has aged out', () => {
  assert.equal(
    auditTrigger({ triggerType: 'event', eventType: 'application.submitted', entityId: 'app-1001' }),
    'application.submitted · app-1001',
  );
  assert.equal(auditTrigger({ triggerType: 'schedule', eventType: null, entityId: null }), 'scheduled sweep');
  assert.equal(auditTrigger({ triggerType: 'event', eventType: null, entityId: null }), 'an event no longer retained');
});

test('describeStrategy explains how a queue picks an agent', () => {
  assert.equal(describeStrategy('round_robin', null), 'each agent in turn');
  assert.equal(describeStrategy('skill_tag', 'verification'), 'agents with the verification skill, in turn');
  assert.equal(describeStrategy('capacity', null), 'the agent with the most free capacity');
  assert.equal(describeStrategy('something_new', null), 'something_new');
});
