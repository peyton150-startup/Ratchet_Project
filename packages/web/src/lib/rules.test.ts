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
  addCondition,
  removeAt,
  replaceAt,
  toggleNot,
  setGroupOp,
  makeComparison,
  comparisonParts,
  parseLiteral,
  literalToText,
  validateCondition,
  describeTrigger,
  describeAction,
  draftFromVersion,
  sortRuleKeys,
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

// ---- path editing ------------------------------------------------------------------------------

const gt = (ref: string, value: unknown): Condition => makeComparison('gt', ref, value);

test('addCondition builds up from nothing, then groups', () => {
  const one = addCondition(null, [], { changed: 'amount' });
  assert.deepEqual(one, { changed: 'amount' }, 'a single condition is not wrapped');

  // Adding to a single condition turns the pair into an ALL-of group.
  const two = addCondition(one, [], gt('state.application_stage_rank', 3));
  assert.deepEqual(two, { and: [{ changed: 'amount' }, { gt: ['state.application_stage_rank', 3] }] });

  // Adding to a group appends; adding at a nested path targets that node.
  const three = addCondition(two, [], { state: 'all_required_docs_verified' });
  assert.equal((three as { and: Condition[] }).and.length, 3);
  const nested = addCondition(three, [0], { changed: 'stage' });
  assert.deepEqual((nested as { and: Condition[] }).and[0], { and: [{ changed: 'amount' }, { changed: 'stage' }] });
  assert.equal((three as { and: Condition[] }).and.length, 3, 'the original tree is untouched');
});

test('removeAt removes a node, and a NOT goes with its only child', () => {
  const tree: Condition = { and: [{ changed: 'a' }, { not: { changed: 'b' } }] };
  assert.deepEqual(removeAt(tree, [0]), { and: [{ not: { changed: 'b' } }] });
  assert.deepEqual(removeAt(tree, [1, 0]), { and: [{ changed: 'a' }] });
  assert.equal(removeAt({ changed: 'a' }, []), null, 'removing the root leaves no condition');
});

test('replaceAt, toggleNot and setGroupOp edit one node in place', () => {
  const tree: Condition = { and: [{ changed: 'a' }, { changed: 'b' }] };
  assert.deepEqual(replaceAt(tree, [1], { changed: 'c' }), { and: [{ changed: 'a' }, { changed: 'c' }] });

  const negated = toggleNot(tree, [0]);
  assert.deepEqual(negated, { and: [{ not: { changed: 'a' } }, { changed: 'b' }] });
  assert.deepEqual(toggleNot(negated, [0]), tree, 'toggling twice restores it');

  assert.deepEqual(setGroupOp(tree, [], 'or'), { or: [{ changed: 'a' }, { changed: 'b' }] });
});

test('typed comparison values mean what they look like', () => {
  assert.equal(parseLiteral('500000'), 500000);
  assert.equal(parseLiteral('paystub'), 'paystub');
  assert.deepEqual(parseLiteral('["paystub","W2"]'), ['paystub', 'W2']);
  assert.equal(parseLiteral('true'), true);
  assert.equal(parseLiteral('"620"'), '620', 'quotes force a string');

  // Round trip: what the field shows parses back to the same value, including mid-typing text.
  for (const value of [500000, 'paystub', ['paystub', 'W2'], true, '620', '["a",', '']) {
    assert.deepEqual(parseLiteral(literalToText(value)), value);
  }
  assert.deepEqual(comparisonParts({ in: ['payload.type', ['paystub']] }), {
    op: 'in',
    ref: 'payload.type',
    value: ['paystub'],
  });
});

test('validateCondition catches what the engine would only reveal at event time', () => {
  assert.deepEqual(validateCondition({ and: [{ changed: 'amount' }, gt('payload.amount', 500000)] }), []);
  assert.deepEqual(validateCondition({ in: ['payload.type', ['paystub', 'W2']] }), []);
  assert.deepEqual(validateCondition(gt('state.application_stage_rank', 3)), []);

  const messages = (c: Condition): string[] => validateCondition(c).map((i) => i.message);
  assert.match(messages(gt('amount', 1))[0]!, /must start with/);
  assert.match(messages(gt('state.made_up', 1))[0]!, /Unknown state value/);
  assert.match(messages({ in: ['payload.type', 'paystub'] })[0]!, /needs a list/);
  assert.match(messages(gt('payload.amount', 'lots'))[0]!, /compares numbers/);
  assert.match(messages({ and: [] })[0]!, /at least one condition/);
  assert.match(messages({ changed: ' ' })[0]!, /Name the field/);
  assert.match(messages({ state: 'made_up' })[0]!, /Unknown state check/);

  // Nested problems are found, and each carries its node's path.
  const nested = validateCondition({ and: [{ changed: 'a' }, { or: [gt('nope', 1)] }] });
  assert.equal(nested[0]!.field, 'condition.1.0');
});

test('validateDraft includes condition problems and a fractional priority', () => {
  const issues = validateDraft(
    draft({
      condition: { and: [] },
      action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'T', priority: 1.5 },
    }),
  );
  assert.deepEqual(issues.map((i) => i.field).sort(), ['action.priority', 'condition.']);
});

test('a stored rule is described in plain words and loads as a draft', () => {
  assert.equal(describeTrigger({ type: 'event', event: 'application.submitted' }), 'when application.submitted');
  assert.equal(
    describeTrigger({ type: 'schedule', cron: '0 2 * * *', scan: 'stale_documents_at_underwriting' }),
    'on schedule 0 2 * * *, for each stale_documents_at_underwriting',
  );
  assert.equal(
    describeAction({ kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Senior review', priority: 5 }),
    'create "Senior review" in underwriting, SLA 24h, priority 5',
  );
  assert.equal(describeAction({ kind: 'cancel_tasks', scope: 'application' }), 'cancel open tasks for the application');

  const stored = {
    ruleKey: 'R2',
    version: 3,
    trigger: { type: 'event', event: 'application.submitted' },
    condition: null,
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Senior review' },
    active: true,
    createdAt: '',
  };
  assert.deepEqual(draftFromVersion(stored), {
    ruleKey: 'R2',
    trigger: stored.trigger,
    condition: null,
    action: stored.action,
  });
});

test('rule keys sort by number', () => {
  assert.deepEqual(sortRuleKeys(['R10', 'R2', 'R1', 'R11']), ['R1', 'R2', 'R10', 'R11']);
});
