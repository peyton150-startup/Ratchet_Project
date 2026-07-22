import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDraft,
  wrapInGroup,
  addToGroup,
  removeFromGroup,
  describeCondition,
  diffVersions,
  isGroup,
  type Condition,
  type RuleDraft,
} from './rules';

function draft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    ruleKey: 'R1',
    trigger: { type: 'event', event: 'application.submitted' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial check' },
    ...overrides,
  };
}

test('validateDraft accepts a well-formed rule', () => {
  assert.deepEqual(validateDraft(draft()), []);
});

test('validateDraft catches the mistakes the API would reject', () => {
  const issues = validateDraft(
    draft({
      ruleKey: '',
      action: { kind: 'create_task', queue: '', sla: 'soon', template: '' },
    }),
  );
  const fields = issues.map((i) => i.field).sort();
  assert.deepEqual(fields, ['action.queue', 'action.sla', 'action.template', 'ruleKey']);
});

test('validateDraft requires cron and scan for schedule triggers', () => {
  const issues = validateDraft(draft({ trigger: { type: 'schedule', cron: '', scan: '' } }));
  assert.equal(issues.filter((i) => i.field === 'trigger').length, 2);
});

test('condition tree editing is immutable', () => {
  const group = wrapInGroup(null, 'and');
  assert.ok(isGroup(group));

  const changed: Condition = { changed: 'amount' };
  const withOne = addToGroup(group, changed);
  const withTwo = addToGroup(withOne, { state: 'all_required_docs_verified' });

  assert.deepEqual((group as { and: Condition[] }).and, [], 'original group untouched');
  assert.equal((withOne as { and: Condition[] }).and.length, 1);
  assert.equal((withTwo as { and: Condition[] }).and.length, 2);

  const removed = removeFromGroup(withTwo, 0);
  assert.equal((removed as { and: Condition[] }).and.length, 1);
  assert.equal((withTwo as { and: Condition[] }).and.length, 2, 'removal did not mutate');
});

test('wrapInGroup nests an existing condition', () => {
  const inner: Condition = { changed: 'amount' };
  const wrapped = wrapInGroup(inner, 'or') as { or: Condition[] };
  assert.deepEqual(wrapped.or, [inner]);
});

test('describeCondition renders R7/R10-style trees readably', () => {
  assert.equal(describeCondition(null), 'always');
  assert.equal(describeCondition({ state: 'all_required_docs_verified' }), 'state.all_required_docs_verified');
  assert.equal(
    describeCondition({
      and: [{ changed: 'amount' }, { gt: ['state.application_stage_rank', 3] } as Condition],
    }),
    '(changed(amount) AND state.application_stage_rank gt 3)',
  );
  assert.equal(describeCondition({ not: { changed: 'stage' } }), 'NOT changed(stage)');
});

test('diffVersions reports meaningful field-level changes', () => {
  const v1 = {
    version: 1,
    trigger: { type: 'event', event: 'application.updated' },
    condition: { changed: 'amount' },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Re-underwrite' },
  };
  const v2 = {
    version: 2,
    trigger: { type: 'event', event: 'application.updated' },
    condition: { and: [{ changed: 'amount' }, { gt: ['state.application_stage_rank', 3] }] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '8h', template: 'Re-underwrite' },
  };

  const diffs = diffVersions(v1, v2);
  const fields = diffs.map((d) => d.field).sort();
  assert.deepEqual(fields, ['action.sla', 'condition'], 'unchanged trigger/queue/template omitted');

  const sla = diffs.find((d) => d.field === 'action.sla')!;
  assert.equal(sla.before, '24h');
  assert.equal(sla.after, '8h');
});

test('diffVersions returns nothing for identical versions', () => {
  const v = {
    version: 1,
    trigger: { type: 'event', event: 'x' },
    condition: null,
    action: { kind: 'create_task', queue: 'q', sla: '1h', template: 't' },
  };
  assert.deepEqual(diffVersions(v, { ...v, version: 2 }), []);
});
